import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth, requirePermission } from "../middleware/authMiddleware.js";
import { Permission } from "../config/permissions.js";
import { authenticatedRateLimiter } from "../middleware/rateLimiter.js";
import { privacyService } from "../services/privacy/privacyService.js";
const router = Router();
// Bound unauthenticated probes before JWT/session/tombstone database checks.
router.use(rateLimit({windowMs:60_000,max:60,standardHeaders:true,legacyHeaders:false}));
router.use(requireAuth, authenticatedRateLimiter, requirePermission(Permission.PROFILE_UPDATE_OWN));
router.post("/exports", async (req,res) => {
  try { res.status(202).json({ success:true, data:await privacyService.request(req.user!.id,"EXPORT",req.body?.publicKey) }); }
  catch { res.status(400).json({ success:false, message:"Invalid public key, unavailable account, or an existing pending request." }); }
});
router.post("/erasure", async (req,res) => {
  if (req.body?.confirmation !== "DELETE MY ACCOUNT") { res.status(400).json({ success:false, message:"Account-erasure confirmation is required." }); return; }
  res.status(202).json({ success:true, data:await privacyService.request(req.user!.id,"ERASE") });
});
router.get("/requests/:id", async (req,res) => {
  if (!/^[a-f0-9-]{36}$/i.test(req.params.id as string)) { res.status(404).json({ success:false }); return; }
  res.setHeader("Cache-Control","no-store");
  const data = await privacyService.status(req.user!.id,req.params.id as string);
  res.status(data ? 200 : 404).json({ success:!!data,data });
});
export default router;
