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
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";

const router = Router();

// POST /api/v1/squads (Protected)
router.post("/", requireAuth, requirePermission(Permission.SQUAD_CREATE), createSquad);

// GET /api/v1/squads/me (Protected: returns authenticated user's squads)
router.get("/me", requireAuth, requirePermission(Permission.SQUAD_READ_OWN), getMySquads);

// GET /api/v1/squads/:id (Public: view any squad)
router.get("/:id", getSquadById);

// PUT /api/v1/squads/:id (Protected: update user's own squad)
router.put("/:id", requireAuth, requirePermission(Permission.SQUAD_UPDATE_OWN), updateSquad);

// POST /api/v1/squads/:id/chip (Protected: play a chip before the gameweek deadline)
router.post("/:id/chip", requireAuth, requirePermission(Permission.SQUAD_UPDATE_OWN), activateChip);

// GET /api/v1/squads/user/:userId (Public: view squads by user ID)
router.get("/user/:userId", getUserSquads);

// POST /api/v1/squads/:id/calculate-score/:gameweekId
// (Operations: persisted scores feed standings, so only ADMIN / SERVICE may trigger it)
router.post(
  "/:id/calculate-score/:gameweekId",
  requireAuth,
  requirePermission(Permission.SCORE_CALCULATE),
  calculateGameweekScore
);

export default router;
