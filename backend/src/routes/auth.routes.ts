import { Router } from "express";
import {
  register,
  login,
  verifyLoginChallenge,
  getMe,
  updatePrivacySettings,
  updatePrivacySettingsForUser,
  initiateGoogleAuth,
  handleGoogleCallback,
  createGoogleLinkTicket,
  startGoogleLink,
  unlinkGoogleAccount,
  setPassword,
  getUserReferralCode,
  listActiveSessions,
  revokeSession,
  revokeOtherSessions,
  streamSessionEvents,
  revokeSigningKey,
  getPasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  getPasskeyLoginOptions,
  verifyPasskeyLogin,
  listPasskeys,
  deletePasskey,
  refresh,
  logout,
  getStellarChallenge,
  verifyStellarChallenge,
  configurePasskeyRecovery,
  beginPasskeyRecovery,
  completePasskeyRecovery,
} from "../controllers/auth.controller.js";
import { requireAuth, requirePermission, requireRole } from "../middleware/authMiddleware.js";
import { Permission, UserRole } from "../types/index.js";
import {
  authRateLimiter,
  authenticatedRateLimiter,
  mutationRateLimiter,
} from "../middleware/rateLimiter.js";
import {
  createWalletLinkChallengeHandler,
  verifyAndLinkWalletHandler,
  listLinkedWalletsHandler,
  renameLinkedWalletHandler,
  unlinkWalletHandler,
} from "../controllers/walletLinker.controller.js";

const router = Router();

// POST /api/v1/auth/register
router.post("/register", authRateLimiter, register);

// POST /api/v1/auth/login
router.post("/login", authRateLimiter, login);
router.post("/refresh", authRateLimiter, refresh);
router.post("/logout", authRateLimiter, logout);

// POST /api/v1/auth/login/verify (step-up code for a login from a new device)
router.post("/login/verify", authRateLimiter, verifyLoginChallenge);

// SEP-0010 Stellar Web Authentication (issue #562)
// GET /api/v1/auth/stellar/challenge?account=G...
router.get("/stellar/challenge", authRateLimiter, getStellarChallenge);
// POST /api/v1/auth/stellar/verify
router.post("/stellar/verify", authRateLimiter, verifyStellarChallenge);

// GET /api/v1/auth/me (Protected)
router.get("/me", requireAuth, authenticatedRateLimiter, requirePermission(Permission.PROFILE_READ), getMe);

// PATCH /api/v1/auth/me/privacy (Protected: flip your own leaderboard anonymization toggle, issue #511)
router.patch(
  "/me/privacy",
  requireAuth,
  authenticatedRateLimiter,
  mutationRateLimiter,
  requirePermission(Permission.PROFILE_UPDATE_OWN),
  updatePrivacySettings
);

// PATCH /api/v1/auth/users/:userId/privacy (ADMIN only: flip another manager's toggle, issue #511)
router.patch(
  "/users/:userId/privacy",
  requireAuth,
  authenticatedRateLimiter,
  mutationRateLimiter,
  requireRole(UserRole.ADMIN),
  updatePrivacySettingsForUser
);

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

// Active session management & device fingerprinting (Issue #342)
router.get("/sessions", requireAuth, authenticatedRateLimiter, listActiveSessions);
router.delete("/sessions/:sessionId", requireAuth, authenticatedRateLimiter, revokeSession);
router.post("/sessions/revoke-others", requireAuth, authenticatedRateLimiter, revokeOtherSessions);
router.get("/sessions/events", requireAuth, streamSessionEvents);
// ============================================================
// WebAuthn / Passkeys (issue #273)
// ============================================================

// POST /api/v1/auth/webauthn/login/options (usernameless passkey sign-in)
router.post("/webauthn/login/options", authRateLimiter, getPasskeyLoginOptions);

// POST /api/v1/auth/webauthn/login/verify (passwordless sign-in, or the step-up after a password)
router.post("/webauthn/login/verify", authRateLimiter, verifyPasskeyLogin);

// Passkey management for the signed-in account
const passkeyOwner = [requireAuth, authenticatedRateLimiter, requirePermission(Permission.PROFILE_UPDATE_OWN)];

// POST /api/v1/auth/webauthn/register/options (Protected)
router.post("/webauthn/register/options", ...passkeyOwner, getPasskeyRegistrationOptions);

// POST /api/v1/auth/webauthn/register/verify (Protected)
router.post("/webauthn/register/verify", ...passkeyOwner, verifyPasskeyRegistration);

// GET /api/v1/auth/webauthn/credentials (Protected)
router.get("/webauthn/credentials", ...passkeyOwner, listPasskeys);

// DELETE /api/v1/auth/webauthn/credentials/:credentialId (Protected)
router.delete("/webauthn/credentials/:credentialId", ...passkeyOwner, deletePasskey);

// ============================================================
// Multi-Chain Crypto Wallet Account Linker (issue #426)
// ============================================================
router.post("/wallets/challenge", ...passkeyOwner, createWalletLinkChallengeHandler);
router.post("/wallets/verify", ...passkeyOwner, verifyAndLinkWalletHandler);
router.get("/wallets", requireAuth, authenticatedRateLimiter, listLinkedWalletsHandler);
router.patch("/wallets/:walletId", ...passkeyOwner, renameLinkedWalletHandler);
router.delete("/wallets/:walletId", ...passkeyOwner, unlinkWalletHandler);
router.post("/webauthn/recovery/configure", ...passkeyOwner, configurePasskeyRecovery);
router.post("/webauthn/recovery/begin", authRateLimiter, beginPasskeyRecovery);
router.post("/webauthn/recovery/complete", authRateLimiter, completePasskeyRecovery);

// POST /api/v1/auth/keys/:kid/revoke (ADMIN or service key: revokes a JWT signing key on every node)
router.post("/keys/:kid/revoke", requireAuth, requirePermission(Permission.AUTH_KEYS_MANAGE), revokeSigningKey);

export default router;

