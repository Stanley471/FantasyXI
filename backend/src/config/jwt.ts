import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

/**
 * Centralized JWT Authentication Configuration.
 *
 * Laravel equivalent: config/sanctum.php or config/jwt.php.
 */

const FALLBACK_DEV_SECRET = "fantasyxi-dev-insecure-fallback-secret-at-least-32-chars-long";

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    if (!secret || secret === "CHANGE_ME_TO_A_RANDOM_SECRET" || secret.length < 32) {
      throw new Error(
        "FATAL: In production, JWT_SECRET must be set to a secure string with at least 32 characters."
      );
    }
    return secret;
  }

  return secret && secret.trim().length > 0 ? secret : FALLBACK_DEV_SECRET;
}

export function getJwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || "7d";
}

export interface JwtPayload {
  userId: string;
  email?: string;
  username?: string;
  role?: string;
  [key: string]: unknown;
}

/**
 * Signs a minimal JWT payload.
 */
export function signAccessToken(payload: JwtPayload): string {
  const secret = getJwtSecret();
  const expiresIn = getJwtExpiresIn();

  return jwt.sign(payload, secret, {
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
  });
}

/**
 * Verifies a JWT and returns the decoded payload.
 * Throws JsonWebTokenError or TokenExpiredError if invalid.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const secret = getJwtSecret();
  const decoded = jwt.verify(token, secret);
  // Single-purpose tickets (e.g. a pending passkey step-up) are never access tokens
  if (typeof decoded === "object" && decoded !== null && "purpose" in decoded) {
    throw new jwt.JsonWebTokenError("Token is not an access token");
  }
  return decoded as JwtPayload;
}

/** Short-lived token that only authorizes one follow-up step, such as passkey MFA. */
export function signPurposeToken(subject: string, purpose: string, expiresIn: string): string {
  return jwt.sign({ purpose }, getJwtSecret(), {
    subject,
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
    audience: `fantasyxi:${purpose}`,
  });
}

/** Returns the subject of a valid token issued for `purpose`, or null. */
export function verifyPurposeToken(token: unknown, purpose: string): string | null {
  if (typeof token !== "string" || token.length === 0) return null;
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { audience: `fantasyxi:${purpose}` });
    if (typeof decoded !== "object" || decoded === null || decoded.purpose !== purpose) return null;
    return typeof decoded.sub === "string" ? decoded.sub : null;
  } catch {
    return null;
  }
}
