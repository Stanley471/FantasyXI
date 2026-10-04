import { Router } from "express";
import {
  getPaymentRequirement,
  submitPayment,
  verifyPayment,
  reconcileDeposit,
  getSettlementPlan,
  executeSettlement,
  reconcileLeague,
  getAffiliateDashboard,
} from "../controllers/financial.controller.js";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../types/index.js";
import { financialRateLimiter, mutationRateLimiter } from "../middleware/rateLimiter.js";

const router = Router({ mergeParams: true });

// All financial actions require valid JWT authentication and are protected by financial rate limits
router.use(requireAuth);
router.use(financialRateLimiter);

router.get("/requirement", getPaymentRequirement);
router.post("/submit", submitPayment);
router.post("/verify", verifyPayment);
router.get("/settlement-plan", getSettlementPlan);
router.post("/settle", requireRole(UserRole.ADMIN), executeSettlement);
router.get("/affiliate-dashboard", getAffiliateDashboard);
router.get("/requirement", requirePermission(Permission.PAYMENT_MANAGE_OWN), getPaymentRequirement);
router.post("/submit", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), submitPayment);
router.post("/verify", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), verifyPayment);
router.get("/settlement-plan", requirePermission(Permission.SETTLEMENT_READ), getSettlementPlan);
router.get("/affiliate-dashboard", requirePermission(Permission.AFFILIATE_READ_OWN), getAffiliateDashboard);
// Self-service recovery: checks the escrow contract directly for the caller's own
// deposit when the wallet's success callback never reached submit/verify above.
router.post("/reconcile-deposit", mutationRateLimiter, requirePermission(Permission.PAYMENT_MANAGE_OWN), reconcileDeposit);

// Reconciliation exposes sensitive league financial reports and requires the
// financial:reconcile permission (ADMIN, MODERATOR and SERVICE roles).
router.get("/reconcile", requirePermission(Permission.FINANCIAL_RECONCILE), reconcileLeague);

export default router;
