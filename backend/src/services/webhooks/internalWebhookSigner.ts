import crypto from "crypto";
import { type IRedisCacheClient } from "../../config/redis.js";

/**
 * Interface representing the required headers for inter-service internal webhooks.
 */
export interface InternalWebhookHeaders {
  "X-Fantasy-Signature": string;
  "X-Fantasy-Timestamp": string;
  "X-Fantasy-Nonce": string;
}

export interface InternalWebhookSecretConfig {
  primarySecret: string;
  secondarySecret?: string;
}

export interface SignInternalWebhookOptions {
  timestamp?: number;
  nonce?: string;
}

export interface InternalWebhookVerificationResult {
  valid: boolean;
  status: 200 | 401 | 409;
  error?: string;
  usedSecret?: "primary" | "secondary";
}

/**
 * In-memory fallback nonce store for testing or when Redis is offline.
 */
class InMemoryNonceStore {
  private nonces = new Map<string, number>();

  public checkAndSet(nonce: string, ttlMs: number): boolean {
    const now = Date.now();
    // Clean expired nonces occasionally
    if (this.nonces.size > 5000) {
      for (const [k, exp] of this.nonces.entries()) {
        if (exp <= now) this.nonces.delete(k);
      }
    }

    const exp = this.nonces.get(nonce);
    if (exp !== undefined && exp > now) {
      return false; // Replay detected
    }

    this.nonces.set(nonce, now + ttlMs);
    return true; // Fresh nonce recorded
  }

  public clear(): void {
    this.nonces.clear();
  }
}

export const inMemoryNonceStore = new InMemoryNonceStore();

/**
 * Normalizes payload into a string for canonical signing.
 */
export function canonicalizeWebhookPayload(payload: string | Record<string, unknown> | unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload);
}

/**
 * Signs an internal webhook payload using HMAC-SHA256 with timestamp and nonce.
 */
export function signInternalWebhook(
  payload: string | Record<string, unknown> | unknown,
  secret: string,
  options: SignInternalWebhookOptions = {}
): {
  signature: string;
  timestamp: number;
  nonce: string;
  headers: InternalWebhookHeaders;
} {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? crypto.randomUUID();
  const payloadString = canonicalizeWebhookPayload(payload);

  const message = `${timestamp}.${nonce}.${payloadString}`;
  const signature = crypto.createHmac("sha256", secret).update(message).digest("hex");

  return {
    signature,
    timestamp,
    nonce,
    headers: {
      "X-Fantasy-Signature": signature,
      "X-Fantasy-Timestamp": String(timestamp),
      "X-Fantasy-Nonce": nonce,
    },
  };
}

/**
 * Verifies the HMAC-SHA256 signature using timingSafeEqual, checking primary and secondary secrets.
 */
export function verifySignatureOnly(
  payloadString: string,
  signature: string,
  timestamp: number | string,
  nonce: string,
  secrets: string | string[] | InternalWebhookSecretConfig
): { valid: boolean; usedSecret?: "primary" | "secondary" } {
  // Normalize secrets list
  let secretList: { secret: string; type: "primary" | "secondary" }[] = [];
  if (typeof secrets === "string") {
    secretList = [{ secret: secrets, type: "primary" }];
  } else if (Array.isArray(secrets)) {
    secretList = secrets.map((s, idx) => ({
      secret: s,
      type: idx === 0 ? "primary" : "secondary",
    }));
  } else if (secrets && typeof secrets === "object") {
    if (secrets.primarySecret) {
      secretList.push({ secret: secrets.primarySecret, type: "primary" });
    }
    if (secrets.secondarySecret) {
      secretList.push({ secret: secrets.secondarySecret, type: "secondary" });
    }
  }

  // Strip optional prefix like "sha256=" or "v1="
  let cleanSignature = signature;
  if (cleanSignature.startsWith("sha256=")) {
    cleanSignature = cleanSignature.substring(7);
  } else if (cleanSignature.startsWith("v1=")) {
    cleanSignature = cleanSignature.substring(3);
  }

  const message = `${timestamp}.${nonce}.${payloadString}`;

  for (const { secret, type } of secretList) {
    if (!secret) continue;
    const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
    try {
      if (
        cleanSignature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(cleanSignature, "hex"), Buffer.from(expected, "hex"))
      ) {
        return { valid: true, usedSecret: type };
      }
    } catch {
      // Hex parsing error or length mismatch
    }
  }

  return { valid: false };
}

export interface VerifyInternalWebhookOptions {
  toleranceSeconds?: number;
  redisClient?: IRedisCacheClient | null;
  currentTimeMs?: number;
}

/**
 * Complete verification pipeline:
 * 1. Checks timestamp against drift window (default 300s). Returns 401 if exceeded.
 * 2. Checks nonce replay protection using Redis or in-memory fallback. Returns 409 if replayed.
 * 3. Verifies HMAC signature with dual active secret support. Returns 401 if mismatch.
 */
export async function verifyInternalWebhook(
  payload: string | Record<string, unknown> | unknown,
  headers: {
    signature?: string;
    timestamp?: string | number;
    nonce?: string;
  },
  secrets: string | string[] | InternalWebhookSecretConfig,
  options: VerifyInternalWebhookOptions = {}
): Promise<InternalWebhookVerificationResult> {
  const { signature, timestamp, nonce } = headers;

  if (!signature || timestamp === undefined || timestamp === null || !nonce) {
    return {
      valid: false,
      status: 401,
      error: "Missing required authentication headers (X-Fantasy-Signature, X-Fantasy-Timestamp, X-Fantasy-Nonce)",
    };
  }

  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const nowMs = options.currentTimeMs ?? Date.now();

  // Parse timestamp (support both epoch seconds and epoch milliseconds)
  const numTimestamp = typeof timestamp === "number" ? timestamp : parseInt(String(timestamp), 10);
  if (isNaN(numTimestamp)) {
    return {
      valid: false,
      status: 401,
      error: "Invalid X-Fantasy-Timestamp header format",
    };
  }

  const timestampMs = numTimestamp < 10000000000 ? numTimestamp * 1000 : numTimestamp;
  const driftMs = Math.abs(nowMs - timestampMs);

  if (driftMs > toleranceSeconds * 1000) {
    return {
      valid: false,
      status: 401,
      error: `Webhook timestamp expired or clock drift exceeds ${toleranceSeconds} seconds`,
    };
  }

  // Replay defense check
  const redis = options.redisClient;
  const nonceKey = `fantasy:webhook:nonce:${nonce}`;
  let nonceAccepted = false;

  if (redis) {
    try {
      // Use Redis atomic SET NX with EX ttl
      const setResult = await redis.set(nonceKey, "1", "EX", toleranceSeconds, "NX" as any);
      // ioredis returns "OK" when set, or null if key already existed
      if (setResult === "OK" || setResult === true || setResult === 1) {
        nonceAccepted = true;
      } else {
        nonceAccepted = false;
      }
    } catch {
      // Graceful fallback to memory store if Redis query errors
      nonceAccepted = inMemoryNonceStore.checkAndSet(nonce, toleranceSeconds * 1000);
    }
  } else {
    nonceAccepted = inMemoryNonceStore.checkAndSet(nonce, toleranceSeconds * 1000);
  }

  if (!nonceAccepted) {
    return {
      valid: false,
      status: 409,
      error: "Replay defense triggered: Nonce has already been consumed within tolerance window",
    };
  }

  // Cryptographic signature check
  const payloadString = canonicalizeWebhookPayload(payload);
  const sigResult = verifySignatureOnly(payloadString, signature, timestamp, nonce, secrets);

  if (!sigResult.valid) {
    return {
      valid: false,
      status: 401,
      error: "Cryptographic signature mismatch",
    };
  }

  return {
    valid: true,
    status: 200,
    usedSecret: sigResult.usedSecret,
  };
}
