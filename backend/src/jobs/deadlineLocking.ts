import { prisma } from "../config/db.js";
import { primeProvisionalLeaderboard } from "../services/live/liveProvisionalLeaderboard.js";

/** Squads lock this many minutes before the first kickoff of a gameweek. */
export const LOCK_LEAD_MINUTES = 90;

export function computeLockTime(firstKickoff: Date): Date {
  return new Date(firstKickoff.getTime() - LOCK_LEAD_MINUTES * 60_000);
}

/**
 * Deadline Locking Job.
 *
 * Locks every unfinished gameweek whose first kickoff is at most 90 minutes away.
 * While a gameweek is locked and not yet settled, squad updates and chips are rejected.
 * Returns the IDs of the gameweeks locked by this run.
 */
export async function lockDueGameweeks(now: Date = new Date()): Promise<number[]> {
  const gameweeks = await prisma.gameweek.findMany({
    where: { isLocked: false, isFinished: false },
    include: {
      fixtures: {
        where: { kickoffTime: { not: null } },
        orderBy: { kickoffTime: "asc" },
        take: 1,
      },
    },
  });

  const locked: number[] = [];
  for (const gw of gameweeks) {
    const firstKickoff = gw.fixtures[0]?.kickoffTime;
    if (firstKickoff && now.getTime() >= computeLockTime(firstKickoff).getTime()) {
      await prisma.gameweek.update({
        where: { id: gw.id },
        data: { isLocked: true },
      });
      locked.push(gw.id);

      // Squads are frozen now, so seed the live provisional leaderboard (issue #268).
      // Best effort: live ranks are a convenience and must never block locking.
      try {
        await primeProvisionalLeaderboard(gw.id);
      } catch (err) {
        console.warn(`Failed to prime provisional leaderboard for gameweek ${gw.id}:`, err);
      }
    }
  }
  return locked;
}
