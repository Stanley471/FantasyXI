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
import { requireAuth } from "../middleware/authMiddleware.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// POST /api/v1/auth/register
router.post("/register", authRateLimiter, register);

// POST /api/v1/auth/login
router.post("/login", authRateLimiter, login);

// GET /api/v1/auth/me (Protected)
router.get("/me", requireAuth, getMe);

// GET /api/v1/auth/referral-code (Protected)
router.get("/referral-code", requireAuth, getUserReferralCode);

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

export default router;

