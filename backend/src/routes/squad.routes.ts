import { Router } from "express";
import {
  createSquad,
  getSquadById,
  updateSquad,
  getMySquads,
  getUserSquads,
  calculateGameweekScore,
  activateChip,
} from "../controllers/squad.controller.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { authenticatedRateLimiter, mutationRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// POST /api/v1/squads (Protected)
router.post("/", requireAuth, authenticatedRateLimiter, mutationRateLimiter, createSquad);

// GET /api/v1/squads/me (Protected: returns authenticated user's squads)
router.get("/me", requireAuth, authenticatedRateLimiter, getMySquads);

// GET /api/v1/squads/:id (Public: view any squad)
router.get("/:id", getSquadById);

// PUT /api/v1/squads/:id (Protected: update user's own squad)
router.put("/:id", requireAuth, authenticatedRateLimiter, mutationRateLimiter, updateSquad);

// POST /api/v1/squads/:id/chip (Protected: play a chip before the gameweek deadline)
router.post("/:id/chip", requireAuth, authenticatedRateLimiter, mutationRateLimiter, activateChip);

// GET /api/v1/squads/user/:userId (Public: view squads by user ID)
router.get("/user/:userId", getUserSquads);

// POST /api/v1/squads/:id/calculate-score/:gameweekId
router.post("/:id/calculate-score/:gameweekId", calculateGameweekScore);

export default router;
