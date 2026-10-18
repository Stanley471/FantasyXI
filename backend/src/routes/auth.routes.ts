import { Router } from "express";
import {
  register,
  login,
  getMe,
  initiateGoogleAuth,
  handleGoogleCallback,
  createGoogleLinkTicket,
  startGoogleLink,
  unlinkGoogleAccount,
  setPassword,
  getUserReferralCode,
} from "../controllers/auth.controller.js";
import {
  deletePasskey,
  listPasskeys,
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyMfaOptions,
  passkeyMfaVerify,
  passkeyRegistrationOptions,
  passkeyRegistrationVerify,
  setPasskeyMfa,
} from "../controllers/passkey.controller.js";
import { getMyTrophies } from "../controllers/seasonRollover.controller.js";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";
import {
  authRateLimiter,
  authenticatedRateLimiter,
} from "../middleware/rateLimiter.js";

const router = Router();

// POST /api/v1/auth/register
router.post("/register", authRateLimiter, register);

// POST /api/v1/auth/login
router.post("/login", authRateLimiter, login);

// GET /api/v1/auth/me (Protected)
router.get("/me", requireAuth, authenticatedRateLimiter, requirePermission(Permission.PROFILE_READ), getMe);

// GET /api/v1/auth/referral-code (Protected)
router.get(
  "/referral-code",
  requireAuth,
  authenticatedRateLimiter,
  requirePermission(Permission.AFFILIATE_READ_OWN),
  getUserReferralCode
);

// GET /api/v1/auth/google (Initiates Google OAuth redirect)
router.get("/google", authRateLimiter, initiateGoogleAuth);

// GET /api/v1/auth/google/callback (Handles Google OAuth callback for sign-in and linking)
router.get("/google/callback", handleGoogleCallback);

// POST /api/v1/auth/google/link (Protected: returns a short-lived URL that starts linking)
router.post("/google/link", requireAuth, createGoogleLinkTicket);

// GET /api/v1/auth/google/link/start?ticket=... (Redirects the signed-in user to Google)
router.get("/google/link/start", authRateLimiter, startGoogleLink);

// DELETE /api/v1/auth/google/link (Protected: unlink Google, requires a password to remain)
router.delete("/google/link", requireAuth, unlinkGoogleAccount);

// POST /api/v1/auth/password (Protected: add a password to a Google account, or change it)
router.post("/password", authRateLimiter, requireAuth, setPassword);

// GET /api/v1/auth/me/trophies (Protected: season trophies and badges on the profile)
router.get(
  "/me/trophies",
  requireAuth,
  authenticatedRateLimiter,
  requirePermission(Permission.PROFILE_READ),
  getMyTrophies
);

// WebAuthn / passkeys (issue #273)
// Management (Protected)
router.post("/passkeys/register/options", requireAuth, authenticatedRateLimiter, passkeyRegistrationOptions);
router.post("/passkeys/register/verify", requireAuth, authenticatedRateLimiter, passkeyRegistrationVerify);
router.get("/passkeys", requireAuth, authenticatedRateLimiter, listPasskeys);
router.delete("/passkeys/:id", requireAuth, authenticatedRateLimiter, deletePasskey);
router.put("/passkeys/mfa", authRateLimiter, requireAuth, setPasskeyMfa);
// Passwordless sign-in and password + passkey step-up (Public, rate limited)
router.post("/passkeys/login/options", authRateLimiter, passkeyLoginOptions);
router.post("/passkeys/login/verify", authRateLimiter, passkeyLoginVerify);
router.post("/passkeys/mfa/options", authRateLimiter, passkeyMfaOptions);
router.post("/passkeys/mfa/verify", authRateLimiter, passkeyMfaVerify);

export default router;

