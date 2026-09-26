import { Router } from "express";
import {
  getPaymentRequirement,
  submitPayment,
  verifyPayment,
  getSettlementPlan,
  executeSettlement,
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
router.get("/settlement-plan", getSettlementPlan);
router.post("/settle", requireRole(UserRole.ADMIN), executeSettlement);
router.get("/affiliate-dashboard", getAffiliateDashboard);

// Reconciliation exposes sensitive league financial reports and is restricted
// to ADMIN / MODERATOR roles via RBAC.
router.get("/reconcile", requireRole(UserRole.ADMIN, UserRole.MODERATOR), reconcileLeague);

export default router;

