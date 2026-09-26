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
import { requireAuth, requireRole, optionalAuth } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";
import { primaryReads } from "../middleware/readConsistency.js";

const router = Router();

// POST /api/v1/leagues (Protected: creator identity derived from token)
router.post("/", requireAuth, createLeague);

// GET /api/v1/leagues (Public: search leagues; private leagues only for creator/members)
router.get("/", optionalAuth, getLeagues);

// GET /api/v1/leagues/invitations/:token (Public: preview the league behind an invite link)
router.get("/invitations/:token", primaryReads, previewLeagueInvitation);

// POST /api/v1/leagues/invitations/:token/accept (Protected: redeem a single-use invite)
router.post("/invitations/:token/accept", requireAuth, acceptLeagueInvitation);

// GET /api/v1/leagues/:id (Public: view league details; invite code only for creator)
router.get("/:id", optionalAuth, getLeagueById);

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

// Private league invitations (Protected: creator only)
router.post("/:id/invitations", requireAuth, createLeagueInvitation);
router.get("/:id/invitations", primaryReads, requireAuth, listLeagueInvitations);
router.delete("/:id/invitations/:invitationId", requireAuth, revokeLeagueInvitation);

// ============================================================
// Financial & Stellar Escrow Routes
// ============================================================
import financialRoutes from "./financial.routes.js";
import {
  getPaymentRequirement,
  submitPayment,
  verifyPayment,
  reconcileDeposit,
  getSettlementPlan,
  reconcileLeague,
} from "../controllers/financial.controller.js";

// Financial reads feed payment decisions (and the payment requirement creates the
// membership), so they are always served by the primary, never a replica.

// Nested router under /:leagueId/financial
router.use("/:leagueId/financial", primaryReads, financialRoutes);

// Direct convenience endpoints under /:leagueId
router.get("/:leagueId/payment-requirement", primaryReads, requireAuth, getPaymentRequirement);
router.post("/:leagueId/submit-payment", requireAuth, submitPayment);
router.post("/:leagueId/verify-payment", requireAuth, verifyPayment);
router.post("/:leagueId/reconcile-deposit", requireAuth, reconcileDeposit);
router.get("/:leagueId/settlement-plan", primaryReads, requireAuth, getSettlementPlan);
router.get(
  "/:leagueId/reconcile",
  primaryReads,
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.MODERATOR),
  reconcileLeague
);

export default router;

