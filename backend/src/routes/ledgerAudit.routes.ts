import { Router } from "express";
import { authorizationRateLimiter } from "../middleware/rateLimiter.js";
import { getLedgerAuditReports } from "../controllers/ledgerAudit.controller.js";
import { requireAuth, requireCurrentRole } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";

const router = Router();

router.use(authorizationRateLimiter, requireAuth, requireCurrentRole(UserRole.ADMIN, UserRole.MODERATOR));
router.get("/", getLedgerAuditReports);

export default router;
