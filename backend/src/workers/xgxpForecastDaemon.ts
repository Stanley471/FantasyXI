/**
 * xG/xP Forecast Daemon Worker
 *
 * Extends the FPL tracking daemon to trigger xG/xP forecast recalculation on:
 * 1. Injury or fixture-change events (targeted invalidation)
 * 2. Periodic schedule (full batch recomputation)
 *
 * Design:
 * - Listens for 'player:injury_update' events from fplTrackingDaemon
 * - Detects fixture rescheduling via periodic sync monitoring
 * - Invalidates affected player forecasts immediately
 * - Schedules periodic batch recomputation (default: every 6 hours)
 * - Ensures non-overlapping runs with a simple flag
 * - Failed runs retain previous forecasts (no-retry on failure for batch)
 * - All computation runs within a 10-second time budget
 *
 * Event-driven pattern:
 * - Imports fplTrackingDaemon singleton to register injury_update listeners
 * - Similar structure to existing gameweekEventHandlers.ts
 */

import { prisma } from "../config/db.js";
import { fplTrackingDaemon, InjuryUpdateEvent } from "./fplTrackingDaemon.js";
import { xgxpForecastService } from "../services/fpl/xgxpForecastService.js";
import { logger } from "../config/logger.js";

export interface XGXPForecastDaemonOptions {
  db?: typeof prisma;
  pollIntervalMs?: number; // Interval for periodic batch recomputation (default 6 hours)
  maxRunDurationMs?: number; // Max time per batch run (default 10 seconds)
}

export class XGXPForecastDaemon {
  private readonly db: typeof prisma;
  private readonly pollIntervalMs: number;
  private readonly maxRunDurationMs: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private batchRunInProgress = false;

  constructor(options: XGXPForecastDaemonOptions = {}) {
    this.db = options.db ?? prisma;
    this.pollIntervalMs = options.pollIntervalMs ?? 6 * 60 * 60 * 1000; // 6 hours
    this.maxRunDurationMs = options.maxRunDurationMs ?? 10_000; // 10 seconds
  }

  /**
   * Starts the daemon:
   * 1. Registers listener for injury/status change events
   * 2. Schedules periodic batch recomputation
   */
  public start(): void {
    if (this.running) return;
    this.running = true;

    // Register listeners for injury updates
    fplTrackingDaemon.events.on("player:injury_update", (evt: InjuryUpdateEvent) => {
      void this.handleInjuryUpdate(evt);
    });

    // Schedule periodic batch recomputation
    this.schedule(0);
    logger.info("[xgxp-daemon] xG/xP forecast daemon started");
  }

  /**
   * Stops the daemon and cancels scheduled work.
   */
  public stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    logger.info("[xgxp-daemon] xG/xP forecast daemon stopped");
  }

  /**
   * Handles injury/status change event from tracking daemon.
   * Immediately invalidates affected player forecasts for upcoming gameweeks.
   */
  private async handleInjuryUpdate(evt: InjuryUpdateEvent): Promise<void> {
    try {
      logger.debug(`[xgxp-daemon] Injury update for player ${evt.playerId}: ${evt.status}`);

      // Find current and upcoming gameweeks
      const now = new Date();
      const upcomingGameweeks = await this.db.gameweek.findMany({
        where: {
          deadline: { gt: now }, // Only future gameweeks
        },
        select: { id: true, deadline: true },
        orderBy: { deadline: "asc" },
        take: 5, // Invalidate next 5 gameweeks only
      });

      if (upcomingGameweeks.length === 0) {
        logger.debug(`[xgxp-daemon] No upcoming gameweeks for injury invalidation`);
        return;
      }

      // Invalidate forecasts for this player across all upcoming gameweeks
      for (const gw of upcomingGameweeks) {
        await xgxpForecastService.invalidatePlayerForecasts(gw.id, [evt.playerId]);
      }

      logger.info(
        `[xgxp-daemon] Invalidated forecasts for player ${evt.playerId} across ${upcomingGameweeks.length} gameweeks`
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, "[xgxp-daemon] Error handling injury update");
    }
  }

  /**
   * Periodic batch recomputation of all active forecasts.
   * Called every pollIntervalMs (default 6 hours).
   */
  private async runBatchRecomputation(): Promise<void> {
    if (this.batchRunInProgress) {
      logger.info("[xgxp-daemon] Batch recomputation already in progress, skipping");
      return;
    }

    this.batchRunInProgress = true;
    try {
      logger.info("[xgxp-daemon] Starting periodic batch recomputation");
      const startTime = Date.now();

      // Find current and next gameweek
      const now = new Date();
      const currentGameweek = await this.db.gameweek.findFirst({
        where: {
          deadline: { gt: now },
          isFinished: false,
        },
        orderBy: { deadline: "asc" },
      });

      if (!currentGameweek) {
        logger.warn("[xgxp-daemon] No active gameweek found for forecasting");
        this.batchRunInProgress = false;
        return;
      }

      // Recompute forecasts for current gameweek
      const result = await xgxpForecastService.computeBatchForGameweek(
        currentGameweek.id,
        this.maxRunDurationMs
      );

      const elapsed = Date.now() - startTime;
      logger.info(
        `[xgxp-daemon] Batch recomputation completed: ${result.playersCount} players in ${elapsed}ms`
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        "[xgxp-daemon] Batch recomputation failed, retaining previous forecasts"
      );
    } finally {
      this.batchRunInProgress = false;
    }
  }

  /**
   * Schedules the next batch recomputation.
   */
  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  /**
   * Main tick: runs batch recomputation and reschedules.
   */
  private async tick(): Promise<void> {
    try {
      await this.runBatchRecomputation();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "[xgxp-daemon] Tick error");
    } finally {
      this.schedule(this.pollIntervalMs);
    }
  }
}

// Singleton instance
export const xgxpForecastDaemon = new XGXPForecastDaemon();

// Auto-register handlers on import (similar to gameweekEventHandlers.ts pattern)
let registeredOnStart = false;

/**
 * Ensures daemon is started only once globally.
 * Call this during application startup.
 */
export function ensureXGXPForecastDaemonStarted(): void {
  if (!registeredOnStart) {
    registeredOnStart = true;
    xgxpForecastDaemon.start();
  }
}

export default xgxpForecastDaemon;
