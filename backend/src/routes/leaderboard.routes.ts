import { Router } from "express";
import { getLeaderboard } from "../controllers/leaderboard.controller.js";
import { optionalAuth } from "../middleware/authMiddleware.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getMatchmakingCandidates, joinMatchmaking } from "../controllers/matchmaking.controller.js";
import { mutationRateLimiter } from "../middleware/rateLimiter.js";
import { idempotency } from "../middleware/idempotency.js";

const router = Router();

// GET /api/v1/leaderboard (Public: signed-in viewers also get their own position)
router.get("/", optionalAuth, getLeaderboard);
router.get("/matchmaking", requireAuth, getMatchmakingCandidates);
router.post("/matchmaking/join", requireAuth, mutationRateLimiter, idempotency, joinMatchmaking);

export default router;
