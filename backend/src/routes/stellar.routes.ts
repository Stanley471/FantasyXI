/**
 * Stellar Infrastructure Routes (Issue #549)
 *
 * Provides endpoints for fee-bump transaction sponsorship, gasless onboarding,
 * and Stellar network operations.
 */

import { Router } from "express";
import { sponsorStellarFeeHandler } from "../controllers/stellarFeeBump.controller.js";
import { optionalAuth } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * POST /sponsor-fee
 * Wraps user-signed deposit transactions into a FeeBumpTransaction paid by the platform.
 */
router.post("/sponsor-fee", optionalAuth, sponsorStellarFeeHandler);

export default router;
