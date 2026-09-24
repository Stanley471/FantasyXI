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
  generateOAuthState,
  verifyOAuthState,
} from "../config/google.js";

export async function initiateGoogleAuth(
  req: Request,
  res: Response
): Promise<void> {
  if (!isGoogleOAuthConfigured()) {
    res.status(503).json({
      success: false,
      message:
        "Google OAuth is not configured. Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
    });
    return;
  }

  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : undefined;
  const state = generateOAuthState(returnTo);
  const authUrl = googleAuthService.getAuthorizationUrl(state);

  res.redirect(authUrl);
}

export async function handleGoogleCallback(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { code, state, error } = req.query;

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    if (error) {
      const redirectUrl = new URL("/login", frontendUrl);
      redirectUrl.searchParams.set("error", String(error));
      res.redirect(redirectUrl.toString());
      return;
    }

    if (!code || typeof code !== "string" || !state || typeof state !== "string") {
      res.status(400).json({
        success: false,
        message: "Missing authorization code or state parameter",
      });
      return;
    }

    // Validate cryptographic state parameter to prevent CSRF
    const stateCheck = verifyOAuthState(state);
    if (!stateCheck.valid) {
      res.status(400).json({
        success: false,
        message: "Invalid or expired OAuth state parameter",
      });
      return;
    }

    // Exchange code and verify Google ID token
    const verifiedGoogleUser = await googleAuthService.verifyAuthorizationCode(code);

    // Authenticate or link user
    const result = await authService.handleGoogleAuth(verifiedGoogleUser);

    // If client requested JSON (e.g. testing / API clients)
    if (req.headers.accept?.includes("application/json")) {
      res.json({
        success: true,
        message: "Google authentication successful",
        data: result,
      });
      return;
    }

    // Otherwise redirect to frontend callback with issued JWT
    const callbackUrl = new URL("/auth/callback", frontendUrl);
    callbackUrl.searchParams.set("token", result.token);
    if (stateCheck.returnTo && stateCheck.returnTo !== "/") {
      callbackUrl.searchParams.set("returnTo", stateCheck.returnTo);
    }

    res.redirect(callbackUrl.toString());
  } catch (error) {
    if (error instanceof AuthConflictError) {
      res.status(409).json({
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
    if (error instanceof AuthUnauthorizedError) {
      res.status(401).json({
        success: false,
        message: error.message,
      });
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



