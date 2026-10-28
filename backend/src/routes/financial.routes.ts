import { Router } from "express";
import {
  getPaymentRequirement,
  simulateDeposit,
  submitPayment,
  verifyPayment,
  reconcileDeposit,
  getSettlementPlan,
  executeSettlement,
  reconcileLeague,
  getAffiliateDashboard,
  getStorageRentStatus,
  triggerStorageRentRecovery,
  fileDisputeHandler,
  getLeagueDisputesHandler,
  addEvidenceHandler,
  resolveDisputePayoutHandler,
  resolveDisputeRefundHandler,
  rejectDisputeHandler,
  executeMerkleSettlementHandler,
} from "../controllers/financial.controller.js";
import { requireAuth, requirePermission, requireRole } from "../middleware/authMiddleware.js";
import { Permission, UserRole } from "../types/index.js";
import { financialRateLimiter, mutationRateLimiter } from "../middleware/rateLimiter.js";
import { idempotency } from "../middleware/idempotency.js";
import { requireDepositRangeProof } from "../middleware/depositRangeProof.js";
import { getMyDepositExceptions, getDepositRefundChallenge, submitDepositRefundClaim } from "../controllers/depositRefund.controller.js";

const router = Router({ mergeParams: true });
// Private high-roller leagues require a ZK buy-in range proof with each deposit
const depositRangeProof = requireDepositRangeProof();

// All financial actions require valid JWT authentication and are protected by financial rate limits
router.use(requireAuth);
router.use(financialRateLimiter);
// Mutations honour the Idempotency-Key header (GET requests pass through)
router.use(idempotency);

router.get("/requirement", getPaymentRequirement);
router.post(
  "/simulate-deposit",
  mutationRateLimiter,
  requirePermission(Permission.PAYMENT_MANAGE_OWN),
  simulateDeposit
);
router.post("/submit", depositRangeProof, submitPayment);
router.post("/verify", verifyPayment);
router.get("/settlement-plan", getSettlementPlan);
router.post("/settle", requireRole(UserRole.ADMIN), executeSettlement);
router.get("/affiliate-dashboard", getAffiliateDashboard);
router.get("/requirement", requirePermission(Permission.PAYMENT_MANAGE_OWN), getPaymentRequirement);
router.post("/submit", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), depositRangeProof, submitPayment);
router.post("/verify", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), verifyPayment);
router.get("/settlement-plan", requirePermission(Permission.SETTLEMENT_READ), getSettlementPlan);
router.get("/affiliate-dashboard", requirePermission(Permission.AFFILIATE_READ_OWN), getAffiliateDashboard);
// Self-service recovery: checks the escrow contract directly for the caller's own
// deposit when the wallet's success callback never reached submit/verify above.
router.post("/reconcile-deposit", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), reconcileDeposit);
router.get("/refund-claim/:txHash/challenge", requirePermission(Permission.PAYMENT_MANAGE_OWN), getDepositRefundChallenge);
router.get("/refund-claim/exceptions", requirePermission(Permission.PAYMENT_MANAGE_OWN), getMyDepositExceptions);
router.post("/refund-claim", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), submitDepositRefundClaim);

// Reconciliation exposes sensitive league financial reports and requires the
// financial:reconcile permission (ADMIN, MODERATOR and SERVICE roles).
router.get("/reconcile", requirePermission(Permission.FINANCIAL_RECONCILE), reconcileLeague);

// Soroban contract storage rent & archival recovery (Issue #337)
router.get("/storage-rent/status", requireRole(UserRole.ADMIN), getStorageRentStatus);
router.post("/storage-rent/recover", mutationRateLimiter, requireRole(UserRole.ADMIN), triggerStorageRentRecovery);
// Merkle tree settlement
router.post("/merkle-settle", requireRole(UserRole.ADMIN), executeMerkleSettlementHandler);

// Payment dispute workflows & automated escrow freezes
router.post("/disputes", mutationRateLimiter, fileDisputeHandler);
router.get("/disputes", getLeagueDisputesHandler);
router.post("/disputes/:disputeId/evidence", mutationRateLimiter, addEvidenceHandler);
router.post("/disputes/:disputeId/resolve-payout", requireRole(UserRole.ADMIN), resolveDisputePayoutHandler);
router.post("/disputes/:disputeId/resolve-refund", requireRole(UserRole.ADMIN), resolveDisputeRefundHandler);
router.post("/disputes/:disputeId/reject", requireRole(UserRole.ADMIN), rejectDisputeHandler);

export default router;
