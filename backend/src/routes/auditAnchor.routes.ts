import { Request, Response, Router } from "express";
import { financialRateLimiter } from "../middleware/rateLimiter.js";
import {
  createGameweekAuditAnchorService,
  type GameweekAuditAnchorService,
} from "../services/financial/gameweekAuditAnchorService.js";

/**
 * Public audit anchor endpoints (issue #559). They expose only the digest,
 * the Stellar transaction and the verification result, never member data.
 */

type ServiceFactory = () => Promise<GameweekAuditAnchorService>;

export function createAuditAnchorRouter(getService: ServiceFactory = createGameweekAuditAnchorService): Router {
  const router = Router();
  // Public and each verify call reads Horizon, so cap the rate per client.
  router.use(financialRateLimiter);

  router.get("/gameweeks", async (_req: Request, res: Response) => {
    try {
      const receipts = await (await getService()).listReceipts();
      res.json({ success: true, data: receipts });
    } catch (error) {
      console.error("[audit-anchor] List failed:", (error as Error).message);
      res.status(500).json({ success: false, error: "Failed to load audit anchors" });
    }
  });

  /** Verifies the stored snapshot against the digest anchored on Stellar. */
  router.get("/gameweeks/:gameweek/verify", async (req: Request, res: Response) => {
    const gameweek = Number(req.params.gameweek);
    if (!Number.isInteger(gameweek) || gameweek <= 0) {
      res.status(400).json({ success: false, error: "Invalid gameweek" });
      return;
    }
    try {
      const result = await (await getService()).verify(gameweek);
      res.status(result.anchored ? 200 : 404).json({ success: result.anchored, data: result });
    } catch (error) {
      console.error("[audit-anchor] Verify failed:", (error as Error).message);
      res.status(500).json({ success: false, error: "Failed to verify audit anchor" });
    }
  });

  router.get("/gameweeks/:gameweek", async (req: Request, res: Response) => {
    const gameweek = Number(req.params.gameweek);
    if (!Number.isInteger(gameweek) || gameweek <= 0) {
      res.status(400).json({ success: false, error: "Invalid gameweek" });
      return;
    }
    try {
      const receipt = await (await getService()).getReceipt(gameweek);
      if (!receipt) {
        res.status(404).json({ success: false, error: "No audit anchor for this gameweek" });
        return;
      }
      res.json({ success: true, data: receipt });
    } catch (error) {
      console.error("[audit-anchor] Lookup failed:", (error as Error).message);
      res.status(500).json({ success: false, error: "Failed to load audit anchor" });
    }
  });

  return router;
}

export default createAuditAnchorRouter();
