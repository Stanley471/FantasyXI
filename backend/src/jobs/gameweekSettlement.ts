import { prisma } from "../config/db.js";
import { fplSyncService } from "../services/fpl/fplSyncService.js";
import { eventBus, publishOrThrow } from "../services/events/eventBus.js";
import { GAMEWEEK_UPDATED_EVENT } from "../services/events/domainEvents.js";
// Imported for its side effect: subscribes the scoring, free-hit and league
// settlement handlers to GAMEWEEK_UPDATED_EVENT (issue #118). This job no
// longer needs to know which services react to a gameweek update.
import "../services/events/gameweekEventHandlers.js";

/**
 * A gameweek can be settled once all its fixtures are finished.
 * FPL only sets `finished` after bonus points are confirmed
 * (`finished_provisional` covers the pre-bonus state).
 */
export function isGameweekReadyForSettlement(fixtures: Array<{ finished: boolean }>): boolean {
  return fixtures.length > 0 && fixtures.every((f) => f.finished);
}

/**
 * Settles one gameweek: final stats sync, squad scores (auto-subs and chips applied),
 * Free Hit reverts, H2H results and completion of leagues ending this gameweek.
 * Every step is idempotent, so a retried job does not double count.
 *
 * The scoring, free-hit-revert and league-settlement steps are no longer
 * called directly (issue #118): this job publishes a single
 * GAMEWEEK_UPDATED_EVENT and the independent subscribers registered in
 * services/events/gameweekEventHandlers.ts react to it. `publishOrThrow` is
 * used (rather than a bare `eventBus.publish`) because settlement must not be
 * marked finished unless every subscriber actually completed - a retried
 * pg-boss job re-publishes the same event and all steps are idempotent.
 */
export async function settleGameweek(gameweekId: number): Promise<void> {
  const gameweek = await prisma.gameweek.findUniqueOrThrow({
    where: { id: gameweekId },
  });

  await fplSyncService.syncGameweekLiveStats(gameweek.fplId);

  await publishOrThrow(eventBus, GAMEWEEK_UPDATED_EVENT, {
    gameweekId,
    gameweekFplId: gameweek.fplId,
  });

  await prisma.gameweek.update({
    where: { id: gameweekId },
    data: { isFinished: true, settledAt: new Date() },
  });
}

/**
 * Gameweek Completion & Settlement Job.
 * Settles every locked, unsettled gameweek whose fixtures are all finished.
 */
export async function settleCompletedGameweeks(): Promise<number[]> {
  const gameweeks = await prisma.gameweek.findMany({
    where: { isLocked: true, settledAt: null },
    include: { fixtures: { select: { finished: true } } },
    orderBy: { id: "asc" },
  });

  const settled: number[] = [];
  for (const gw of gameweeks) {
    if (isGameweekReadyForSettlement(gw.fixtures)) {
      await settleGameweek(gw.id);
      settled.push(gw.id);
    }
  }
  return settled;
}
