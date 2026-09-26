import { Router } from "express";
import {
  getPaymentRequirement,
  submitPayment,
  verifyPayment,
  reconcileDeposit,
  getSettlementPlan,
  reconcileLeague,
  getAffiliateDashboard,
} from "../controllers/financial.controller.js";
import { requireAuth, requireRole } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";

const router = Router({ mergeParams: true });

// All financial actions require valid JWT authentication
router.use(requireAuth);

router.get("/requirement", getPaymentRequirement);
router.post("/submit", submitPayment);
router.post("/verify", verifyPayment);
// Self-service recovery: checks the escrow contract directly for the caller's own
// deposit when the wallet's success callback never reached submit/verify above.
router.post("/reconcile-deposit", reconcileDeposit);
router.get("/settlement-plan", getSettlementPlan);
router.get("/affiliate-dashboard", getAffiliateDashboard);

// Reconciliation exposes sensitive league financial reports and is restricted
// to ADMIN / MODERATOR roles via RBAC.
router.get("/reconcile", requireRole(UserRole.ADMIN, UserRole.MODERATOR), reconcileLeague);

export default router;

