import { Router } from "express";
import {
  getGameweeks,
  getCurrentGameweek,
  getGameweekById,
  getMyGameweekHistory,
} from "../controllers/gameweek.controller.js";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";

const router = Router();

// GET /api/v1/gameweeks
router.get("/", getGameweeks);

// GET /api/v1/gameweeks/current
router.get("/current", getCurrentGameweek);

// GET /api/v1/gameweeks/history/me
router.get("/history/me", requireAuth, requirePermission(Permission.SQUAD_READ_OWN), getMyGameweekHistory);

// GET /api/v1/gameweeks/:id
router.get("/:id", getGameweekById);

export default router;
