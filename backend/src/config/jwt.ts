import crypto from "crypto";
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
  jti?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

/**
 * Signs a JWT payload with a unique `jti` (JWT ID) claim for session tracking
 * and token revocation.
 */
export function signAccessToken(payload: JwtPayload): string {
  const secret = getJwtSecret();
  const expiresIn = getJwtExpiresIn();
  const jti =
    typeof payload.jti === "string" && payload.jti.trim().length > 0
      ? payload.jti
      : crypto.randomUUID();

  return jwt.sign({ ...payload, jti }, secret, {
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
  return decoded as JwtPayload;
}

/**
 * Calculates the remaining lifetime (in seconds) before a token expires,
 * used as the Redis TTL for blacklisted `jti` entries.
 */
export function getTokenRemainingTtlSeconds(
  tokenOrPayload: string | JwtPayload,
  nowMs: number = Date.now()
): number {
  const payload =
    typeof tokenOrPayload === "string"
      ? (jwt.decode(tokenOrPayload) as JwtPayload | null)
      : tokenOrPayload;

  if (!payload || typeof payload.exp !== "number") {
    return 7 * 24 * 60 * 60;
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  return Math.max(0, payload.exp - nowSeconds);
}
