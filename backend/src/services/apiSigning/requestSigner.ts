import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 request signing for public API endpoints (issue #455).
 *
 * Partners sign each request with a secret API key. The server recomputes the
 * signature over a canonical string and compares it in constant time, rejects
 * timestamps outside a 300 second clock-skew window, and consumes each nonce
 * exactly once (see `nonceStore.ts` / `middleware/requestSigning.ts`).
 *
 * Canonical string (newline-joined, no trailing newline):
 *
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
 *
 * - METHOD is upper-cased (e.g. `GET`).
 * - PATH is the request path including its query string, e.g.
 *   `/api/v1/players?page=2`. Query strings are covered so tampering with
 *   them breaks the signature.
 * - TIMESTAMP is the exact `X-Timestamp` header value (epoch seconds, or
 *   epoch milliseconds — both are accepted when verifying).
 * - NONCE is the exact `X-Nonce` header value.
 * - BODY_HASH is the lowercase hex SHA-256 of the request body bytes. An
 *   absent body (or an empty JSON object `{}` as parsed by `express.json()`)
 *   hashes as the empty string. A parsed JSON object body is hashed from its
 *   stable (key-sorted) serialization, so clients and server agree even when
 *   key order differs; a raw string body is hashed byte-exact.
 *
 * This module is pure (no I/O, no Redis): the middleware owns timestamp /
 * nonce enforcement, and the SDK in `src/sdk/apiSigning.ts` reuses these
 * helpers so partners sign exactly what the server verifies.
 */

/** Maximum clock skew between client and server, in seconds (issue #455). */
export const API_SIGNING_TOLERANCE_SECONDS = 300;

/** `X-Signature` / `X-Timestamp` / `X-Nonce` header names. */
export const API_SIGNING_HEADERS = {
  signature: "X-Signature",
  timestamp: "X-Timestamp",
  nonce: "X-Nonce",
} as const;

/** Nonces must be 1-128 chars of letters, digits, `-` or `_`. */
export const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_]{0,127}$/;

/** JSON with object keys sorted, so semantically identical bodies hash identically. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v ?? null)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Canonical body bytes for hashing. Accepts a raw string / Buffer (hashed
 * byte-exact), a parsed JSON value (stable-serialized), or nothing (empty).
 */
export function canonicalBodyString(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  const serialized = stableStringify(body);
  // express.json() parses an absent body as `{}`; treat it as "no body" so a
  // GET signed with no body verifies against a parsed empty object.
  return serialized === "{}" ? "" : serialized;
}

/** Lowercase hex SHA-256 of `body` (empty string when there is no body). */
export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalBodyString(body)).digest("hex");
}

export interface CanonicalRequestInput {
  method: string;
  /** Request path including query string, e.g. `/api/v1/players?page=2`. */
  path: string;
  /** Exact timestamp header value (epoch seconds or milliseconds). */
  timestamp: string | number;
  /** Exact nonce header value. */
  nonce: string;
  /** Raw body string/Buffer, parsed JSON body, or undefined for no body. */
  body?: unknown;
}

/** Builds the canonical string a signature covers. */
export function canonicalRequestString(input: CanonicalRequestInput): string {
  const method = input.method.toUpperCase();
  const timestamp = String(input.timestamp);
  const bodyHash = hashRequestBody(input.body);
  return `${method}\n${input.path}\n${timestamp}\n${input.nonce}\n${bodyHash}`;
}

/** HMAC-SHA256 hex signature for a canonical string and secret. */
export function computeSignature(secret: string, canonicalString: string): string {
  return createHmac("sha256", secret).update(canonicalString).digest("hex");
}

/** Signs a request. Timestamp defaults to now (epoch seconds); nonce to a UUID. */
export function signRequest(input: {
  method: string;
  path: string;
  body?: unknown;
  secret: string;
  timestamp?: string | number;
  nonce?: string;
}): { signature: string; timestamp: string; nonce: string; canonicalString: string } {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomUUID();
  const canonicalString = canonicalRequestString({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    body: input.body,
  });
  return { signature: computeSignature(input.secret, canonicalString), timestamp, nonce, canonicalString };
}

/** Parses an `X-Timestamp` header into epoch milliseconds, or null when malformed. */
export function parseTimestampMs(timestamp: string | number): number | null {
  const raw = typeof timestamp === "number" ? timestamp : timestamp.trim();
  if (typeof raw === "string" && !/^-?\d+$/.test(raw)) return null;
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  // Epoch seconds (< 1e10) vs epoch milliseconds, mirroring internal webhooks.
  return value < 10_000_000_000 ? value * 1000 : value;
}

export type ApiSecretConfig = string | string[] | { primarySecret: string; secondarySecret?: string };

/** Normalizes the supported secret shapes into a primary/secondary list (for rotation). */
export function normalizeSecrets(
  secrets: ApiSecretConfig
): { secret: string; label: "primary" | "secondary" }[] {
  if (typeof secrets === "string") return [{ secret: secrets, label: "primary" }];
  if (Array.isArray(secrets)) {
    return secrets
      .filter((secret) => secret.length > 0)
      .map((secret, index) => ({ secret, label: index === 0 ? "primary" : "secondary" }));
  }
  const list: { secret: string; label: "primary" | "secondary" }[] = [];
  if (secrets.primarySecret) list.push({ secret: secrets.primarySecret, label: "primary" });
  if (secrets.secondarySecret) list.push({ secret: secrets.secondarySecret, label: "secondary" });
  return list;
}

/**
 * Constant-time comparison of a supplied signature against the expected hex
 * digest. Accepts an optional `sha256=` prefix. Returns false (never throws)
 * for malformed, non-hex, or wrong-length input.
 */
export function signaturesEqual(supplied: string, expectedHex: string): boolean {
  let clean = supplied.trim();
  if (clean.toLowerCase().startsWith("sha256=")) clean = clean.slice("sha256=".length);
  if (clean.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(clean, "hex"), Buffer.from(expectedHex, "hex"));
  } catch {
    return false;
  }
}

export interface VerifySignatureInput {
  method: string;
  path: string;
  timestamp: string | number;
  nonce: string;
  body?: unknown;
  signature: string;
  secrets: ApiSecretConfig;
  toleranceSeconds?: number;
  /** Epoch milliseconds; defaults to Date.now(). Injectable for tests. */
  nowMs?: number;
}

export type VerifySignatureResult =
  | { valid: true; usedSecret: "primary" | "secondary" }
  | { valid: false; reason: string };

/**
 * Verifies an HMAC-SHA256 request signature: timestamp inside the skew
 * window, then a constant-time signature comparison against each configured
 * secret. Does NOT check nonce replay — the middleware claims the nonce only
 * after this passes, so a bad signature can never burn a victim's nonce.
 */
export function verifyApiRequestSignature(input: VerifySignatureInput): VerifySignatureResult {
  const toleranceSeconds = input.toleranceSeconds ?? API_SIGNING_TOLERANCE_SECONDS;
  const nowMs = input.nowMs ?? Date.now();

  const timestampMs = parseTimestampMs(input.timestamp);
  if (timestampMs === null) {
    return { valid: false, reason: "Invalid X-Timestamp header format" };
  }
  if (Math.abs(nowMs - timestampMs) > toleranceSeconds * 1000) {
    return {
      valid: false,
      reason: `Request timestamp deviates by more than ${toleranceSeconds} seconds from server clock`,
    };
  }

  if (!NONCE_PATTERN.test(input.nonce)) {
    return { valid: false, reason: "Invalid X-Nonce header format" };
  }

  const canonicalString = canonicalRequestString({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    body: input.body,
  });

  for (const { secret, label } of normalizeSecrets(input.secrets)) {
    if (signaturesEqual(input.signature, computeSignature(secret, canonicalString))) {
      return { valid: true, usedSecret: label };
    }
  }
  return { valid: false, reason: "Signature mismatch" };
}
