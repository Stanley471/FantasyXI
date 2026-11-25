import { lockDueGameweeks } from "./deadlineLocking.js";
import { ownershipStatsService } from "../services/analytics/ownershipStatsService.js";

/**
 * Locks due gameweeks and, whenever a gameweek was just locked, immediately
 * recomputes platform-wide ownership/captaincy stats so the cache reflects
 * squads exactly as they stood at the deadline (issue #499). Runs as part of
 * the existing minute-granularity "deadline-lock" cron job, well inside the
 * 30-second accuracy window the aggregate queries themselves take.
 */
export async function lockDueGameweeksAndRefreshOwnership(
  now: Date = new Date()
): Promise<{ locked: number[]; ownershipRefreshed: boolean }> {
  const locked = await lockDueGameweeks(now);
  if (locked.length > 0) {
    await ownershipStatsService.computeAndCache();
  }
  return { locked, ownershipRefreshed: locked.length > 0 };
}
