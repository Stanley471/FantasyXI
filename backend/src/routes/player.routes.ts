import { Router } from "express";
import {
  getPlayers,
  getPlayerById,
  getPlayerOwnershipStats,
  getPlayerAnalytics,
} from "../controllers/player.controller.js";

/**
 * Player routes.
 *
 * GET /api/v1/players                — Paginated list with filters (position, team, price, search)
 * GET /api/v1/players/stats/ownership — Ownership stats and points-per-million
 * GET /api/v1/players/:id/analytics  — Expected points (xP) and Fixture Difficulty Rating (FDR)
 * GET /api/v1/players/:id            — Single player with last 10 gameweek stats
 */
const router = Router();

router.get("/stats/ownership", getPlayerOwnershipStats);
router.get("/", getPlayers);
router.get("/:id/analytics", getPlayerAnalytics);
router.get("/:id", getPlayerById);

export default router;
