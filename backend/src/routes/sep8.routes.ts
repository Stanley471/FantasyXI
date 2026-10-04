import { Router } from "express";
import { getStellarToml, submitKycData, getKycStatus, txApprove } from "../controllers/sep8Controller.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

// SEP-1 / SEP-8 discovery
router.get("/.well-known/stellar.toml", getStellarToml);

// SEP-8 authorization server endpoint (Stellar sends TX here)
router.post("/tx_approve", txApprove);
router.get("/tx_approve", txApprove);

// KYC Endpoints for UI
router.post("/kyc", requireAuth, submitKycData);
router.get("/kyc/status", requireAuth, getKycStatus);

export default router;
