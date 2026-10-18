import { prisma } from "../../config/db.js";
import { ScoringService } from "../scoring/scoringService.js";

/**
 * Fixture Reschedule & Anomaly Handler (issue #269).
 *
 * Runs on every FPL fixtures sync. It compares the stored fixtures with the
 * incoming feed and, before the fixture rows are updated:
 *
 * - POSTPONED   (moved out of its gameweek before kickoff): deletes any stat rows
 *               recorded against it so the blank gameweek awards no ghost
 *               points; starters without a fixture then auto-substitute.
 * - RESCHEDULED (moved to another gameweek before kickoff): moves its stat rows
 *               into the new gameweek bucket, so a double gameweek scores both
 *               fixtures (the scoring engine sums per-fixture rows and applies
 *               the captaincy multiplier to the total).
 * - REINSTATED  (an unscheduled fixture given a gameweek): nothing to move;
 *               the live sync records its stats in the new gameweek.
 * - ABANDONED   (moved or unscheduled after kickoff, before finishing): applies
 *               the abandoned-match policy. VOID_AND_REPLAY (default, the
 *               Premier League and FPL ruling: the match is replayed from 0-0
 *               and points from the abandoned match are voided) deletes its stat
 *               rows; RESULT_STANDS keeps the partial points in the gameweek in
 *               which they were played.
 * - SUSPECTED_ABANDONMENT (started, not finished, kickoff long past, schedule
 *               unchanged): reported only. Settlement already waits for every
 *               fixture to finish, and nothing is deleted until FPL moves it.
 * - KICKOFF_CHANGED (new time, same gameweek): reported only.
 *
 * After the fixture rows are updated, squads already scored in an affected,
 * unsettled gameweek are rescored. Settled gameweeks are never rewritten: stat
 * changes touching them are skipped and reported for manual review instead.
 */

export type FixtureChangeType =
  | "POSTPONED"
  | "RESCHEDULED"
  | "REINSTATED"
  | "ABANDONED"
  | "SUSPECTED_ABANDONMENT"
  | "KICKOFF_CHANGED";

export enum AbandonedMatchPolicy {
  VOID_AND_REPLAY = "VOID_AND_REPLAY",
  RESULT_STANDS = "RESULT_STANDS",
}

/** Hours after kickoff before an unfinished match is flagged as possibly abandoned. */
export const SUSPECTED_ABANDONMENT_HOURS = 6;

export interface FixtureSnapshot {
  fplId: number;
  /** Local fixture id (stored fixtures only) */
  id?: number;
  gameweekId: number | null;
  homeTeamId?: number;
  awayTeamId?: number;
  kickoffTime: Date | null;
  started: boolean;
  finished: boolean;
  minutes?: number;
}

export interface FixtureChange {
  type: FixtureChangeType;
  fplId: number;
  fixtureId: number;
  homeTeamId?: number;
  awayTeamId?: number;
  fromGameweekId: number | null;
  toGameweekId: number | null;
  previousKickoff: Date | null;
  kickoffTime: Date | null;
}

export interface StatMigrationResult {
  statsMoved: number;
  statsDeleted: number;
  /** Gameweeks whose stat rows changed and may need rescoring */
  affectedGameweekIds: number[];
  /** Settled gameweeks a change would have rewritten; left untouched for manual review */
  requiresManualReview: number[];
}

export interface RescoreResult {
  rescored: Array<{ gameweekId: number; squadIds: string[] }>;
  /** Settled gameweeks touched by a change; never rewritten automatically */
  requiresManualReview: number[];
}

export interface FixtureRescheduleOptions {
  abandonedPolicy?: AbandonedMatchPolicy;
  suspectedAbandonmentHours?: number;
  now?: () => Date;
}

const time = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);

export class FixtureRescheduleService {
  private readonly abandonedPolicy: AbandonedMatchPolicy;
  private readonly suspectedAbandonmentMs: number;
  private readonly now: () => Date;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = prisma,
    private readonly scoring: Pick<ScoringService, "calculateAndPersistSquadScore"> = new ScoringService(db),
    options: FixtureRescheduleOptions = {}
  ) {
    this.abandonedPolicy =
      options.abandonedPolicy ??
      (process.env.FPL_ABANDONED_MATCH_POLICY === AbandonedMatchPolicy.RESULT_STANDS
        ? AbandonedMatchPolicy.RESULT_STANDS
        : AbandonedMatchPolicy.VOID_AND_REPLAY);
    this.suspectedAbandonmentMs = (options.suspectedAbandonmentHours ?? SUSPECTED_ABANDONMENT_HOURS) * 3_600_000;
    this.now = options.now ?? (() => new Date());
  }

  public getAbandonedPolicy(): AbandonedMatchPolicy {
    return this.abandonedPolicy;
  }

  /** Classifies how each stored fixture changed in the incoming feed. */
  public detectChanges(existing: FixtureSnapshot[], incoming: FixtureSnapshot[]): FixtureChange[] {
    const stored = new Map(existing.map((f) => [f.fplId, f]));
    const changes: FixtureChange[] = [];
    const now = this.now().getTime();

    for (const next of incoming) {
      const prev = stored.get(next.fplId);
      if (!prev || prev.id === undefined) continue;

      const base = {
        fplId: next.fplId,
        fixtureId: prev.id,
        homeTeamId: prev.homeTeamId,
        awayTeamId: prev.awayTeamId,
        fromGameweekId: prev.gameweekId,
        toGameweekId: next.gameweekId,
        previousKickoff: prev.kickoffTime,
        kickoffTime: next.kickoffTime,
      };
      const playedPartially = prev.started && !prev.finished;

      if (prev.gameweekId !== next.gameweekId) {
        let type: FixtureChangeType;
        if (playedPartially) type = "ABANDONED";
        else if (next.gameweekId === null) type = "POSTPONED";
        else if (prev.gameweekId === null) type = "REINSTATED";
        else type = "RESCHEDULED";
        changes.push({ type, ...base });
        continue;
      }

      const kickoff = time(next.kickoffTime);
      if (next.started && !next.finished && kickoff !== null && now - kickoff > this.suspectedAbandonmentMs) {
        changes.push({ type: "SUSPECTED_ABANDONMENT", ...base });
      } else if (time(prev.kickoffTime) !== kickoff) {
        changes.push({ type: "KICKOFF_CHANGED", ...base });
      }
    }
    return changes;
  }

  /**
   * Moves or deletes stat rows for changed fixtures in one transaction. Run it
   * before the fixture rows are updated so a failure leaves the change
   * detectable on the next sync.
   */
  public async migrateStats(changes: FixtureChange[]): Promise<StatMigrationResult> {
    const ops: unknown[] = [];
    const plan: Array<"moved" | "deleted"> = [];
    const affected = new Set<number>();
    const settled = await this.settledGameweeks(changes);
    const manualReview = new Set<number>();

    for (const change of changes) {
      const touchedSettled = [change.fromGameweekId, change.toGameweekId].filter(
        (id): id is number => id !== null && settled.has(id)
      );
      if (touchedSettled.length > 0 && this.rewritesStats(change)) {
        touchedSettled.forEach((id) => manualReview.add(id));
        continue;
      }

      const where = { fixtureId: change.fixtureId };
      switch (change.type) {
        case "POSTPONED":
          ops.push(this.db.playerGameweekStats.deleteMany({ where }));
          plan.push("deleted");
          if (change.fromGameweekId !== null) affected.add(change.fromGameweekId);
          break;
        case "RESCHEDULED":
          ops.push(
            this.db.playerGameweekStats.updateMany({ where, data: { gameweekId: change.toGameweekId } })
          );
          plan.push("moved");
          affected.add(change.fromGameweekId!);
          affected.add(change.toGameweekId!);
          break;
        case "ABANDONED":
          if (this.abandonedPolicy === AbandonedMatchPolicy.VOID_AND_REPLAY) {
            ops.push(this.db.playerGameweekStats.deleteMany({ where }));
            plan.push("deleted");
            if (change.fromGameweekId !== null) affected.add(change.fromGameweekId);
            if (change.toGameweekId !== null) affected.add(change.toGameweekId);
          }
          break;
        case "REINSTATED":
          if (change.toGameweekId !== null) affected.add(change.toGameweekId);
          break;
        default:
          break;
      }
    }

    let statsMoved = 0;
    let statsDeleted = 0;
    if (ops.length > 0) {
      const results: Array<{ count: number }> = await this.db.$transaction(ops);
      results.forEach((r, i) => {
        if (plan[i] === "moved") statsMoved += r?.count ?? 0;
        else statsDeleted += r?.count ?? 0;
      });
    }
    return {
      statsMoved,
      statsDeleted,
      affectedGameweekIds: [...affected].sort((a, b) => a - b),
      requiresManualReview: [...manualReview].sort((a, b) => a - b),
    };
  }

  private rewritesStats(change: FixtureChange): boolean {
    return (
      change.type === "POSTPONED" ||
      change.type === "RESCHEDULED" ||
      (change.type === "ABANDONED" && this.abandonedPolicy === AbandonedMatchPolicy.VOID_AND_REPLAY)
    );
  }

  /** Settled gameweeks among those a stat-rewriting change touches (one query, skipped when none). */
  private async settledGameweeks(changes: FixtureChange[]): Promise<Set<number>> {
    const ids = [
      ...new Set(
        changes
          .filter((c) => this.rewritesStats(c))
          .flatMap((c) => [c.fromGameweekId, c.toGameweekId])
          .filter((id): id is number => id !== null)
      ),
    ];
    if (ids.length === 0) return new Set();
    const gameweeks: Array<{ id: number; settledAt: Date | null }> = await this.db.gameweek.findMany({
      where: { id: { in: ids } },
      select: { id: true, settledAt: true },
    });
    return new Set(gameweeks.filter((g) => g.settledAt).map((g) => g.id));
  }

  /**
   * Rescores squads that own a player from a changed fixture and already have
   * a score in an affected gameweek. Settled gameweeks are only reported.
   */
  public async rescoreAffected(changes: FixtureChange[], affectedGameweekIds: number[]): Promise<RescoreResult> {
    const result: RescoreResult = { rescored: [], requiresManualReview: [] };
    if (affectedGameweekIds.length === 0) return result;

    const gameweeks: Array<{ id: number; settledAt: Date | null }> = await this.db.gameweek.findMany({
      where: { id: { in: affectedGameweekIds } },
      select: { id: true, settledAt: true },
    });

    for (const gw of gameweeks.sort((a, b) => a.id - b.id)) {
      if (gw.settledAt) {
        result.requiresManualReview.push(gw.id);
        continue;
      }

      const teamIds = [
        ...new Set(
          changes
            .filter((c) => c.fromGameweekId === gw.id || c.toGameweekId === gw.id)
            .flatMap((c) => [c.homeTeamId, c.awayTeamId])
            .filter((id): id is number => id !== undefined)
        ),
      ];
      if (teamIds.length === 0) continue;

      const scored: Array<{ squadId: string }> = await this.db.squadGameweekScore.findMany({
        where: { gameweekId: gw.id, squad: { players: { some: { player: { teamId: { in: teamIds } } } } } },
        select: { squadId: true },
      });
      const squadIds = [...new Set(scored.map((s) => s.squadId))].sort();
      for (const squadId of squadIds) {
        await this.scoring.calculateAndPersistSquadScore(squadId, gw.id);
      }
      if (squadIds.length > 0) result.rescored.push({ gameweekId: gw.id, squadIds });
    }
    return result;
  }
}

export const fixtureRescheduleService = new FixtureRescheduleService();
