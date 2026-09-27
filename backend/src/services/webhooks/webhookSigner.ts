import crypto from "crypto";

/**
 * Webhook HMAC Signer and Verifier
 * Generates and validates SHA-256 HMAC signatures for webhook payload integrity.
 */

export interface WebhookSignatureResult {
  signature: string;
  timestamp: number;
  header: string;
}

/**
 * Generates an HMAC SHA-256 signature header for a given payload and secret.
 * Format: t=<timestamp>,v1=<hex_signature>
 */
export function generateWebhookSignature(
  payload: string | Record<string, unknown>,
  secret: string,
  timestamp: number = Date.now()
): WebhookSignatureResult {
  const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signaturePayload = `${timestamp}.${payloadString}`;
  
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signaturePayload);
  const signature = hmac.digest("hex");
  const header = `t=${timestamp},v1=${signature}`;

  return { signature, timestamp, header };
}

/**
 * Verifies that a webhook request header matches the expected HMAC signature.
 * Prevents replay attacks using an optional tolerance window (default 5 minutes).
 */
export function verifyWebhookSignature(
  payload: string | Record<string, unknown>,
  signatureHeader: string,
  secret: string,
  toleranceMs: number = 5 * 60 * 1000
): { valid: boolean; reason?: string } {
  if (!signatureHeader) {
    return { valid: false, reason: "Missing signature header" };
  }

  const parts = signatureHeader.split(",");
  let timestampStr: string | undefined;
  let signature: string | undefined;

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") timestampStr = value;
    if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) {
    return { valid: false, reason: "Malformed signature header" };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    return { valid: false, reason: "Invalid timestamp in signature header" };
  }

  if (toleranceMs > 0 && Math.abs(Date.now() - timestamp) > toleranceMs) {
    return { valid: false, reason: "Webhook timestamp expired (replay protection)" };
  }

  const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signaturePayload = `${timestamp}.${payloadString}`;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signaturePayload);
  const expectedSignature = hmac.digest("hex");

  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSignature, "hex")
    );
    return valid ? { valid: true } : { valid: false, reason: "Signature mismatch" };
  } catch {
    return { valid: false, reason: "Signature comparison failed" };
  }
}
