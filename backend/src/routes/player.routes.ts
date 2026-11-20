import { Router } from "express";
import {
  getPlayers,
  getPlayerById,
  getPlayerOwnershipStats,
  batchPlayerStats,
  getPlayerAnalytics,
  getMarketTrends,
} from "../controllers/player.controller.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { authenticatedRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// GET /api/v1/players
router.get("/", getPlayers);

// GET /api/v1/players/ownership-stats
router.get("/ownership-stats", getPlayerOwnershipStats);

// GET /api/v1/players/market-trends
router.get("/market-trends", getMarketTrends);

// POST /api/v1/players/batch-stats (authenticated, rate limited)
router.post("/batch-stats", requireAuth, authenticatedRateLimiter, batchPlayerStats);

// GET /api/v1/players/:id/analytics (xP and fixture difficulty)
router.get("/:id/analytics", getPlayerAnalytics);

// GET /api/v1/players/:id
router.get("/:id", getPlayerById);

export default router;

