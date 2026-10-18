import { Request, Response, NextFunction, RequestHandler } from "express";
import { fplClient as defaultFplClient, FplClient } from "../services/fpl/fplClient.js";
import { CircuitState } from "../services/fpl/circuitBreaker.js";

/**
 * Marks responses built from FPL-derived data as possibly stale while the FPL
 * upstream is degraded (issue #275): the circuit breaker is not CLOSED, or the
 * client recently had to serve a fallback tier. Player, fixture, gameweek and
 * live endpoints keep answering from cached/stored data instead of failing,
 * and these headers let clients show a "data may be delayed" notice.
 *
 *   X-Data-Stale: true
 *   X-Data-Stale-Reason: circuit-open | circuit-half-open | stale-memory | stale-redis | stale-snapshot
 *   X-Data-Stale-Since: <ISO timestamp the served data was fetched upstream>
 */
export function createFplDataFreshness(client: Pick<FplClient, "getFreshnessStatus"> = defaultFplClient): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    const status = client.getFreshnessStatus();
    if (status.stale) {
      res.setHeader("X-Data-Stale", "true");
      const reason =
        status.circuitState === CircuitState.OPEN
          ? "circuit-open"
          : status.circuitState === CircuitState.HALF_OPEN
            ? "circuit-half-open"
            : status.lastStaleSource ?? "degraded";
      res.setHeader("X-Data-Stale-Reason", reason);
      if (status.staleSince) {
        res.setHeader("X-Data-Stale-Since", status.staleSince.toISOString());
      }
    }
    next();
  };
}

export const fplDataFreshness = createFplDataFreshness();
