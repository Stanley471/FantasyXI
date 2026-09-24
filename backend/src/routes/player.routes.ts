import { Router } from "express";
import { getPlayers, getPlayerById, getPlayerOwnershipStats } from "../controllers/player.controller.js";

const router = Router();

// GET /api/v1/players
router.get("/", getPlayers);

// GET /api/v1/players/ownership-stats
router.get("/ownership-stats", getPlayerOwnershipStats);

// GET /api/v1/players/:id
router.get("/:id", getPlayerById);

export default router;

