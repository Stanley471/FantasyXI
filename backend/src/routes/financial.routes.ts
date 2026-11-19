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
import { requireAuth, requirePermission, requireCurrentRole } from "../middleware/authMiddleware.js";
import { Permission, UserRole } from "../types/index.js";
import {
  financialRateLimiter,
  mutationRateLimiter,
  walletVerificationRateLimiter,
} from "../middleware/rateLimiter.js";
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

router.post(
  "/simulate-deposit",
  mutationRateLimiter,
  requirePermission(Permission.PAYMENT_MANAGE_OWN),
  simulateDeposit
);
router.post("/settle", requireCurrentRole(UserRole.ADMIN), executeSettlement);
router.get("/requirement", requirePermission(Permission.PAYMENT_MANAGE_OWN), getPaymentRequirement);
router.post("/submit", mutationRateLimiter, walletVerificationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), depositRangeProof, submitPayment);
router.post("/verify", mutationRateLimiter, walletVerificationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), verifyPayment);
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
router.get("/storage-rent/status", requireCurrentRole(UserRole.ADMIN), getStorageRentStatus);
router.post("/storage-rent/recover", mutationRateLimiter, requireCurrentRole(UserRole.ADMIN), triggerStorageRentRecovery);
// Merkle tree settlement
router.post("/merkle-settle", requireCurrentRole(UserRole.ADMIN), executeMerkleSettlementHandler);

// Payment dispute workflows & automated escrow freezes
router.post("/disputes", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), fileDisputeHandler);
router.get("/disputes", requirePermission(Permission.PAYMENT_MANAGE_OWN), getLeagueDisputesHandler);
router.post("/disputes/:disputeId/evidence", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), addEvidenceHandler);
router.post("/disputes/:disputeId/resolve-payout", requireCurrentRole(UserRole.ADMIN), resolveDisputePayoutHandler);
router.post("/disputes/:disputeId/resolve-refund", requireCurrentRole(UserRole.ADMIN), resolveDisputeRefundHandler);
router.post("/disputes/:disputeId/reject", requireCurrentRole(UserRole.ADMIN), rejectDisputeHandler);

export default router;
