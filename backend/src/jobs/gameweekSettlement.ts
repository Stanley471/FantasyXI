import { prisma } from "../config/db.js";
import { LeagueStatus, MembershipStatus, ScoringType } from "../types/index.js";
import { fplSyncService } from "../services/fpl/fplSyncService.js";
import { leagueService, LeagueService } from "../services/league/leagueService.js";
import { eventBus, publishOrThrow } from "../services/events/eventBus.js";
import { GAMEWEEK_UPDATED_EVENT } from "../services/events/domainEvents.js";
import { gameweekOracleService } from "../services/financial/gameweekOracleService.js";
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

export type PlayoffAction =
  | { type: "none" }
  | { type: "generate" }
  | { type: "advance" };

/**
 * Pure decision of what (if anything) an H2H league's playoff bracket needs to
 * do once a given gameweek has been settled. Kept side-effect free so the
 * end-of-season scheduling logic can be unit tested without a database.
 *
 * - "generate": `gameweekId` is the last regular-season gameweek — seed the
 *   bracket so it's ready to kick off next gameweek.
 * - "advance": `gameweekId` falls inside the playoff window — roll the
 *   just-settled round's winners into the next round (or crown a champion).
 * - "none": too few members for a bracket, or `gameweekId` is outside both
 *   the pre-playoff and playoff windows.
 */
export function resolvePlayoffAction(
  league: { endGameweekId: number },
  activeMemberCount: number,
  gameweekId: number
): PlayoffAction {
  const bracketSize = LeagueService.computeBracketSize(activeMemberCount);
  if (bracketSize < 2) {
    return { type: "none" };
  }

  const rounds = Math.log2(bracketSize);
  const firstPlayoffGameweek = league.endGameweekId - rounds + 1;

  if (gameweekId === firstPlayoffGameweek - 1) {
    return { type: "generate" };
  }
  if (gameweekId >= firstPlayoffGameweek && gameweekId <= league.endGameweekId) {
    return { type: "advance" };
  }
  return { type: "none" };
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
  const leagues = await prisma.league.findMany({
    where: {
      status: LeagueStatus.ACTIVE,
      startGameweekId: { lte: gameweekId },
      endGameweekId: { gte: gameweekId },
    },
  });
  for (const league of leagues) {
    if (league.scoringType === ScoringType.HEAD_TO_HEAD) {
      const activeMemberCount = await prisma.leagueMember.count({
        where: { leagueId: league.id, status: MembershipStatus.ACTIVE },
      });
      const playoffAction = resolvePlayoffAction(league, activeMemberCount, gameweekId);

      // Seed the bracket *before* settling this gameweek's regular-season
      // fixtures — it targets next gameweek, so ordering relative to the
      // settlement below doesn't matter, but doing it first keeps the two
      // playoff branches next to each other.
      if (playoffAction.type === "generate") {
        try {
          await leagueService.generatePlayoffBracket(league.id);
        } catch (err) {
          console.error(`Failed to generate playoff bracket for league ${league.id}:`, err);
        }
      }

      await leagueService.settleH2HGameweek(league.id, gameweekId);

      if (playoffAction.type === "advance") {
        try {
          await leagueService.advancePlayoffRound(league.id, gameweekId);
        } catch (err) {
          console.error(`Failed to advance playoff bracket for league ${league.id}:`, err);
        }
      }
    }
    if (league.endGameweekId === gameweekId) {
      await leagueService.transitionStatus(league.id, LeagueStatus.COMPLETED);
    }
  }

  // Bulk-recalculate every CLASSIC league's standings in one pass across the
  // whole platform (see recalculateClassicStandings for why this replaced a
  // per-league loop).
  await leagueService.recalculateClassicStandings(gameweekId);

  const oracleSigningKey = process.env.STELLAR_ORACLE_SIGNING_KEY;
  if (oracleSigningKey) {
    const result = await gameweekOracleService.publishFinalGameweek(gameweekId, oracleSigningKey);
    if (!result.success) {
      throw new Error(`Failed to publish gameweek ${gameweekId} result to Soroban: ${result.error}`);
    }
  }

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
