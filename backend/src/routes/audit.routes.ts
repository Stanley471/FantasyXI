import { Router } from "express";
import { verifyPayoutAudit } from "../controllers/payoutAudit.controller.js";

const router = Router();
router.get("/payouts/verify", verifyPayoutAudit);
export default router;
