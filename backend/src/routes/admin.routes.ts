import { Router } from "express";
import {
  listFailedPayouts,
  getFailedPayout,
  retryFailedPayout,
  discardFailedPayout,
  listFinancialAuditLog,
} from "../controllers/payoutAdmin.controller.js";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";

const router = Router();

// ============================================================
// Financial administration
// Staff (ADMIN / MODERATOR) may inspect failed payouts (payout:read); only
// ADMINs may trigger actions that move or write off funds (payout:manage).
// ============================================================
router.use(requireAuth, requirePermission(Permission.PAYOUT_READ));

// GET /api/v1/admin/payouts/dead-letter
router.get("/payouts/dead-letter", listFailedPayouts);

// GET /api/v1/admin/payouts/dead-letter/:id
router.get("/payouts/dead-letter/:id", getFailedPayout);

// POST /api/v1/admin/payouts/dead-letter/:id/retry (ADMIN only)
router.post("/payouts/dead-letter/:id/retry", requirePermission(Permission.PAYOUT_MANAGE), retryFailedPayout);

// POST /api/v1/admin/payouts/dead-letter/:id/discard (ADMIN only)
router.post("/payouts/dead-letter/:id/discard", requirePermission(Permission.PAYOUT_MANAGE), discardFailedPayout);

// GET /api/v1/admin/audit/financial (ADMIN only: exposes every user's ledger history)
router.get("/audit/financial", requirePermission(Permission.FINANCIAL_AUDIT_READ), listFinancialAuditLog);

export default router;
