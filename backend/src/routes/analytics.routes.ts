import { Router } from "express";
import { getMyPerformance } from "../controllers/analytics.controller.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

// GET /api/v1/analytics/me/performance (Protected: historical points dashboard)
router.get("/me/performance", requireAuth, getMyPerformance);

export default router;
