import { Router } from "express";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../config/permissions.js";
import { financialMerkleService } from "../services/audit/financialMerkleService.js";
import { prisma } from "../config/db.js";
import { authorizationRateLimiter, mutationRateLimiter } from "../middleware/rateLimiter.js";
const router = Router();
// Bound public reads and anonymous authorization probes before database work.
router.use(authorizationRateLimiter);
router.get("/roots", async (_req,res) => {
  const roots = await prisma.$queryRaw`SELECT hour,first_sequence::text,last_sequence::text,entry_count,root,receipt,published_at FROM financial_merkle_roots ORDER BY hour DESC LIMIT 100`;
  res.json({ success: true, data: roots });
});
router.use(requireAuth, requirePermission(Permission.FINANCIAL_AUDIT_READ));
router.post("/verify", mutationRateLimiter, async (_req,res) => {
  const entries = await financialMerkleService.verify(); res.json({ success: true, verified: entries.length });
});
router.get("/transactions/:transactionId/proof", async (req,res) => {
  const data = await financialMerkleService.proof(req.params.transactionId as string);
  res.status(data.length ? 200 : 404).json({ success: data.length > 0, data, message: data.length ? undefined : "No published audit proof yet." });
});
export default router;
