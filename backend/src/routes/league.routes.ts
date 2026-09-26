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
  createLeagueInvitation,
  listLeagueInvitations,
  revokeLeagueInvitation,
  previewLeagueInvitation,
  acceptLeagueInvitation,
} from "../controllers/league.controller.js";
import { requireAuth, requirePermission, optionalAuth } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";
import { primaryReads } from "../middleware/readConsistency.js";

const router = Router();

// POST /api/v1/leagues (Protected: creator identity derived from token)
router.post("/", requireAuth, requirePermission(Permission.LEAGUE_CREATE), createLeague);

// GET /api/v1/leagues (Public: search leagues; private leagues only for creator/members)
router.get("/", optionalAuth, getLeagues);

// GET /api/v1/leagues/invitations/:token (Public: preview the league behind an invite link)
router.get("/invitations/:token", primaryReads, previewLeagueInvitation);

// POST /api/v1/leagues/invitations/:token/accept (Protected: redeem a single-use invite)
router.post(
  "/invitations/:token/accept",
  requireAuth,
  requirePermission(Permission.LEAGUE_JOIN),
  acceptLeagueInvitation
);

// GET /api/v1/leagues/:id (Public: view league details; invite code only for creator)
router.get("/:id", optionalAuth, getLeagueById);

// POST /api/v1/leagues/:id/join (Protected: member identity derived from token)
router.post("/:id/join", requireAuth, requirePermission(Permission.LEAGUE_JOIN), joinLeague);

// GET /api/v1/leagues/:id/members (Public: view league member list)
router.get("/:id/members", getLeagueMembers);

// GET /api/v1/leagues/:id/standings (Public: view league standings)
router.get("/:id/standings", getLeagueStandings);

// GET /api/v1/leagues/:id/h2h-standings (Public: head-to-head league table)
router.get("/:id/h2h-standings", getH2HStandings);

// POST /api/v1/leagues/:id/cancel (Protected: creator only)
router.post("/:id/cancel", requireAuth, requirePermission(Permission.LEAGUE_CANCEL_OWN), cancelLeague);

// Private league invitations (Protected: creator only)
router.post(
  "/:id/invitations",
  requireAuth,
  requirePermission(Permission.LEAGUE_MANAGE_OWN),
  createLeagueInvitation
);
router.get(
  "/:id/invitations",
  primaryReads,
  requireAuth,
  requirePermission(Permission.LEAGUE_MANAGE_OWN),
  listLeagueInvitations
);
router.delete(
  "/:id/invitations/:invitationId",
  requireAuth,
  requirePermission(Permission.LEAGUE_MANAGE_OWN),
  revokeLeagueInvitation
);

// ============================================================
// Financial & Stellar Escrow Routes
// ============================================================
import financialRoutes from "./financial.routes.js";
import {
  getPaymentRequirement,
  submitPayment,
  verifyPayment,
  getSettlementPlan,
  reconcileLeague,
} from "../controllers/financial.controller.js";

// Financial reads feed payment decisions (and the payment requirement creates the
// membership), so they are always served by the primary, never a replica.

// Nested router under /:leagueId/financial
router.use("/:leagueId/financial", primaryReads, financialRoutes);

// Direct convenience endpoints under /:leagueId
router.get(
  "/:leagueId/payment-requirement",
  primaryReads,
  requireAuth,
  requirePermission(Permission.PAYMENT_MANAGE_OWN),
  getPaymentRequirement
);
router.post(
  "/:leagueId/submit-payment",
  requireAuth,
  requirePermission(Permission.PAYMENT_MANAGE_OWN),
  submitPayment
);
router.post(
  "/:leagueId/verify-payment",
  requireAuth,
  requirePermission(Permission.PAYMENT_MANAGE_OWN),
  verifyPayment
);
router.get(
  "/:leagueId/settlement-plan",
  primaryReads,
  requireAuth,
  requirePermission(Permission.SETTLEMENT_READ),
  getSettlementPlan
);
router.get(
  "/:leagueId/reconcile",
  primaryReads,
  requireAuth,
  requirePermission(Permission.FINANCIAL_RECONCILE),
  reconcileLeague
);

export default router;

