import { Router } from "express";
import {
  register,
  login,
  getMe,
  initiateGoogleAuth,
  handleGoogleCallback,
  getUserReferralCode,
} from "../controllers/auth.controller.js";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";
import { authRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// POST /api/v1/auth/register
router.post("/register", authRateLimiter, register);

// POST /api/v1/auth/login
router.post("/login", authRateLimiter, login);

// GET /api/v1/auth/me (Protected)
router.get("/me", requireAuth, requirePermission(Permission.PROFILE_READ), getMe);

// GET /api/v1/auth/referral-code (Protected)
router.get(
  "/referral-code",
  requireAuth,
  requirePermission(Permission.AFFILIATE_READ_OWN),
  getUserReferralCode
);

// GET /api/v1/auth/google (Initiates Google OAuth redirect)
router.get("/google", authRateLimiter, initiateGoogleAuth);

// GET /api/v1/auth/google/callback (Handles Google OAuth callback)
router.get("/google/callback", handleGoogleCallback);

export default router;

