import { Router } from "express";
import { getLedgerAuditReports } from "../controllers/ledgerAudit.controller.js";
import { requireAuth, requireRole } from "../middleware/authMiddleware.js";
import { UserRole } from "../types/index.js";

const router = Router();

router.use(requireAuth, requireRole(UserRole.ADMIN, UserRole.MODERATOR));
router.get("/", getLedgerAuditReports);

export default router;
