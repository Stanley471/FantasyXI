import { Router } from "express";
import {
  syncBootstrap,
  syncFixtures,
  syncGameweekLive,
} from "../controllers/sync.controller.js";
import { requireAuth, requirePermission, requireRole } from "../middleware/authMiddleware.js";
import { Permission, UserRole } from "../types/index.js";
import { syncRateLimiter, mutationRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// ============================================================
// Admin-only FPL synchronization endpoints
// Global sync triggers mutate shared data and require the fpl:sync
// permission (ADMIN, MODERATOR and SERVICE roles), protected by syncRateLimiter.
// ============================================================
router.use(
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.MODERATOR),
  requirePermission(Permission.FPL_SYNC),
  syncRateLimiter,
  mutationRateLimiter
);

// POST /api/v1/admin/sync/bootstrap
router.post("/bootstrap", syncBootstrap);

// POST /api/v1/admin/sync/fixtures
router.post("/fixtures", syncFixtures);

// POST /api/v1/admin/sync/gameweek/:id
router.post("/gameweek/:id", syncGameweekLive);

export default router;
