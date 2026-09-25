import { Router } from "express";
import {
  getPaymentRequirement,
  submitPayment,
  verifyPayment,
  getSettlementPlan,
  reconcileLeague,
  getAffiliateDashboard,
} from "../controllers/financial.controller.js";
import { requireAuth, requireRole } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";
import { authenticatedRateLimiter, mutationRateLimiter } from "../middleware/rateLimiter.js";

const router = Router({ mergeParams: true });

// All financial actions require valid JWT authentication
router.use(requireAuth, authenticatedRateLimiter);

router.get("/requirement", getPaymentRequirement);
router.post("/submit", mutationRateLimiter, submitPayment);
router.post("/verify", mutationRateLimiter, verifyPayment);
router.get("/settlement-plan", getSettlementPlan);
router.get("/affiliate-dashboard", getAffiliateDashboard);

// Reconciliation exposes sensitive league financial reports and is restricted
// to ADMIN / MODERATOR roles via RBAC.
router.get("/reconcile", requireRole(UserRole.ADMIN, UserRole.MODERATOR), reconcileLeague);

export default router;

