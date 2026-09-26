import { Router } from "express";
import { getLeaderboard } from "../controllers/leaderboard.controller.js";
import { optionalAuth } from "../middleware/authMiddleware.js";

const router = Router();

// GET /api/v1/leaderboard (Public: signed-in viewers also get their own position)
router.get("/", optionalAuth, getLeaderboard);

export default router;
