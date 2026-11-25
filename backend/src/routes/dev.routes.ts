import { NextFunction, Request, Response, Router } from "express";
import { financialRateLimiter } from "../middleware/rateLimiter.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  createTestnetFaucetService,
  FaucetError,
  isFaucetAllowed,
  type TestnetFaucetService,
} from "../services/financial/testnetFaucetService.js";

/**
 * Development-only helpers, mounted at /api/dev (issue #558).
 * Every route 404s in production, as if it did not exist.
 */

/** Evaluated per request so the guard cannot be bypassed by a stale mount-time check. */
export function devOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isFaucetAllowed()) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  next();
}

export function createFundStellarAccountHandler(
  getFaucet: () => Promise<TestnetFaucetService> = createTestnetFaucetService
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { address?: unknown; generate?: unknown };
      const address = typeof body.address === "string" ? body.address.trim() : undefined;
      const result = await (await getFaucet()).fund({ address, generate: body.generate === true });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      if (error instanceof FaucetError) {
        res.status(error.status).json({ success: false, error: error.message });
        return;
      }
      console.error("[dev-faucet] Funding failed:", (error as Error).message);
      res.status(500).json({ success: false, error: "Failed to fund Stellar account" });
    }
  };
}

const router = Router();

router.use(devOnly);
// Friendbot and Horizon are called per request, so cap the rate per client.
router.use(financialRateLimiter);
router.post("/fund-stellar-account", requireAuth, createFundStellarAccountHandler());

export default router;
