import { Router } from "express";
import {
  syncBootstrap,
  syncFixtures,
  syncGameweekLive,
} from "../controllers/sync.controller.js";
import { requireAuth, requireRole } from "../middleware/authMiddleware.js";
import { syncRateLimiter } from "../middleware/rateLimiter.js";
import { UserRole } from "../types/index.js";

const router = Router();

// ============================================================
// Admin-only FPL synchronization endpoints
// Global sync triggers mutate shared data and are restricted to
// ADMIN / MODERATOR roles via RBAC, protected by syncRateLimiter.
// ============================================================
router.use(requireAuth, requireRole(UserRole.ADMIN, UserRole.MODERATOR));
router.use(syncRateLimiter);

// POST /api/v1/admin/sync/bootstrap
router.post("/bootstrap", syncBootstrap);

// POST /api/v1/admin/sync/fixtures
router.post("/fixtures", syncFixtures);

// POST /api/v1/admin/sync/gameweek/:id
router.post("/gameweek/:id", syncGameweekLive);

export default router;
