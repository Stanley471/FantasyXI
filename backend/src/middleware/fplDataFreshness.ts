import { Request, Response, NextFunction } from "express";
import { fplClient, FplClient } from "../services/fpl/fplClient.js";

/**
 * Flags responses built from FPL-synced data with `X-Data-Stale: true` while
 * the FPL circuit breaker is not CLOSED (issue #275): the endpoint still
 * answers from the database or the stale cache tiers instead of failing, and
 * clients can tell that the numbers may lag the official game.
 */
export function createFplDataFreshness(client: Pick<FplClient, "isDegraded"> = fplClient) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (client.isDegraded()) {
      res.setHeader("X-Data-Stale", "true");
    }
    next();
  };
}

export const fplDataFreshness = createFplDataFreshness();
