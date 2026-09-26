import { Router } from "express";
import {
  getGameweeks,
  getCurrentGameweek,
  getGameweekById,
  getMyGameweekHistory,
} from "../controllers/gameweek.controller.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

// GET /api/v1/gameweeks
router.get("/", getGameweeks);

// GET /api/v1/gameweeks/current
router.get("/current", getCurrentGameweek);

// GET /api/v1/gameweeks/history/me
router.get("/history/me", requireAuth, getMyGameweekHistory);

// GET /api/v1/gameweeks/:id
router.get("/:id", getGameweekById);

export default router;
