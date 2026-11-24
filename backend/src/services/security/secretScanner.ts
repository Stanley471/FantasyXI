/**
 * Secret-pattern scanner (issue #456).
 *
 * Deterministic regex detectors for the secret formats that must never reach
 * a log line, an API response, or an error trace. The pattern list lives in
 * this one module so new formats can be added without touching callers.
 *
 * Two guarantees:
 * - Nothing this module returns ever contains raw secret material. A
 *   detection carries a SHA-256 fingerprint of the matched value (plus its
 *   length and location), never the value itself.
 * - Detection is purely structural (regex + a checksum check for Stellar
 *   keys). It never talks to the network or a database, so it is safe to run
 *   on the hot logging path.
 *
 * Formats covered:
 * - Stellar secret keys (`S` + 55 base32 chars). A match is `verified` only
 *   when the trailing CRC16 checksum is valid for the decoded payload, so a
 *   random `S...` string is still redacted but never triggers rotation.
 * - Private keys: PEM blocks (`PRIVATE KEY`, incl. RSA/EC/OPENSSH/ENCRYPTED)
 *   and bare `0x` + 64 hex chars (e.g. an Ethereum-style private key).
 *   Certificates (`BEGIN CERTIFICATE`) are public by design and are NOT
 *   flagged.
 * - JWTs: three base64url segments whose first two decode to JSON
 *   (`eyJ...` prefix). Random three-segment base64 is not flagged.
 * - Database credentials: connection strings with `user:password@host`
 *   (postgres/mysql/mongodb/redis) and `password = ...` assignments.
 * - API keys: well-known prefixes (`sk_live_`, `sk-`, `ghp_`, `AKIA`,
 *   `xox[baprs]-`) and `api_key = ...` / `access_token = ...` assignments.
 * - Sensitive field names: any object key that names a credential
 *   (`password`, `secret`, `apiKey`, `accessToken`, `authorization`, ...)
 *   has its value replaced wholesale, whatever the value looks like.
 */

import crypto from "crypto";

export const REDACTED_SECRET = "[REDACTED_SECRET]";

export type SecretPatternType =
  | "stellar-secret-key"
  | "private-key"
  | "jwt"
  | "database-credentials"
  | "api-key"
  | "sensitive-field";

export interface SecretDetection {
  /** Which pattern matched. */
  type: SecretPatternType;
  /** SHA-256 hex of the matched value. Never the value itself. */
  fingerprint: string;
  /** Length of the matched value, in characters. */
  length: number;
  /**
   * True when the match is structurally a real secret of this format
   * (valid Stellar checksum, complete PEM block, decodable JWT, ...).
   * Unverified matches are still redacted; only verified ones may trip the
   * quarantine rotation hook.
   */
  verified: boolean;
  /** Where the secret was found, e.g. `$.err.stack` or `log:info[0].msg`. */
  location: string;
  /** Character offset inside the scanned string, when applicable. */
  offset?: number;
}

export function fingerprintOf(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* Stellar secret-key checksum (StrKey)                                */
/* ------------------------------------------------------------------ */

/** CRC16-XModem (poly 0x1021, init 0x0000), as used by Stellar StrKeys. */
function crc16XModem(data: Buffer): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes unpadded RFC 4648 base32. Returns null on invalid input. */
function base32Decode(input: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
      // Drop the consumed bits so `value` never grows past a few bits.
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/**
 * True when `value` is a structurally valid Stellar secret seed: `S` + 55
 * base32 chars. The `S` is itself the first base32 character — the version
 * byte's top bits — so the whole 56-character string decodes to 35 bytes:
 * version byte 0x90 (seed), 32-byte key, and a trailing two-byte
 * little-endian CRC16 of the preceding 33 bytes.
 */
export function isValidStellarSecretKey(value: string): boolean {
  if (!/^S[A-Z2-7]{55}$/.test(value)) return false;
  const decoded = base32Decode(value);
  if (!decoded || decoded.length !== 35) return false;
  if (decoded[0] !== 0x90) return false;
  const expected = crc16XModem(decoded.subarray(0, 33));
  const actual = decoded[33] | (decoded[34] << 8);
  return expected === actual;
}

/* ------------------------------------------------------------------ */
/* JWT structure check                                                 */
/* ------------------------------------------------------------------ */

function base64UrlDecode(segment: string): string | null {
  try {
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** True when the token's header and payload segments decode to JSON objects. */
export function isValidJwtStructure(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  for (const segment of parts.slice(0, 2)) {
    const decoded = base64UrlDecode(segment);
    if (!decoded) return false;
    try {
      const parsed: unknown = JSON.parse(decoded);
      if (typeof parsed !== "object" || parsed === null) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

interface SecretPattern {
  type: SecretPatternType;
  /** Global regex. Group 1, when present, is the part to keep (e.g. `key=`). */
  regex: RegExp;
  /** Builds the replacement for one match. */
  replace: (match: string, groups: RegExpExecArray) => string;
  /** Extra structural check; a match that fails it is still redacted. */
  verify?: (match: string, groups: RegExpExecArray) => boolean;
}

const PLACEHOLDER_VALUE = /^(null|undefined|none|\*+|xxx+|\[redacted[^\]]*\])$/i;

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: "stellar-secret-key",
    regex: /\bS[A-Z2-7]{55}\b/g,
    replace: () => REDACTED_SECRET,
    verify: (match) => isValidStellarSecretKey(match),
  },
  {
    type: "private-key",
    // PEM private-key block (RSA / EC / OPENSSH / ENCRYPTED / plain).
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => REDACTED_SECRET,
    verify: () => true,
  },
  {
    type: "private-key",
    // Bare 0x-prefixed 64-hex-char key (e.g. an Ethereum private key).
    regex: /\b0x[0-9a-fA-F]{64}\b/g,
    replace: () => REDACTED_SECRET,
    verify: () => true,
  },
  {
    type: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => REDACTED_SECRET,
    verify: (match) => isValidJwtStructure(match),
  },
  {
    type: "database-credentials",
    // Connection string with embedded credentials: scheme://user:pass@host
    // (the username may be empty, as in `redis://:pass@host`).
    regex: /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?):\/\/[^\s:@/]*:)[^\s@/]+(@[^\s/]+)/g,
    replace: (_match, groups) => `${groups[1]}${REDACTED_SECRET}${groups[2]}`,
    verify: () => true,
  },
  {
    type: "database-credentials",
    // password = "..." / password: '...' / db_password=... assignments.
    regex: /\b((?:password|passwd|pwd|db[_-]?pass(?:word)?)\s*[:=]\s*)(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([^\s'",;}\]]{6,}))/gi,
    replace: (_match, groups) => `${groups[1]}${REDACTED_SECRET}`,
    verify: (_match, groups) => {
      const value = groups[2] ?? groups[3] ?? groups[4] ?? "";
      return !PLACEHOLDER_VALUE.test(value);
    },
  },
  {
    type: "api-key",
    regex: /\b(?:sk_(?:live|test)[_-][A-Za-z0-9]{8,}|sk-proj-[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
    replace: () => REDACTED_SECRET,
    verify: () => true,
  },
  {
    type: "api-key",
    regex: /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|secret)\s*[:=]\s*)(?:"([^"\n]{8,})"|'([^'\n]{8,})'|([^\s'",;}\]]{8,}))/gi,
    replace: (_match, groups) => `${groups[1]}${REDACTED_SECRET}`,
    verify: (_match, groups) => {
      const value = groups[2] ?? groups[3] ?? groups[4] ?? "";
      return !PLACEHOLDER_VALUE.test(value);
    },
  },
];

/** One combined test for the fast path: does this string contain anything? */
const ANY_SECRET_TEST = new RegExp(
  SECRET_PATTERNS.map((pattern) => pattern.regex.source).join("|"),
  "gi"
);

/* ------------------------------------------------------------------ */
/* Text scanning / redaction                                           */
/* ------------------------------------------------------------------ */

export interface RedactTextResult {
  text: string;
  detections: SecretDetection[];
}

/**
 * Scans one string, returning the redacted text plus one detection per
 * match. The replacement keeps any non-secret context the pattern captured
 * (e.g. `password=` or the `user@host` of a connection string).
 */
export function redactTextWithDetections(text: string, location: string): RedactTextResult {
  if (!ANY_SECRET_TEST.test(text)) return { text, detections: [] };
  // `test` on a global regex advances lastIndex; reset before re-scanning.
  ANY_SECRET_TEST.lastIndex = 0;

  const detections: SecretDetection[] = [];
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    redacted = redacted.replace(pattern.regex, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args as unknown as RegExpExecArray;
      const offset = args[args.length - 2] as number;
      detections.push({
        type: pattern.type,
        fingerprint: fingerprintOf(match),
        length: match.length,
        verified: pattern.verify ? pattern.verify(match, groups) : true,
        location,
        offset,
      });
      return pattern.replace(match, groups);
    });
  }
  return { text: redacted, detections };
}

/** Redacts every secret pattern in `text` to `[REDACTED_SECRET]`. */
export function redactText(text: string): string {
  return redactTextWithDetections(text, "$").text;
}

/**
 * Extracts the raw JWTs found in `text`. This is the one place raw secret
 * material is deliberately returned: the caller is the quarantine tripwire,
 * which needs the token's `kid` header to revoke the signing key. The
 * returned tokens must live only in local scope, be passed to the rotation
 * service, and never be logged, stored, or included in an audit entry.
 */
export function extractJwtTokens(text: string): string[] {
  const jwtPattern = SECRET_PATTERNS.find((pattern) => pattern.type === "jwt");
  if (!jwtPattern) return [];
  jwtPattern.regex.lastIndex = 0;
  return [...text.matchAll(jwtPattern.regex)].map((match) => match[0]);
}

/** True when `text` contains at least one secret pattern. */
export function textContainsSecret(text: string): boolean {
  const found = ANY_SECRET_TEST.test(text);
  ANY_SECRET_TEST.lastIndex = 0;
  return found;
}

/* ------------------------------------------------------------------ */
/* Deep scan / redaction of arbitrary values                           */
/* ------------------------------------------------------------------ */

/**
 * Object keys whose value is a credential whatever it looks like. Mirrors
 * the key list in config/tracing.ts (sanitizeSpanAttributes) and extends it
 * to the credential names this service sees in logs and payloads.
 */
export function isSensitiveFieldName(key: string): boolean {
  const lower = key.toLowerCase();
  if (/(password|passwd|pwd|secret|credential|api[_-]?key|private[_-]?key|client[_-]?secret)/.test(lower)) return true;
  if (lower === "token" || lower === "authorization" || lower === "cookie") return true;
  if (lower.endsWith("token")) return true;
  if (lower.includes("access_token") || lower.includes("accesstoken")) return true;
  if (lower.includes("auth_token") || lower.includes("authtoken")) return true;
  return false;
}

const MAX_DEPTH = 20;

export interface SanitizeValueResult {
  value: unknown;
  detections: SecretDetection[];
}

/**
 * Deep-copies `value`, redacting every secret found (pattern matches inside
 * strings, and whole values under sensitive field names), and returns the
 * copy plus the detections. Never mutates the input; circular references
 * become the string `"[Circular]"`. Buffers, Dates and RegExps pass through
 * untouched (a Buffer's bytes are not scanned: callers holding raw key
 * material in a Buffer must redact it before logging).
 */
export function sanitizeValue(value: unknown, location = "$", depth = 0): SanitizeValueResult {
  return sanitizeValueInner(value, location, depth, new WeakSet());
}

function sanitizeValueInner(
  value: unknown,
  location: string,
  depth: number,
  seen: WeakSet<object>
): SanitizeValueResult {
  if (typeof value === "string") {
    const { text, detections } = redactTextWithDetections(value, location);
    return { value: text, detections };
  }

  if (value instanceof Error) {
    const result = sanitizeValueInner(
      { name: value.name, message: value.message, stack: value.stack },
      location,
      depth,
      seen
    );
    return result;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return { value: "[Circular]", detections: [] };
    if (depth >= MAX_DEPTH) return { value: "[MaxDepth]", detections: [] };
    seen.add(value);
    const detections: SecretDetection[] = [];
    const out: unknown[] = value.map((item, index) => {
      const itemResult = sanitizeValueInner(item, `${location}[${index}]`, depth + 1, seen);
      detections.push(...itemResult.detections);
      return itemResult.value;
    });
    seen.delete(value);
    return { value: out, detections };
  }

  if (typeof value === "object" && value !== null) {
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      Buffer.isBuffer(value) ||
      value instanceof Uint8Array
    ) {
      return { value, detections: [] };
    }
    if (seen.has(value)) return { value: "[Circular]", detections: [] };
    if (depth >= MAX_DEPTH) return { value: "[MaxDepth]", detections: [] };
    seen.add(value);
    const detections: SecretDetection[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const fieldLocation = `${location}.${key}`;
      if (isSensitiveFieldName(key)) {
        const raw = typeof entry === "string" ? entry : JSON.stringify(entry) ?? "";
        if (raw.length > 0 && raw !== REDACTED_SECRET) {
          detections.push({
            type: "sensitive-field",
            fingerprint: fingerprintOf(raw),
            length: raw.length,
            verified: true,
            location: fieldLocation,
          });
        }
        out[key] = REDACTED_SECRET;
        continue;
      }
      const itemResult = sanitizeValueInner(entry, fieldLocation, depth + 1, seen);
      detections.push(...itemResult.detections);
      out[key] = itemResult.value;
    }
    seen.delete(value);
    return { value: out, detections };
  }

  return { value, detections: [] };
}

/** All secret detections inside `value` (strings, nested objects, errors). */
export function scanValue(value: unknown, location = "$"): SecretDetection[] {
  return sanitizeValue(value, location).detections;
}

/** Deep-copies `value` with every secret redacted. */
export function redactValue(value: unknown): unknown {
  return sanitizeValue(value).value;
}

/** True when `value` contains at least one secret pattern. */
export function valueContainsSecret(value: unknown): boolean {
  return scanValue(value).length > 0;
}

/**
 * Sanitizer for API responses and error payloads: the same deep redaction
 * as the log path, so a secret can never leak through a response body
 * either. Preserves the response shape; only secret material is replaced.
 */
export function sanitizeForResponse<T>(value: T): T {
  return redactValue(value) as T;
}
