import { Router } from "express";
import {
  listFailedPayouts,
  getFailedPayout,
  retryFailedPayout,
  discardFailedPayout,
  listFinancialAuditLog,
} from "../controllers/payoutAdmin.controller.js";
import { listSecurityAnomalies } from "../controllers/securityAdmin.controller.js";
import { requireAuth, requireRole } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";

const router = Router();

// ============================================================
// Financial administration
// Staff (ADMIN / MODERATOR) may inspect failed payouts; only ADMINs
// may trigger actions that move or write off funds.
// ============================================================
router.use(requireAuth, requireRole(UserRole.ADMIN, UserRole.MODERATOR));

// GET /api/v1/admin/payouts/dead-letter
router.get("/payouts/dead-letter", listFailedPayouts);

// GET /api/v1/admin/payouts/dead-letter/:id
router.get("/payouts/dead-letter/:id", getFailedPayout);

// POST /api/v1/admin/payouts/dead-letter/:id/retry (ADMIN only)
router.post("/payouts/dead-letter/:id/retry", requireRole(UserRole.ADMIN), retryFailedPayout);

// POST /api/v1/admin/payouts/dead-letter/:id/discard (ADMIN only)
router.post("/payouts/dead-letter/:id/discard", requireRole(UserRole.ADMIN), discardFailedPayout);

// GET /api/v1/admin/audit/financial (ADMIN only: exposes every user's ledger history)
router.get("/audit/financial", requireRole(UserRole.ADMIN), listFinancialAuditLog);

// GET /api/v1/admin/security/anomalies (issue #117): failed-login spikes and
// new-device/new-IP logins detected across all accounts, for admin review.
router.get("/security/anomalies", listSecurityAnomalies);

export default router;
