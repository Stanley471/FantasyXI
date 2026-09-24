import { Router } from "express";
import {
  createLeague,
  getLeagues,
  getLeagueById,
  joinLeague,
  getLeagueMembers,
  getLeagueStandings,
  getH2HStandings,
  cancelLeague,
  streamLeagueLive,
} from "../controllers/league.controller.js";
import { requireAuth, requireRole } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";

const router = Router();

// POST /api/v1/leagues (Protected: creator identity derived from token)
router.post("/", requireAuth, createLeague);

// GET /api/v1/leagues (Public: explore leagues)
router.get("/", getLeagues);

// GET /api/v1/leagues/:id (Public: view league details)
router.get("/:id", getLeagueById);

// POST /api/v1/leagues/:id/join (Protected: member identity derived from token)
router.post("/:id/join", requireAuth, joinLeague);

// GET /api/v1/leagues/:id/members (Public: view league member list)
router.get("/:id/members", getLeagueMembers);

// GET /api/v1/leagues/:id/standings (Public: view league standings)
router.get("/:id/standings", getLeagueStandings);

// GET /api/v1/leagues/:id/h2h-standings (Public: head-to-head league table)
router.get("/:id/h2h-standings", getH2HStandings);

// POST /api/v1/leagues/:id/cancel (Protected: creator only)
router.post("/:id/cancel", requireAuth, cancelLeague);

// ============================================================
// Financial & Stellar Escrow Routes
// ============================================================
import financialRoutes from "./financial.routes.js";
import {
  getPaymentRequirement,
  submitPayment,
  verifyPayment,
  getSettlementPlan,
  executeSettlement,
  reconcileLeague,
} from "../controllers/financial.controller.js";

// Nested router under /:leagueId/financial
router.use("/:leagueId/financial", financialRoutes);

// Direct convenience endpoints under /:leagueId
router.get("/:leagueId/payment-requirement", requireAuth, getPaymentRequirement);
router.post("/:leagueId/submit-payment", requireAuth, submitPayment);
router.post("/:leagueId/verify-payment", requireAuth, verifyPayment);
router.get("/:leagueId/settlement-plan", requireAuth, getSettlementPlan);
router.post(
  "/:leagueId/settle",
  requireAuth,
  requireRole(UserRole.ADMIN),
  executeSettlement
);
router.get(
  "/:leagueId/reconcile",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.MODERATOR),
  reconcileLeague
);

export default router;
