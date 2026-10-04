import { Router } from "express";
import {
  listFailedPayouts,
  getFailedPayout,
  retryFailedPayout,
  discardFailedPayout,
  listFinancialAuditLog,
} from "../controllers/payoutAdmin.controller.js";
import {
  recalculateStandings,
  createTierGroup,
  createTier,
  applyTierTransitions,
} from "../controllers/leagueAdmin.controller.js";
import { listH2HAnomalies, recalculateStandings } from "../controllers/leagueAdmin.controller.js";
import { listSecurityAnomalies } from "../controllers/securityAdmin.controller.js";
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

// GET /api/v1/admin/security/anomalies (issue #117): failed-login spikes and
// new-device/new-IP logins detected across all accounts, for admin review.
router.get("/security/anomalies", listSecurityAnomalies);

// GET /api/v1/admin/leagues/:leagueId/h2h-anomalies
router.get("/leagues/:leagueId/h2h-anomalies", listH2HAnomalies);

// POST /api/v1/admin/leagues/recalculate-standings { gameweekId }
// Bulk-recalculates every CLASSIC league's standings; see leagueAdmin.controller.ts.
router.post("/leagues/recalculate-standings", recalculateStandings);

// POST /api/v1/admin/leagues/tier-groups
router.post("/leagues/tier-groups", requirePermission(Permission.LEAGUE_TIER_MANAGE), createTierGroup);

// POST /api/v1/admin/leagues/tier-groups/:groupId/tiers
router.post("/leagues/tier-groups/:groupId/tiers", requirePermission(Permission.LEAGUE_TIER_MANAGE), createTier);

// POST /api/v1/admin/leagues/tier-groups/:groupId/season-end-transitions { season }
router.post(
  "/leagues/tier-groups/:groupId/season-end-transitions",
  requirePermission(Permission.LEAGUE_TIER_MANAGE),
  applyTierTransitions
);

export default router;
