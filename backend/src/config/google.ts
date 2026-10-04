import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import dotenv from "dotenv";
import { getJwtSecret } from "./jwt.js";

dotenv.config();

/**
 * Centralized Google OAuth 2.0 / OpenID Connect Configuration.
 *
 * Laravel equivalent: config/services.php ['google'] configuration
 * used by Laravel Socialite.
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export function getGoogleConfig(): GoogleOAuthConfig {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    callbackUrl:
      process.env.GOOGLE_CALLBACK_URL ||
      "http://localhost:5000/api/v1/auth/google/callback",
  };
}

export function isGoogleOAuthConfigured(): boolean {
  const config = getGoogleConfig();
  return Boolean(
    config.clientId &&
      config.clientSecret &&
      !config.clientId.includes("your-google-client-id")
  );
}

/**
 * Returns a configured Google OAuth2Client instance.
 */
export function getOAuth2Client(): OAuth2Client {
  const config = getGoogleConfig();
  return new OAuth2Client(
    config.clientId,
    config.clientSecret,
    config.callbackUrl
  );
}


/**
 * 10-minute state lifetime to protect against CSRF attacks.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Link tickets only bridge an authenticated fetch to a top-level redirect. */
const LINK_TICKET_TTL_MS = 2 * 60 * 1000;

/** Allowed clock skew for timestamps issued in the future. */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Cookie binding the OAuth state to the browser that started the flow, so an
 * attacker cannot complete their own Google sign-in in a victim's browser
 * (login CSRF) or attach their Google identity to a victim's account.
 */
export const OAUTH_NONCE_COOKIE = "fxi_oauth_nonce";

/** "login" signs in or signs up; "link" attaches Google to a signed-in account. */
export type OAuthIntent = "login" | "link";

interface StatePayload {
  nonce: string;
  timestamp: number;
  returnTo?: string;
  intent?: OAuthIntent;
  userId?: string;
}

export interface OAuthStateOptions {
  returnTo?: string;
  intent?: OAuthIntent;
  /** Account to link to; required when intent is "link". */
  userId?: string;
  /** Browser nonce also stored in OAUTH_NONCE_COOKIE. Generated when omitted. */
  nonce?: string;
}

export interface OAuthStateCheck {
  valid: boolean;
  returnTo?: string;
  intent?: OAuthIntent;
  userId?: string;
}

function hmac(value: string): string {
  return crypto.createHmac("sha256", getJwtSecret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isFresh(timestamp: number, ttlMs: number): boolean {
  const now = Date.now();
  return (
    Number.isFinite(timestamp) &&
    now - timestamp <= ttlMs &&
    timestamp <= now + CLOCK_SKEW_MS
  );
}

/** Generates the random browser nonce stored in OAUTH_NONCE_COOKIE. */
export function generateOAuthNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Restricts post-login redirects to same-site relative paths. Absolute URLs,
 * protocol-relative URLs ("//evil.com") and backslash tricks fall back to "/".
 */
export function sanitizeReturnTo(returnTo: unknown): string {
  if (typeof returnTo !== "string" || returnTo.length > 512) return "/";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || /[\\\s]/.test(returnTo)) {
    return "/";
  }
  return returnTo;
}

/**
 * Generates an HMAC-signed CSRF state parameter.
 * Accepts a return path for backwards compatibility, or full options.
 */
export function generateOAuthState(options?: string | OAuthStateOptions): string {
  const opts: OAuthStateOptions =
    typeof options === "string" ? { returnTo: options } : options ?? {};

  if (opts.intent === "link" && !opts.userId) {
    throw new Error("A link state requires the userId of the signed-in account");
  }

  const payload: StatePayload = {
    nonce: opts.nonce ?? generateOAuthNonce(),
    timestamp: Date.now(),
    returnTo: sanitizeReturnTo(opts.returnTo || "/"),
    intent: opts.intent ?? "login",
    ...(opts.userId && { userId: opts.userId }),
  };

  const jsonPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${jsonPayload}.${hmac(jsonPayload)}`;
}

/**
 * Validates the HMAC signature and expiration of an OAuth state parameter.
 *
 * When `binding` is supplied, the state must also carry the nonce stored in
 * the browser's OAUTH_NONCE_COOKIE; a missing cookie fails the check.
 */
export function verifyOAuthState(
  stateString: string,
  binding?: { browserNonce: string | null | undefined }
): OAuthStateCheck {
  if (!stateString || typeof stateString !== "string") {
    return { valid: false };
  }

  const parts = stateString.split(".");
  if (parts.length !== 2) {
    return { valid: false };
  }

  const [jsonPayload, signature] = parts;
  if (!safeEqual(signature, hmac(jsonPayload))) {
    return { valid: false };
  }

  try {
    const raw = Buffer.from(jsonPayload, "base64url").toString("utf-8");
    const payload: StatePayload = JSON.parse(raw);

    // Verify freshness (within 10 minutes, and not in the future beyond clock skew)
    if (!isFresh(payload.timestamp, STATE_TTL_MS)) {
      return { valid: false };
    }

    if (binding && (!binding.browserNonce || !safeEqual(payload.nonce, binding.browserNonce))) {
      return { valid: false };
    }

    const intent: OAuthIntent = payload.intent === "link" ? "link" : "login";
    if (intent === "link" && !payload.userId) {
      return { valid: false };
    }

    return {
      valid: true,
      returnTo: sanitizeReturnTo(payload.returnTo),
      intent,
      userId: payload.userId,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * Issues a short-lived, single-purpose ticket that lets a signed-in user
 * start the Google linking redirect. The browser cannot attach its Bearer
 * token to a top-level navigation, so the authenticated API call hands out
 * this ticket instead of putting the JWT in a URL.
 */
export function generateLinkTicket(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ purpose: "google-link", userId, timestamp: Date.now() })
  ).toString("base64url");
  return `${payload}.${hmac(`google-link:${payload}`)}`;
}

/** Returns the user ID of a valid, unexpired link ticket, or null. */
export function verifyLinkTicket(ticket: unknown): string | null {
  if (typeof ticket !== "string") return null;

  const parts = ticket.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  if (!safeEqual(signature, hmac(`google-link:${payload}`))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (data.purpose !== "google-link" || typeof data.userId !== "string") return null;
    if (!isFresh(data.timestamp, LINK_TICKET_TTL_MS)) return null;
    return data.userId;
  } catch {
    return null;
  }
}
