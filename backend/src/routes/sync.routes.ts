import { Router } from "express";
import {
  syncBootstrap,
  syncFixtures,
  syncGameweekLive,
} from "../controllers/sync.controller.js";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";
import { authenticatedRateLimiter, mutationRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// ============================================================
// Admin-only FPL synchronization endpoints
// Global sync triggers mutate shared data and require the fpl:sync
// permission (ADMIN, MODERATOR and SERVICE roles).
// ============================================================
router.use(
  requireAuth,
  authenticatedRateLimiter,
  requirePermission(Permission.FPL_SYNC),
  mutationRateLimiter
);

// POST /api/v1/admin/sync/bootstrap
router.post("/bootstrap", syncBootstrap);

// POST /api/v1/admin/sync/fixtures
router.post("/fixtures", syncFixtures);

// POST /api/v1/admin/sync/gameweek/:id
router.post("/gameweek/:id", syncGameweekLive);

export default router;
