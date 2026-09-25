import { Request, Response, NextFunction } from "express";
import {
  authService,
  AuthValidationError,
  AuthConflictError,
  AuthUnauthorizedError,
  AuthNotFoundError,
} from "../services/auth/authService.js";
import { ReferralService } from "../services/auth/referralService.js";

/**
 * Authentication Controller.
 *
 * Handles HTTP requests for registration, login, and authenticated user profile.
 *
 * Laravel equivalent: App\Http\Controllers\Auth\AuthenticatedSessionController and
 * RegisteredUserController.
 */

export async function register(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await authService.register(req.body);
    res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: result,
    });
  } catch (error) {
    if (error instanceof AuthValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof AuthConflictError) {
      res.status(409).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function login(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await authService.login(req.body);
    res.json({
      success: true,
      message: "Logged in successfully",
      data: result,
    });
  } catch (error) {
    if (error instanceof AuthUnauthorizedError) {
      res.status(401).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof AuthValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function getMe(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
      return;
    }

    const user = await authService.getMe(req.user.id);
    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    if (error instanceof AuthNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

import {
  googleAuthService,
} from "../services/auth/googleAuthService.js";
import {
  isGoogleOAuthConfigured,
  generateOAuthNonce,
  generateOAuthState,
  verifyOAuthState,
  generateLinkTicket,
  verifyLinkTicket,
  sanitizeReturnTo,
  OAUTH_NONCE_COOKIE,
  OAuthIntent,
} from "../config/google.js";

const GOOGLE_NOT_CONFIGURED_MESSAGE =
  "Google OAuth is not configured. Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.";

function frontendUrl(): string {
  return process.env.FRONTEND_URL || "http://localhost:3000";
}

function nonceCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

/** Reads a cookie from the raw Cookie header (no cookie-parser dependency). */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Binds the flow to this browser and redirects to Google's consent screen. */
function redirectToGoogle(
  res: Response,
  options: { intent: OAuthIntent; returnTo?: string; userId?: string }
): void {
  const nonce = generateOAuthNonce();
  res.cookie(OAUTH_NONCE_COOKIE, nonce, {
    ...nonceCookieOptions(),
    maxAge: 10 * 60 * 1000,
  });
  const state = generateOAuthState({ ...options, nonce });
  res.redirect(googleAuthService.getAuthorizationUrl(state));
}

export async function initiateGoogleAuth(
  req: Request,
  res: Response
): Promise<void> {
  if (!isGoogleOAuthConfigured()) {
    res.status(503).json({
      success: false,
      message: GOOGLE_NOT_CONFIGURED_MESSAGE,
    });
    return;
  }

  redirectToGoogle(res, {
    intent: "login",
    returnTo: sanitizeReturnTo(req.query.returnTo),
  });
}

/**
 * POST /api/v1/auth/google/link (Protected)
 *
 * Returns a short-lived URL that starts the Google linking redirect for the
 * signed-in user. A ticket is used because a top-level navigation cannot
 * carry the Bearer token.
 */
export async function createGoogleLinkTicket(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }
  if (!isGoogleOAuthConfigured()) {
    res.status(503).json({
      success: false,
      message: GOOGLE_NOT_CONFIGURED_MESSAGE,
    });
    return;
  }

  const ticket = generateLinkTicket(req.user.id);
  res.json({
    success: true,
    data: {
      url: `/api/v1/auth/google/link/start?ticket=${encodeURIComponent(ticket)}`,
    },
  });
}

/** GET /api/v1/auth/google/link/start?ticket=... (starts the linking redirect) */
export async function startGoogleLink(
  req: Request,
  res: Response
): Promise<void> {
  const userId = verifyLinkTicket(req.query.ticket);
  if (!userId || !isGoogleOAuthConfigured()) {
    const redirectUrl = new URL("/profile", frontendUrl());
    redirectUrl.searchParams.set(
      "linkError",
      userId ? "google_not_configured" : "link_ticket_invalid"
    );
    res.redirect(redirectUrl.toString());
    return;
  }

  redirectToGoogle(res, { intent: "link", userId, returnTo: "/profile" });
}

/** DELETE /api/v1/auth/google/link (Protected) */
export async function unlinkGoogleAccount(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const user = await authService.unlinkGoogleAccount(req.user.id);
    res.json({
      success: true,
      message: "Google account unlinked",
      data: user,
    });
  } catch (error) {
    if (error instanceof AuthConflictError) {
      res.status(409).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof AuthNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

/** POST /api/v1/auth/password (Protected: add or change the account password) */
export async function setPassword(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const user = await authService.setPassword(req.user.id, req.body ?? {});
    res.json({
      success: true,
      message: "Password updated",
      data: user,
    });
  } catch (error) {
    if (error instanceof AuthValidationError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof AuthUnauthorizedError) {
      res.status(401).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof AuthNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

export async function handleGoogleCallback(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { code, state, error } = req.query;
  const wantsJson = Boolean(req.headers.accept?.includes("application/json"));

  // The nonce cookie is single-use
  const browserNonce = readCookie(req, OAUTH_NONCE_COOKIE);
  res.clearCookie(OAUTH_NONCE_COOKIE, nonceCookieOptions());

  const stateCheck =
    typeof state === "string"
      ? verifyOAuthState(state, { browserNonce })
      : { valid: false as const };
  const intent: OAuthIntent = stateCheck.valid && stateCheck.intent === "link" ? "link" : "login";

  // Browsers are sent back to the page that started the flow with an error code
  const fail = (status: number, errorCode: string, message: string) => {
    if (wantsJson) {
      res.status(status).json({ success: false, message, code: errorCode });
      return;
    }
    const redirectUrl = new URL(intent === "link" ? "/profile" : "/login", frontendUrl());
    redirectUrl.searchParams.set(intent === "link" ? "linkError" : "error", errorCode);
    res.redirect(redirectUrl.toString());
  };

  if (error) {
    fail(400, "google_denied", "Google sign-in was cancelled or denied");
    return;
  }

  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    fail(400, "oauth_state_invalid", "Missing authorization code or state parameter");
    return;
  }

  // Validate the signed state and its binding to this browser to prevent CSRF
  if (!stateCheck.valid) {
    fail(400, "oauth_state_invalid", "Invalid or expired OAuth state parameter");
    return;
  }

  try {
    // Exchange code and verify Google ID token
    const verifiedGoogleUser = await googleAuthService.verifyAuthorizationCode(code);

    if (intent === "link") {
      const user = await authService.linkGoogleAccount(stateCheck.userId!, verifiedGoogleUser);
      if (wantsJson) {
        res.json({ success: true, message: "Google account linked", data: { user } });
        return;
      }
      const profileUrl = new URL("/profile", frontendUrl());
      profileUrl.searchParams.set("linked", "google");
      res.redirect(profileUrl.toString());
      return;
    }

    // Authenticate or link user
    const result = await authService.handleGoogleAuth(verifiedGoogleUser);

    // If client requested JSON (e.g. testing / API clients)
    if (wantsJson) {
      res.json({
        success: true,
        message: "Google authentication successful",
        data: result,
      });
      return;
    }

    // Redirect to the frontend with the JWT in the URL fragment: fragments are
    // not sent to servers, so the token stays out of access logs and Referer
    const fragment = new URLSearchParams({ token: result.token });
    if (stateCheck.returnTo && stateCheck.returnTo !== "/") {
      fragment.set("returnTo", stateCheck.returnTo);
    }
    const callbackUrl = new URL("/auth/callback", frontendUrl());
    callbackUrl.hash = fragment.toString();

    res.redirect(callbackUrl.toString());
  } catch (error) {
    if (error instanceof AuthConflictError) {
      fail(409, "google_account_conflict", error.message);
      return;
    }
    if (error instanceof AuthValidationError) {
      const unverified = /not verified/i.test(error.message);
      fail(400, unverified ? "google_email_unverified" : "google_auth_failed", error.message);
      return;
    }
    if (error instanceof AuthUnauthorizedError) {
      fail(401, "google_auth_failed", error.message);
      return;
    }
    if (error instanceof AuthNotFoundError) {
      fail(404, "account_not_found", error.message);
      return;
    }
    next(error);
  }
}

export async function getUserReferralCode(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const data = await ReferralService.getOrCreateReferralCode(userId);
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
}



