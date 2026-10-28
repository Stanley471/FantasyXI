import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { JwtKeyRing } from "../services/auth/jwtKeyRing.js";

dotenv.config();

/**
 * Centralized JWT Authentication Configuration.
 *
 * Access tokens are signed with rotating ES256 keys (issue #332, see
 * services/auth/jwtKeyRing.ts and jwtKeyRotationService.ts). JWT_SECRET is no
 * longer a signing key: it encrypts the stored private keys and verifies
 * legacy HS256 tokens until JWT_LEGACY_HS256_UNTIL.
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

/** Lifetime of a newly issued access token in seconds, parsed exactly as jsonwebtoken parses JWT_EXPIRES_IN. */
export function getJwtLifetimeSeconds(): number {
  const probe = jwt.decode(
    jwt.sign({}, "lifetime-probe", { expiresIn: getJwtExpiresIn() as jwt.SignOptions["expiresIn"] })
  ) as jwt.JwtPayload;
  return (probe.exp as number) - (probe.iat as number);
}

/**
 * Secret for HS256 tokens issued before key rotation was deployed. Returns it
 * only until JWT_LEGACY_HS256_UNTIL (ISO-8601); unset or past means legacy
 * tokens are rejected. Set it to deploy time + JWT_EXPIRES_IN so sessions
 * issued just before the deploy are not dropped.
 */
export function getLegacyJwtSecret(): string | null {
  const until = Date.parse(process.env.JWT_LEGACY_HS256_UNTIL ?? "");
  return Number.isFinite(until) && Date.now() < until ? getJwtSecret() : null;
}

/** The process-wide key ring; populated by jwtKeyRotationService.start(). */
export const jwtKeyRing = new JwtKeyRing({
  legacySecret: getLegacyJwtSecret,
  // A process-local key is fine for development and tests, but in production
  // every node must sign with the shared, persisted keys.
  allowEphemeralKeys: process.env.NODE_ENV !== "production",
});

export interface JwtPayload {
  userId: string;
  email?: string;
  username?: string;
  role?: string;
  [key: string]: unknown;
}

/**
 * Signs a minimal JWT payload with the current signing key.
 */
export function signAccessToken(payload: JwtPayload): string {
  return jwtKeyRing.sign(payload, getJwtExpiresIn() as jwt.SignOptions["expiresIn"]);
}

/**
 * Verifies a JWT and returns the decoded payload.
 * Throws JsonWebTokenError or TokenExpiredError if invalid.
 */
export function verifyAccessToken(token: string): JwtPayload {
  return jwtKeyRing.verify(token) as JwtPayload;
}
