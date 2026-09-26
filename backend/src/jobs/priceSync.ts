import { prisma } from "../config/db.js";
import { fplSyncService } from "../services/fpl/fplSyncService.js";

/**
 * Daily Player Price Synchronization Job.
 *
 * FPL player prices move daily based on transfer market activity. This job
 * pulls the latest bootstrap-static snapshot (which carries each player's
 * current price) into the `Player` table. It never mutates a squad's stored
 * bank balance — only a transfer moves `Squad.budgetRemaining` — but once
 * prices are synced, `SquadService.getSquadValuation` derives each squad's
 * live team value (bank + current selling price of every owned player) on
 * demand, so callers immediately see today's fluctuations.
 */

export interface PriceSyncResult {
  playersUpdated: number;
  squadsAffected: number;
}

/**
 * Syncs today's FPL player prices. Returns how many players changed and how
 * many existing squads own at least one player, for observability/logging.
 */
export async function syncDailyPlayerPrices(): Promise<PriceSyncResult> {
  const { playersCount } = await fplSyncService.syncBootstrap();
  const squadsAffected = await prisma.squad.count();
  return { playersUpdated: playersCount, squadsAffected };
}
