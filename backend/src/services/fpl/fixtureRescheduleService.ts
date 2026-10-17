import { ChipType, Position } from "../../types/index.js";
import {
  ScoringService,
  PlayerScoreDetail,
} from "../scoring/scoringService.js";

export type FixtureLifecycleStatus =
  | "SCHEDULED"
  | "LIVE"
  | "FINISHED"
  | "POSTPONED"
  | "RESCHEDULED"
  | "ABANDONED";

export interface ExternalFixtureRecord {
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  originalGameweekId: number;
  currentGameweekId: number | null; // null when postponed without a new date
  finished: boolean;
  minutesPlayed: number;
  abandoned?: boolean;
  voidStatsOnAbandonment?: boolean;
}

export interface FixtureStateTransition {
  fixtureId: number;
  previousGameweekId: number;
  newGameweekId: number | null;
  status: FixtureLifecycleStatus;
  createsBlankInGameweek: number | null;
  createsDoubleInGameweek: number | null;
}

export interface PlayerFixturePerformance {
  playerId: number;
  teamId: number;
  fixtureId: number;
  gameweekId: number;
  minutes: number;
  goalsPoints: number;
  assistsPoints: number;
  cleanSheetPoints: number;
  otherPoints: number; // saves, bonus, cards, appearance
}

export interface AggregatedGameweekPlayerStat {
  playerId: number;
  scheduledFixturesCount: number;
  completedFixturesCount: number;
  minutes: number;
  totalPoints: number;
  eligibleForAutoSub: boolean;
}

export class FixtureRescheduleService {
  /**
   * Detects fixture postponements, gameweek reassignments (BGW -> DGW), and mid-match abandonments.
   */
  public static classifyFixtureTransitions(
    fixtures: ExternalFixtureRecord[],
    teamFixtureCountsByGw: Map<string, number> = new Map()
  ): FixtureStateTransition[] {
    const transitions: FixtureStateTransition[] = [];

    for (const fx of fixtures) {
      let status: FixtureLifecycleStatus = "SCHEDULED";
      let createsBlankInGameweek: number | null = null;
      let createsDoubleInGameweek: number | null = null;

      if (fx.currentGameweekId === null) {
        status = "POSTPONED";
        createsBlankInGameweek = fx.originalGameweekId;
      } else if (fx.currentGameweekId !== fx.originalGameweekId) {
        status = "RESCHEDULED";
        createsBlankInGameweek = fx.originalGameweekId;
        createsDoubleInGameweek = fx.currentGameweekId;
      } else if (fx.abandoned) {
        status = "ABANDONED";
      } else if (fx.finished) {
        status = "FINISHED";
      } else if (fx.minutesPlayed > 0) {
        status = "LIVE";
      }

      if (fx.currentGameweekId !== null) {
        const homeKey = `${fx.currentGameweekId}:${fx.homeTeamId}`;
        const awayKey = `${fx.currentGameweekId}:${fx.awayTeamId}`;
        const homeCount = (teamFixtureCountsByGw.get(homeKey) ?? 0) + 1;
        const awayCount = (teamFixtureCountsByGw.get(awayKey) ?? 0) + 1;
        teamFixtureCountsByGw.set(homeKey, homeCount);
        teamFixtureCountsByGw.set(awayKey, awayCount);

        if (homeCount > 1 || awayCount > 1) {
          createsDoubleInGameweek = fx.currentGameweekId;
        }
      }

      transitions.push({
        fixtureId: fx.fixtureId,
        previousGameweekId: fx.originalGameweekId,
        newGameweekId: fx.currentGameweekId,
        status,
        createsBlankInGameweek,
        createsDoubleInGameweek,
      });
    }

    return transitions;
  }

  /**
   * Evaluates a single player's performance in a fixture, handling mid-match abandonment rules:
   * - Postponed fixtures (currentGameweekId === null) contribute 0 minutes and 0 points.
   * - Abandoned fixtures with `voidStatsOnAbandonment: true` contribute 0 points.
   * - Abandoned fixtures with `voidStatsOnAbandonment: false` preserve points accrued up to
   *   abandonment, but strip clean sheet points if the match or player did not reach 60 minutes.
   */
  public static evaluateFixturePerformance(
    perf: PlayerFixturePerformance,
    fixture: ExternalFixtureRecord
  ): { minutes: number; totalPoints: number; countsAsResolved: boolean } {
    if (
      fixture.currentGameweekId === null ||
      fixture.currentGameweekId !== perf.gameweekId
    ) {
      return { minutes: 0, totalPoints: 0, countsAsResolved: true };
    }

    if (fixture.abandoned) {
      if (fixture.voidStatsOnAbandonment) {
        return { minutes: 0, totalPoints: 0, countsAsResolved: true };
      }

      const effectiveMinutes = Math.min(perf.minutes, fixture.minutesPlayed);
      const canKeepCleanSheet =
        effectiveMinutes >= 60 && fixture.minutesPlayed >= 60;
      const csPoints = canKeepCleanSheet ? perf.cleanSheetPoints : 0;

      return {
        minutes: effectiveMinutes,
        totalPoints:
          perf.goalsPoints + perf.assistsPoints + csPoints + perf.otherPoints,
        countsAsResolved: true,
      };
    }

    const canKeepCleanSheet = perf.minutes >= 60;
    const csPoints = canKeepCleanSheet ? perf.cleanSheetPoints : 0;

    return {
      minutes: perf.minutes,
      totalPoints:
        perf.goalsPoints + perf.assistsPoints + csPoints + perf.otherPoints,
      countsAsResolved: fixture.finished,
    };
  }

  /**
   * Aggregates player stats for a target gameweek across Blank, Single, Double, or Triple Gameweeks.
   * Ensures a DGW player is only marked eligible for auto-substitution if all of their team's
   * scheduled fixtures in the gameweek have resolved and their cumulative minutes played is 0.
   */
  public static aggregateGameweekStats(
    gameweekId: number,
    squadPlayers: Array<{ playerId: number; teamId: number }>,
    fixtures: ExternalFixtureRecord[],
    performances: PlayerFixturePerformance[]
  ): Map<number, AggregatedGameweekPlayerStat> {
    const activeGwFixtures = fixtures.filter(
      (f) => f.currentGameweekId === gameweekId
    );
    const fixtureById = new Map<number, ExternalFixtureRecord>();
    for (const f of fixtures) {
      fixtureById.set(f.fixtureId, f);
    }

    const result = new Map<number, AggregatedGameweekPlayerStat>();

    for (const sp of squadPlayers) {
      const teamFixtures = activeGwFixtures.filter(
        (f) => f.homeTeamId === sp.teamId || f.awayTeamId === sp.teamId
      );

      if (teamFixtures.length === 0) {
        // Blank Gameweek (BGW): team has 0 active fixtures in this gameweek
        result.set(sp.playerId, {
          playerId: sp.playerId,
          scheduledFixturesCount: 0,
          completedFixturesCount: 0,
          minutes: 0,
          totalPoints: 0,
          eligibleForAutoSub: true,
        });
        continue;
      }

      let totalMinutes = 0;
      let totalPoints = 0;
      let resolvedCount = 0;

      for (const tf of teamFixtures) {
        const perf = performances.find(
          (p) =>
            p.playerId === sp.playerId &&
            p.fixtureId === tf.fixtureId &&
            p.gameweekId === gameweekId
        );

        if (perf) {
          const evaluated = FixtureRescheduleService.evaluateFixturePerformance(
            perf,
            tf
          );
          totalMinutes += evaluated.minutes;
          totalPoints += evaluated.totalPoints;
          if (evaluated.countsAsResolved) {
            resolvedCount += 1;
          }
        } else if (tf.finished || tf.abandoned) {
          resolvedCount += 1;
        }
      }

      const allFixturesResolved = resolvedCount === teamFixtures.length;
      result.set(sp.playerId, {
        playerId: sp.playerId,
        scheduledFixturesCount: teamFixtures.length,
        completedFixturesCount: resolvedCount,
        minutes: totalMinutes,
        totalPoints,
        eligibleForAutoSub: allFixturesResolved && totalMinutes === 0,
      });
    }

    return result;
  }

  /**
   * Calculates a squad's gameweek score while accounting for BGW postponements,
   * DGW multi-match accumulation, and pending second fixtures in a DGW.
   */
  public static calculateRescheduledGameweekLineupScore(
    gameweekId: number,
    players: Array<{
      playerId: number;
      teamId: number;
      position: Position;
      isStarter: boolean;
      isCaptain: boolean;
      isViceCaptain: boolean;
      positionOrder: number;
    }>,
    fixtures: ExternalFixtureRecord[],
    performances: PlayerFixturePerformance[],
    options: { chip?: ChipType | null; transferCost?: number } = {}
  ): {
    startingPoints: number;
    benchPoints: number;
    captainPoints: number;
    transferCost: number;
    totalPoints: number;
    details: PlayerScoreDetail[];
  } {
    const aggregated = FixtureRescheduleService.aggregateGameweekStats(
      gameweekId,
      players.map((p) => ({ playerId: p.playerId, teamId: p.teamId })),
      fixtures,
      performances
    );

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    for (const [playerId, agg] of aggregated.entries()) {
      // If a DGW player has 0 minutes in Match 1 but Match 2 has NOT resolved yet,
      // hold a sentinel 1 minute during live calculation so they aren't prematurely subbed out,
      // or use actual minutes once all their scheduled fixtures in the GW have resolved.
      const effectiveMinutesForSubCheck =
        agg.minutes === 0 && !agg.eligibleForAutoSub ? 1 : agg.minutes;
      statsMap.set(playerId, {
        minutes: effectiveMinutesForSubCheck,
        totalPoints: agg.totalPoints,
      });
    }

    return ScoringService.calculateLineupScore(players, statsMap, options);
  }
}
