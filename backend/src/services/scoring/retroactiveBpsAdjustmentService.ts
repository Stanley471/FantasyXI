/**
 * Retroactive BPS / stat correction engine.
 *
 * Official FPL bonus points and stat corrections (a goal re-credited, a yellow
 * card rescinded) often land hours after a match, when gameweek scores have
 * already been tallied and the live sync has stopped polling. This service:
 *
 * 1. Detects corrections by diffing the FPL live endpoint against the stored
 *    PlayerGameweekStats of a finished gameweek.
 * 2. Computes a differential score change only for squads that own a
 *    corrected player: each lineup is scored with the old and the corrected
 *    stats (same captaincy, chip and auto-sub rules as ScoringService) and the
 *    difference is applied to the stored score. Unaffected squads are not read.
 * 3. Applies everything in one database transaction: corrected stats, squad
 *    gameweek scores (optimistic check on the previous value), squad totals,
 *    classic-league member totals and re-ranked standings, plus an audit row
 *    per change (previous score, delta, new score, reason).
 * 4. Notifies affected users in real time once the transaction has committed.
 *
 * Settled leagues are protected: a league that is COMPLETED, or that already
 * has a confirmed on-chain prize payout, never has its member totals or ranks
 * changed. Its squads' own gameweek scores are still corrected (they are
 * platform statistics, not escrow state) and the skip is recorded in the audit.
 *
 * Head-to-head fixture results are not re-resolved; only classic standings are.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../config/db.js";
import { fplClient as defaultFplClient } from "../fpl/fplClient.js";
import { normalizePlayerStats } from "../fpl/fplNormalizer.js";
import { acquireLock } from "../lockManager.js";
import { ScoringService } from "./scoringService.js";
import { eventBus as defaultEventBus, EventBus } from "../events/eventBus.js";
import { userNotificationHub, UserNotificationHub } from "../notifications/userNotificationHub.js";
import {
  ChipType,
  LeagueStatus,
  MembershipStatus,
  Position,
  ScoringType,
  TransactionStatus,
  TransactionType,
} from "../../types/index.js";

export const SCORE_ADJUSTED_EVENT = "score.adjusted";
export const DEFAULT_ADJUSTMENT_REASON = "Official FPL bonus points / stat correction";

const STAT_FIELDS = [
  "minutes",
  "goals",
  "assists",
  "cleanSheet",
  "yellowCards",
  "redCards",
  "saves",
  "bonus",
  "totalPoints",
] as const;

export type StatField = (typeof STAT_FIELDS)[number];

export interface PlayerStatSnapshot {
  minutes: number;
  goals: number;
  assists: number;
  cleanSheet: boolean;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  totalPoints: number;
}

export interface StatCorrection {
  playerId: number;
  fixtureId: number;
  /** null when FPL reports a fixture row the platform never stored */
  previous: PlayerStatSnapshot | null;
  next: PlayerStatSnapshot;
  changedFields: StatField[];
}

export interface PlayerPointsChange {
  playerId: number;
  previousPoints: number;
  newPoints: number;
  multiplier: number;
}

export interface SquadAdjustment {
  squadId: string;
  userId: string;
  previousPoints: number;
  newPoints: number;
  delta: number;
  captainPoints: number;
  benchPoints: number;
  players: PlayerPointsChange[];
}

export interface LeagueMemberAdjustment {
  leagueId: string;
  memberId: string;
  userId: string;
  squadId: string;
  previousTotal: number;
  newTotal: number;
  previousRank: number | null;
  newRank: number | null;
}

export interface ProtectedLeague {
  leagueId: string;
  reason: "LEAGUE_COMPLETED" | "PRIZES_PAID_ON_CHAIN";
}

export interface RetroactiveAdjustmentReport {
  runId: string;
  gameweekId: number;
  reason: string;
  applied: boolean;
  corrections: StatCorrection[];
  squadAdjustments: SquadAdjustment[];
  leagueAdjustments: LeagueMemberAdjustment[];
  protectedLeagues: ProtectedLeague[];
  appliedAt: string | null;
}

export class ScoreAdjustmentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreAdjustmentConflictError";
  }
}

export class ScoreAdjustmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreAdjustmentNotFoundError";
  }
}

/** FPL client surface used by the service (injectable for tests). */
export interface LiveStatsClient {
  getGameweekLive(gameweekFplId: number): Promise<{ elements: Array<Parameters<typeof normalizePlayerStats>[0]> }>;
}

export interface RetroactiveBpsAdjustmentOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  fpl?: LiveStatsClient;
  hub?: UserNotificationHub;
  eventBus?: EventBus;
  /** Serializes runs per gameweek across instances (defaults to the Redis lock manager) */
  lock?: (resource: string) => Promise<(() => Promise<void>) | null>;
  now?: () => Date;
}

function snapshot(row: Partial<PlayerStatSnapshot>): PlayerStatSnapshot {
  return {
    minutes: row.minutes ?? 0,
    goals: row.goals ?? 0,
    assists: row.assists ?? 0,
    cleanSheet: Boolean(row.cleanSheet),
    yellowCards: row.yellowCards ?? 0,
    redCards: row.redCards ?? 0,
    saves: row.saves ?? 0,
    bonus: row.bonus ?? 0,
    totalPoints: row.totalPoints ?? 0,
  };
}

/** Fields that differ between two stat lines. */
export function diffStats(previous: PlayerStatSnapshot | null, next: PlayerStatSnapshot): StatField[] {
  if (!previous) return STAT_FIELDS.filter((field) => next[field] !== snapshot({})[field]);
  return STAT_FIELDS.filter((field) => previous[field] !== next[field]);
}

const statKey = (playerId: number, fixtureId: number) => `${playerId}:${fixtureId}`;

export class RetroactiveBpsAdjustmentService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly fpl: LiveStatsClient;
  private readonly hub: UserNotificationHub;
  private readonly bus: EventBus;
  private readonly lock: (resource: string) => Promise<(() => Promise<void>) | null>;
  private readonly now: () => Date;

  constructor(options: RetroactiveBpsAdjustmentOptions = {}) {
    this.db = options.db ?? prisma;
    this.fpl = options.fpl ?? (defaultFplClient as unknown as LiveStatsClient);
    this.hub = options.hub ?? userNotificationHub;
    this.bus = options.eventBus ?? defaultEventBus;
    this.lock = options.lock ?? ((resource) => acquireLock(resource, { ttlMs: 120_000, retryCount: 1 }));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Fetches official stats for a gameweek (local id) and returns every
   * player/fixture line that differs from what is stored.
   */
  public async detectStatCorrections(gameweekId: number): Promise<StatCorrection[]> {
    const gameweek = await this.db.gameweek.findUnique({ where: { id: gameweekId } });
    if (!gameweek) throw new ScoreAdjustmentNotFoundError(`Gameweek ${gameweekId} not found`);

    const live = await this.fpl.getGameweekLive(gameweek.fplId);
    const [players, fixtures, stored] = await Promise.all([
      this.db.player.findMany({ select: { id: true, fplId: true } }),
      this.db.fixture.findMany({ where: { gameweekId }, select: { id: true, fplId: true } }),
      this.db.playerGameweekStats.findMany({ where: { gameweekId } }),
    ]);
    const playerByFplId = new Map<number, number>(players.map((p: { id: number; fplId: number }) => [p.fplId, p.id]));
    const fixtureByFplId = new Map<number, number>(fixtures.map((f: { id: number; fplId: number }) => [f.fplId, f.id]));
    const storedByKey = new Map<string, PlayerStatSnapshot>(
      stored.map((s: PlayerStatSnapshot & { playerId: number; fixtureId: number }) => [
        statKey(s.playerId, s.fixtureId),
        snapshot(s),
      ])
    );

    const corrections: StatCorrection[] = [];
    for (const element of live.elements ?? []) {
      const playerId = playerByFplId.get(element.id);
      if (!playerId) continue;

      // normalizePlayerStats returns one line per fixture, or a single object without `explain`
      const normalized = normalizePlayerStats(element);
      const lines = (Array.isArray(normalized) ? normalized : [normalized]) as Array<
        Partial<PlayerStatSnapshot> & { fixtureFplId?: number }
      >;
      for (const line of lines) {
        const fixtureId = line.fixtureFplId !== undefined ? fixtureByFplId.get(line.fixtureFplId) : undefined;
        if (!fixtureId) continue;

        const previous = storedByKey.get(statKey(playerId, fixtureId)) ?? null;
        const next = snapshot(line);
        const changedFields = diffStats(previous, next);
        if (changedFields.length > 0) {
          corrections.push({ playerId, fixtureId, previous, next, changedFields });
        }
      }
    }
    return corrections;
  }

  /**
   * Scores every squad owning a corrected player with the old and the corrected
   * stats. Only squads whose gameweek score was already tallied are adjusted.
   */
  public async computeSquadAdjustments(gameweekId: number, corrections: StatCorrection[]): Promise<SquadAdjustment[]> {
    if (corrections.length === 0) return [];
    const correctedPlayerIds = [...new Set(corrections.map((c) => c.playerId))];

    const owners = await this.db.squadPlayer.findMany({
      where: { playerId: { in: correctedPlayerIds } },
      select: { squadId: true },
    });
    const candidateSquadIds = [...new Set<string>(owners.map((o: { squadId: string }) => o.squadId))];
    if (candidateSquadIds.length === 0) return [];

    const scores = await this.db.squadGameweekScore.findMany({
      where: { gameweekId, squadId: { in: candidateSquadIds } },
    });
    const scoreBySquad = new Map<string, { points: number; transferCost: number }>(
      scores.map((s: { squadId: string; points: number; transferCost: number }) => [s.squadId, s])
    );
    const squadIds = candidateSquadIds.filter((id) => scoreBySquad.has(id));
    if (squadIds.length === 0) return [];

    const squads = await this.db.squad.findMany({
      where: { id: { in: squadIds } },
      include: { players: { include: { player: true } } },
    });
    const lineupPlayerIds = [
      ...new Set<number>(
        squads.flatMap((s: { players: Array<{ playerId: number }> }) => s.players.map((p) => p.playerId))
      ),
    ];
    const [stats, chips] = await Promise.all([
      this.db.playerGameweekStats.findMany({ where: { gameweekId, playerId: { in: lineupPlayerIds } } }),
      this.db.squadChipUsage.findMany({ where: { gameweekId, squadId: { in: squadIds } } }),
    ]);
    const chipBySquad = new Map<string, ChipType>(
      chips.map((c: { squadId: string; chipType: ChipType }) => [c.squadId, c.chipType])
    );

    // Old and corrected per-fixture lines, aggregated per player like ScoringService does
    const oldLines = new Map<string, { playerId: number; minutes: number; totalPoints: number }>();
    for (const s of stats) oldLines.set(statKey(s.playerId, s.fixtureId), s);
    const newLines = new Map(oldLines);
    for (const c of corrections) {
      newLines.set(statKey(c.playerId, c.fixtureId), {
        playerId: c.playerId,
        minutes: c.next.minutes,
        totalPoints: c.next.totalPoints,
      });
    }
    const aggregate = (lines: Map<string, { playerId: number; minutes: number; totalPoints: number }>) => {
      const map = new Map<number, { minutes: number; totalPoints: number }>();
      for (const line of lines.values()) {
        const current = map.get(line.playerId) ?? { minutes: 0, totalPoints: 0 };
        current.minutes += line.minutes;
        current.totalPoints += line.totalPoints;
        map.set(line.playerId, current);
      }
      return map;
    };
    const oldStats = aggregate(oldLines);
    const newStats = aggregate(newLines);
    const corrected = new Set(correctedPlayerIds);

    const adjustments: SquadAdjustment[] = [];
    for (const squad of squads) {
      const lineup = squad.players.map(
        (sp: {
          playerId: number;
          isStarter: boolean;
          isCaptain: boolean;
          isViceCaptain: boolean;
          positionOrder: number;
          player: { position: Position };
        }) => ({
          playerId: sp.playerId,
          position: sp.player.position,
          isStarter: sp.isStarter,
          isCaptain: sp.isCaptain,
          isViceCaptain: sp.isViceCaptain,
          positionOrder: sp.positionOrder,
        })
      );
      const stored = scoreBySquad.get(squad.id)!;
      const options = { chip: chipBySquad.get(squad.id) ?? null, transferCost: stored.transferCost ?? 0 };
      const before = ScoringService.calculateLineupScore(lineup, oldStats, options);
      const after = ScoringService.calculateLineupScore(lineup, newStats, options);
      const delta = after.totalPoints - before.totalPoints;
      if (delta === 0) continue;

      const beforeByPlayer = new Map(before.details.map((d) => [d.playerId, d]));
      adjustments.push({
        squadId: squad.id,
        userId: squad.userId,
        previousPoints: stored.points,
        newPoints: stored.points + delta,
        delta,
        captainPoints: after.captainPoints,
        benchPoints: after.benchPoints,
        players: after.details
          .filter((d) => corrected.has(d.playerId))
          .map((d) => ({
            playerId: d.playerId,
            previousPoints: beforeByPlayer.get(d.playerId)?.effectivePoints ?? 0,
            newPoints: d.effectivePoints,
            multiplier: d.multiplier,
          })),
      });
    }
    return adjustments;
  }

  /** Detects official stat corrections for a gameweek and applies them. */
  public async detectAndApply(
    gameweekId: number,
    options: { reason?: string; actorId?: string } = {}
  ): Promise<RetroactiveAdjustmentReport> {
    const release = await this.lock(`bps-adjustment:${gameweekId}`);
    try {
      const corrections = await this.detectStatCorrections(gameweekId);
      return await this.applyCorrections(gameweekId, corrections, options);
    } finally {
      await release?.();
    }
  }

  /**
   * Applies stat corrections atomically and notifies affected users.
   * A no-op (applied: false) when there is nothing to correct.
   */
  public async applyCorrections(
    gameweekId: number,
    corrections: StatCorrection[],
    options: { reason?: string; actorId?: string } = {}
  ): Promise<RetroactiveAdjustmentReport> {
    const reason = options.reason ?? DEFAULT_ADJUSTMENT_REASON;
    const report: RetroactiveAdjustmentReport = {
      runId: randomUUID(),
      gameweekId,
      reason,
      applied: false,
      corrections,
      squadAdjustments: [],
      leagueAdjustments: [],
      protectedLeagues: [],
      appliedAt: null,
    };
    if (corrections.length === 0) return report;

    report.squadAdjustments = await this.computeSquadAdjustments(gameweekId, corrections);
    const appliedAt = this.now();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.db.$transaction(async (tx: any) => {
      for (const c of corrections) {
        await tx.playerGameweekStats.upsert({
          where: { playerId_gameweekId_fixtureId: { playerId: c.playerId, gameweekId, fixtureId: c.fixtureId } },
          update: { ...c.next },
          create: { playerId: c.playerId, gameweekId, fixtureId: c.fixtureId, ...c.next },
        });
      }

      for (const adj of report.squadAdjustments) {
        // Optimistic check: a concurrent recalculation rolls the whole run back
        const { count } = await tx.squadGameweekScore.updateMany({
          where: { squadId: adj.squadId, gameweekId, points: adj.previousPoints },
          data: {
            points: adj.newPoints,
            captainPoints: adj.captainPoints,
            benchPoints: adj.benchPoints,
            calculatedAt: appliedAt,
          },
        });
        if (count !== 1) {
          throw new ScoreAdjustmentConflictError(
            `Score for squad ${adj.squadId} in gameweek ${gameweekId} changed during the adjustment; retry`
          );
        }
        await tx.squad.update({ where: { id: adj.squadId }, data: { totalPoints: { increment: adj.delta } } });
      }

      const { adjustments: leagueAdjustments, protectedLeagues } = await this.adjustLeagues(
        tx,
        gameweekId,
        report.squadAdjustments
      );
      report.leagueAdjustments = leagueAdjustments;
      report.protectedLeagues = protectedLeagues;

      await tx.scoreAdjustmentLog.createMany({ data: this.auditRows(report) });
    });

    report.applied = true;
    report.appliedAt = appliedAt.toISOString();
    await this.notify(report);
    return report;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async adjustLeagues(tx: any, gameweekId: number, squadAdjustments: SquadAdjustment[]) {
    const adjustments: LeagueMemberAdjustment[] = [];
    const protectedLeagues: ProtectedLeague[] = [];
    if (squadAdjustments.length === 0) return { adjustments, protectedLeagues };

    const deltaBySquad = new Map(squadAdjustments.map((a) => [a.squadId, a.delta]));
    const memberships = await tx.leagueMember.findMany({
      where: { squadId: { in: [...deltaBySquad.keys()] }, status: MembershipStatus.ACTIVE },
      include: {
        league: {
          select: { id: true, status: true, scoringType: true, startGameweekId: true, endGameweekId: true },
        },
      },
    });
    if (memberships.length === 0) return { adjustments, protectedLeagues };

    const leagueIds = [...new Set<string>(memberships.map((m: { leagueId: string }) => m.leagueId))];
    const paid = await tx.transaction.findMany({
      where: { leagueId: { in: leagueIds }, type: TransactionType.PRIZE_PAYOUT, status: TransactionStatus.CONFIRMED },
      select: { leagueId: true },
    });
    const paidLeagues = new Set<string>(paid.map((p: { leagueId: string }) => p.leagueId));

    const touchedLeagues = new Set<string>();
    const protectedSeen = new Set<string>();
    const previousByMember = new Map<string, { total: number; rank: number | null }>();
    for (const member of memberships) {
      const league = member.league;
      // Never corrupt standings that an on-chain settlement was (or is being) based on
      if (league.status === LeagueStatus.COMPLETED || paidLeagues.has(league.id)) {
        if (!protectedSeen.has(league.id)) {
          protectedSeen.add(league.id);
          protectedLeagues.push({
            leagueId: league.id,
            reason: league.status === LeagueStatus.COMPLETED ? "LEAGUE_COMPLETED" : "PRIZES_PAID_ON_CHAIN",
          });
        }
        continue;
      }
      if (
        league.status !== LeagueStatus.ACTIVE ||
        league.scoringType !== ScoringType.CLASSIC ||
        gameweekId < league.startGameweekId ||
        gameweekId > league.endGameweekId
      ) {
        continue;
      }

      const delta = deltaBySquad.get(member.squadId)!;
      previousByMember.set(member.id, { total: member.totalPoints, rank: member.rank ?? null });
      await tx.leagueMember.update({ where: { id: member.id }, data: { totalPoints: { increment: delta } } });
      touchedLeagues.add(league.id);
    }

    for (const leagueId of touchedLeagues) {
      const members = await tx.leagueMember.findMany({
        where: { leagueId, status: MembershipStatus.ACTIVE },
        select: { id: true, userId: true, squadId: true, totalPoints: true, rank: true, joinedAt: true },
      });
      // Same ordering as LeagueService.recalculateClassicStandings
      const ranked = [...members].sort((a, b) =>
        b.totalPoints !== a.totalPoints ? b.totalPoints - a.totalPoints : a.joinedAt.getTime() - b.joinedAt.getTime()
      );
      for (let i = 0; i < ranked.length; i++) {
        const member = ranked[i];
        const newRank = i + 1;
        if (member.rank !== newRank) {
          await tx.leagueMember.update({ where: { id: member.id }, data: { rank: newRank } });
        }
        const previous = previousByMember.get(member.id);
        if (previous || member.rank !== newRank) {
          adjustments.push({
            leagueId,
            memberId: member.id,
            userId: member.userId,
            squadId: member.squadId,
            previousTotal: previous?.total ?? member.totalPoints,
            newTotal: member.totalPoints,
            previousRank: previous?.rank ?? member.rank ?? null,
            newRank,
          });
        }
      }
    }
    return { adjustments, protectedLeagues };
  }

  private auditRows(report: RetroactiveAdjustmentReport) {
    const { runId, gameweekId, reason } = report;
    const rows: Array<Record<string, unknown>> = [];

    for (const c of report.corrections) {
      const previousPoints = c.previous?.totalPoints ?? 0;
      rows.push({
        runId,
        gameweekId,
        entityType: "PLAYER_STAT",
        entityId: `${c.playerId}:${c.fixtureId}`,
        playerId: c.playerId,
        previousPoints,
        delta: c.next.totalPoints - previousPoints,
        newPoints: c.next.totalPoints,
        reason,
        details: { fixtureId: c.fixtureId, changedFields: c.changedFields, previous: c.previous, next: c.next },
      });
    }
    for (const adj of report.squadAdjustments) {
      rows.push({
        runId,
        gameweekId,
        entityType: "SQUAD_SCORE",
        entityId: adj.squadId,
        squadId: adj.squadId,
        previousPoints: adj.previousPoints,
        delta: adj.delta,
        newPoints: adj.newPoints,
        reason,
        details: { userId: adj.userId, players: adj.players },
      });
    }
    for (const member of report.leagueAdjustments) {
      rows.push({
        runId,
        gameweekId,
        entityType: "LEAGUE_MEMBER",
        entityId: member.memberId,
        squadId: member.squadId,
        leagueId: member.leagueId,
        previousPoints: member.previousTotal,
        delta: member.newTotal - member.previousTotal,
        newPoints: member.newTotal,
        reason,
        details: { userId: member.userId, previousRank: member.previousRank, newRank: member.newRank },
      });
    }
    for (const league of report.protectedLeagues) {
      rows.push({
        runId,
        gameweekId,
        entityType: "LEAGUE_MEMBER",
        entityId: league.leagueId,
        leagueId: league.leagueId,
        previousPoints: 0,
        delta: 0,
        newPoints: 0,
        reason,
        details: { skipped: true, protection: league.reason },
      });
    }
    return rows;
  }

  private async notify(report: RetroactiveAdjustmentReport): Promise<void> {
    const leagueByUser = new Map<string, LeagueMemberAdjustment[]>();
    for (const member of report.leagueAdjustments) {
      const list = leagueByUser.get(member.userId) ?? [];
      list.push(member);
      leagueByUser.set(member.userId, list);
    }

    for (const adj of report.squadAdjustments) {
      this.hub.publish(adj.userId, SCORE_ADJUSTED_EVENT, {
        gameweekId: report.gameweekId,
        squadId: adj.squadId,
        previousPoints: adj.previousPoints,
        delta: adj.delta,
        newPoints: adj.newPoints,
        reason: report.reason,
        players: adj.players,
        leagues: (leagueByUser.get(adj.userId) ?? [])
          .filter((m) => m.squadId === adj.squadId)
          .map((m) => ({
            leagueId: m.leagueId,
            previousTotal: m.previousTotal,
            newTotal: m.newTotal,
            previousRank: m.previousRank,
            newRank: m.newRank,
          })),
      });
    }

    try {
      await this.bus.publish(SCORE_ADJUSTED_EVENT, {
        runId: report.runId,
        gameweekId: report.gameweekId,
        squadsAdjusted: report.squadAdjustments.length,
        leaguesProtected: report.protectedLeagues.map((l) => l.leagueId),
      });
    } catch (error) {
      console.error("[bps-adjustment] Event bus publish failed:", (error as Error).message);
    }
  }
}

export const retroactiveBpsAdjustmentService = new RetroactiveBpsAdjustmentService();
