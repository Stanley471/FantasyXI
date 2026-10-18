import { Request, Response } from "express";
import { fplClient, FplClient } from "../services/fpl/fplClient.js";

/**
 * FPL upstream resilience telemetry (issue #275).
 *
 * Exposes the FPL client's circuit breaker state and lifetime counters,
 * per-tier cache hit/fallback counts and whether FPL-derived data is
 * currently being served stale, so operators can see an upstream outage
 * (and the platform riding it out on cached data) at a glance.
 */
export function createFplTelemetryHandler(client: Pick<FplClient, "getTelemetry"> = fplClient) {
  return (_req: Request, res: Response): void => {
    res.json({
      success: true,
      data: client.getTelemetry(),
      timestamp: new Date().toISOString(),
    });
  };
}

export const getFplTelemetry = createFplTelemetryHandler();
