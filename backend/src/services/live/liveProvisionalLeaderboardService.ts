/**
 * Live Provisional Leaderboard Calculation Service & Daemon (Issue #268)
 *
 * High-performance live provisional leaderboard engine that ingests real-time
 * match events (goals, assists, saves, cards, bonus) and updates league rankings
 * in sub-second time using Redis Sorted Sets (ZSET), atomic ZINCRBY pipelines,
 * and an in-memory inverted player-to-squad index with zero database read queries
 * during live match point stream updates.
 */

import { EventEmitter } from "node:events";
import { prisma } from "../../config/db.js";
import { getRedisClient } from "../../config/redis.js";
import { eventFanout, type EventFanout } from "./eventFanout.js";
import type { LiveWebSocketGateway } from "./liveTimelineService.js";

export interface IRedisZSetPipeline {
  zincrby(key: string, increment: number, member: string): this;
  zadd(key: string, ...args: Array<string | number>): this;
  del(...keys: string[]): this;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface IRedisZSetClient {
  zincrby?(key: string, increment: number, member: string): Promise<string | number>;
  zadd?(key: string, ...args: Array<string | number>): Promise<number | string>;
  zrevrange?(
    key: string,
    start: number,
    stop: number,
    withScores?: "WITHSCORES"
  ): Promise<string[]>;
  zrevrank?(key: string, member: string): Promise<number | null>;
  zscore?(key: string, member: string): Promise<string | null>;
  del?(...keys: string[]): Promise<number>;
  pipeline?(): IRedisZSetPipeline;
}

export interface ProvisionalSquadPlayerSlot {
  playerId: number;
  isStarter: boolean;
  isCaptain?: boolean;
  isViceCaptain?: boolean;
  /** Optional explicit multiplier (e.g. 3 for Triple Captain, 2 for Captain, 1 for Starter, 0 for Bench) */
  multiplier?: number;
}

export interface ProvisionalSquadRegistration {
  squadId: string;
  userId: string;
  username: string;
  squadName: string;
  leagueIds: string[];
  /** Completed gameweek points prior to the active gameweek */
  basePoints: number;
  /** Provisional live points already scored in the active gameweek */
  livePoints?: number;
  /** Timestamp used for deterministic earliest-join tie-breaking */
  joinedAt?: Date | string | number;
  players: ProvisionalSquadPlayerSlot[];
}

export type LiveMatchPointEventType =
  | "GOAL"
  | "ASSIST"
  | "SAVE"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "CLEAN_SHEET"
  | "BONUS"
  | "POINTS_DELTA";

export interface LiveMatchPointEvent {
  eventId?: string;
  gameweekId: number;
  fixtureId?: number;
  playerId: number;
  type: LiveMatchPointEventType;
  pointsDelta: number;
  minute?: number;
  timestamp?: string;
}

export interface ProvisionalLeaderboardEntry {
  /** Strict 1..N rank after tie-breaking (totalPoints DESC, livePoints DESC, joinedAt ASC, squadId ASC) */
  rank: number;
  /** Competition rank where tied totalPoints share the same rank (1, 2, 2, 4) */
  competitionRank: number;
  previousRank: number | null;
  rankDelta: number;
  squadId: string;
  userId: string;
  username: string;
  squadName: string;
  basePoints: number;
  livePoints: number;
  totalPoints: number;
  joinedAtMs: number;
}

export interface SquadRankDiff {
  squadId: string;
  userId: string;
  username: string;
  squadName: string;
  oldRank: number | null;
  newRank: number;
  rankDelta: number;
  oldPoints: number;
  newPoints: number;
  pointsDelta: number;
  livePoints: number;
}

export interface LeagueRankDiffPayload {
  leagueId: string;
  gameweekId: number;
  updatedAt: string;
  diffs: SquadRankDiff[];
}

export type LiveMatchEvent = LiveMatchPointEvent;
export type LiveLeaderboardDeltaDiff = LeagueRankDiffPayload;
export type ProvisionalSquadRecord = ProvisionalSquadRegistration;
export type ProvisionalLeaderboardRankEntry = ProvisionalLeaderboardEntry;

export interface IngestionStreamMetrics {
  eventsProcessed: number;
  squadsUpdated: number;
  leaguesUpdated: number;
  redisPipelineCommands: number;
  elapsedMs: number;
  diffsByLeague: Map<string, LeagueRankDiffPayload>;
}

export interface LeaderboardReconciliationAdjustment {
  leagueId: string;
  squadId: string;
  provisionalPoints: number;
  finalPoints: number;
  provisionalRank: number | null;
  finalRank: number;
}

export interface LeaderboardReconciliationReport {
  gameweekId: number;
  leaguesReconciled: number;
  squadsChecked: number;
  discrepanciesFound: number;
  discrepanciesResolved: number;
  adjustments: LeaderboardReconciliationAdjustment[];
  syncedAt: string;
}

interface InternalSquadState {
  squadId: string;
  userId: string;
  username: string;
  squadName: string;
  leagueIds: string[];
  basePoints: number;
  livePoints: number;
  totalPoints: number;
  joinedAtMs: number;
}

interface InternalLeagueEntry {
  squad: InternalSquadState;
  rank: number;
  competitionRank: number;
  previousRank: number | null;
  lastBroadcastRank: number | null;
  lastBroadcastPoints: number;
}

interface InternalLeagueState {
  leagueId: string;
  entries: InternalLeagueEntry[];
  entryBySquadId: Map<string, InternalLeagueEntry>;
}

export interface LiveProvisionalLeaderboardOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  redis?: IRedisZSetClient | null;
  fanout?: EventFanout | null;
  gateway?: LiveWebSocketGateway | null;
}

export class LiveProvisionalLeaderboardService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private redis: IRedisZSetClient | null;
  private readonly fanout: EventFanout | null;
  private gateway: LiveWebSocketGateway | null;
  public readonly events = new EventEmitter();

  private activeGameweekId = 1;
  private readonly squads = new Map<string, InternalSquadState>();
  private readonly leagues = new Map<string, InternalLeagueState>();
  private readonly playerIndex = new Map<
    number,
    Array<{ squad: InternalSquadState; multiplier: number }>
  >();
  private readonly processedEventIds = new Set<string>();
  private readonly sseListeners = new Map<string, Set<(payload: LeagueRankDiffPayload) => void>>();

  constructor(options: LiveProvisionalLeaderboardOptions = {}) {
    this.db = options.db ?? prisma;
    this.redis =
      options.redis !== undefined
        ? options.redis
        : (getRedisClient() as unknown as IRedisZSetClient | null);
    this.fanout = options.fanout !== undefined ? options.fanout : eventFanout;
    this.gateway = options.gateway ?? null;
    this.events.setMaxListeners(0);
  }

  public static leagueZSetKey(leagueId: string, gameweekId: number): string {
    return `live:provisional:league:${leagueId}:gw:${gameweekId}`;
  }

  public static globalZSetKey(gameweekId: number): string {
    return `live:provisional:global:gw:${gameweekId}`;
  }

  public setGateway(gateway: LiveWebSocketGateway | null): void {
    this.gateway = gateway;
  }

  public setRedis(redis: IRedisZSetClient | null): void {
    this.redis = redis;
  }

  public reset(): void {
    this.squads.clear();
    this.leagues.clear();
    this.playerIndex.clear();
    this.processedEventIds.clear();
    this.sseListeners.clear();
  }

  /**
   * Subscribes a listener (e.g. an SSE response writer) to real-time rank/point
   * delta diffs for a specific league. Returns an unsubscribe function.
   */
  public subscribeLeagueDiffs(
    leagueId: string,
    listener: (payload: LeagueRankDiffPayload) => void
  ): () => void {
    const set = this.sseListeners.get(leagueId) ?? new Set();
    set.add(listener);
    this.sseListeners.set(leagueId, set);
    return () => {
      const current = this.sseListeners.get(leagueId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.sseListeners.delete(leagueId);
      }
    };
  }

  /**
   * Registers squads and their player lineups into the in-memory inverted index
   * and initializes Redis Sorted Sets (ZSET) for all participating leagues.
   */
  public async registerSquads(
    gameweekId: number,
    registrations: ProvisionalSquadRegistration[]
  ): Promise<void> {
    this.activeGameweekId = gameweekId;
    const affectedLeagues = new Set<string>();
    const pipeline = this.redis?.pipeline ? this.redis.pipeline() : null;
    const globalKey = LiveProvisionalLeaderboardService.globalZSetKey(gameweekId);

    for (const reg of registrations) {
      const joinedAtMs =
        reg.joinedAt instanceof Date
          ? reg.joinedAt.getTime()
          : typeof reg.joinedAt === "string"
            ? new Date(reg.joinedAt).getTime() || 0
            : typeof reg.joinedAt === "number"
              ? reg.joinedAt
              : 0;

      const livePoints = reg.livePoints ?? 0;
      const totalPoints = reg.basePoints + livePoints;

      const squadState: InternalSquadState = {
        squadId: reg.squadId,
        userId: reg.userId,
        username: reg.username,
        squadName: reg.squadName,
        leagueIds: [...reg.leagueIds],
        basePoints: reg.basePoints,
        livePoints,
        totalPoints,
        joinedAtMs,
      };

      this.squads.set(reg.squadId, squadState);

      for (const slot of reg.players) {
        const effectiveMultiplier =
          slot.multiplier !== undefined
            ? slot.multiplier
            : !slot.isStarter
              ? 0
              : slot.isCaptain
                ? 2
                : 1;

        if (effectiveMultiplier <= 0) continue;

        let list = this.playerIndex.get(slot.playerId);
        if (!list) {
          list = [];
          this.playerIndex.set(slot.playerId, list);
        }
        list.push({ squad: squadState, multiplier: effectiveMultiplier });
      }

      if (pipeline) {
        pipeline.zadd(globalKey, totalPoints, reg.squadId);
      } else if (this.redis?.zadd) {
        await this.redis.zadd(globalKey, totalPoints, reg.squadId);
      }

      for (const leagueId of reg.leagueIds) {
        affectedLeagues.add(leagueId);
        let league = this.leagues.get(leagueId);
        if (!league) {
          league = {
            leagueId,
            entries: [],
            entryBySquadId: new Map(),
          };
          this.leagues.set(leagueId, league);
        }

        const existingEntry = league.entryBySquadId.get(reg.squadId);
        if (existingEntry) {
          existingEntry.squad = squadState;
          existingEntry.lastBroadcastPoints = totalPoints;
        } else {
          const entry: InternalLeagueEntry = {
            squad: squadState,
            rank: 1,
            competitionRank: 1,
            previousRank: null,
            lastBroadcastRank: null,
            lastBroadcastPoints: totalPoints,
          };
          league.entries.push(entry);
          league.entryBySquadId.set(reg.squadId, entry);
        }

        const leagueKey = LiveProvisionalLeaderboardService.leagueZSetKey(leagueId, gameweekId);
        if (pipeline) {
          pipeline.zadd(leagueKey, totalPoints, reg.squadId);
        } else if (this.redis?.zadd) {
          await this.redis.zadd(leagueKey, totalPoints, reg.squadId);
        }
      }
    }

    if (pipeline) {
      await pipeline.exec();
    }

    for (const leagueId of affectedLeagues) {
      const league = this.leagues.get(leagueId);
      if (league) {
        this.recalculateLeagueRanks(league, true);
      }
    }
  }

  /**
   * Warms the provisional leaderboard state from the database once prior to live
   * matchday streaming so that subsequent match events require zero DB reads.
   */
  public async warmFromDatabase(gameweekId: number): Promise<number> {
    if (!this.db?.league?.findMany) return 0;

    const activeLeagues = await this.db.league.findMany({
      where: {
        status: "ACTIVE",
        startGameweekId: { lte: gameweekId },
        endGameweekId: { gte: gameweekId },
      },
      include: {
        members: {
          include: {
            user: { select: { username: true } },
            squad: {
              include: {
                players: true,
                gameweekScores: {
                  where: { gameweekId: { not: gameweekId } },
                },
              },
            },
          },
        },
      },
    });

    const squadRegMap = new Map<string, ProvisionalSquadRegistration>();

    for (const league of activeLeagues) {
      for (const member of league.members ?? []) {
        const existing = squadRegMap.get(member.squadId);
        if (existing) {
          if (!existing.leagueIds.includes(league.id)) {
            existing.leagueIds.push(league.id);
          }
          continue;
        }

        const completedPoints = (member.squad?.gameweekScores ?? []).reduce(
          (sum: number, s: any) => sum + (s.points ?? 0),
          0
        );

        squadRegMap.set(member.squadId, {
          squadId: member.squadId,
          userId: member.userId,
          username: member.user?.username ?? "manager",
          squadName: member.squad?.name ?? "Squad",
          leagueIds: [league.id],
          basePoints: completedPoints || (member.totalPoints ?? 0),
          livePoints: 0,
          joinedAt: member.joinedAt,
          players: (member.squad?.players ?? []).map((sp: any) => ({
            playerId: sp.playerId,
            isStarter: sp.isStarter,
            isCaptain: sp.isCaptain,
            isViceCaptain: sp.isViceCaptain,
          })),
        });
      }
    }

    const registrations = Array.from(squadRegMap.values());
    await this.registerSquads(gameweekId, registrations);
    return registrations.length;
  }

  /**
   * Ingests a single real-time match event without touching the primary database.
   */
  public async ingestMatchEvent(event: LiveMatchPointEvent): Promise<IngestionStreamMetrics> {
    return this.ingestMatchEventsBatch([event]);
  }

  /**
   * Ingests a stream/batch of real-time match events using atomic Redis ZINCRBY
   * pipelines and in-memory inverted index fanout.
   * Executes ZERO database read queries.
   */
  public async ingestMatchEventsBatch(
    events: LiveMatchPointEvent[]
  ): Promise<IngestionStreamMetrics> {
    const startNs = process.hrtime.bigint();
    const diffsByLeague = new Map<string, LeagueRankDiffPayload>();

    if (events.length === 0) {
      return {
        eventsProcessed: 0,
        squadsUpdated: 0,
        leaguesUpdated: 0,
        redisPipelineCommands: 0,
        elapsedMs: 0,
        diffsByLeague,
      };
    }

    // 1. Coalesce point deltas per playerId across the batch while deduplicating eventIds
    const netPlayerDeltas = new Map<number, number>();
    let validEventsCount = 0;
    let gameweekId = this.activeGameweekId;

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (evt.eventId) {
        if (this.processedEventIds.has(evt.eventId)) continue;
        this.processedEventIds.add(evt.eventId);
      }
      gameweekId = evt.gameweekId || gameweekId;
      validEventsCount++;
      if (evt.pointsDelta === 0) continue;
      netPlayerDeltas.set(evt.playerId, (netPlayerDeltas.get(evt.playerId) ?? 0) + evt.pointsDelta);
    }

    this.activeGameweekId = gameweekId;

    // 2. Accumulate net point increments per squad via O(1) inverted player lookup
    const squadPointIncrements = new Map<InternalSquadState, number>();
    for (const [playerId, playerDelta] of netPlayerDeltas) {
      if (playerDelta === 0) continue;
      const subscribers = this.playerIndex.get(playerId);
      if (!subscribers) continue;

      for (let i = 0; i < subscribers.length; i++) {
        const sub = subscribers[i];
        const increment = playerDelta * sub.multiplier;
        if (increment === 0) continue;
        squadPointIncrements.set(
          sub.squad,
          (squadPointIncrements.get(sub.squad) ?? 0) + increment
        );
      }
    }

    if (squadPointIncrements.size === 0) {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      return {
        eventsProcessed: validEventsCount,
        squadsUpdated: 0,
        leaguesUpdated: 0,
        redisPipelineCommands: 0,
        elapsedMs,
        diffsByLeague,
      };
    }

    // 3. Apply increments to squads, collect affected leagues, and build Redis ZINCRBY pipeline
    const affectedLeagues = new Set<InternalLeagueState>();
    const pipeline = this.redis?.pipeline ? this.redis.pipeline() : null;
    const globalKey = LiveProvisionalLeaderboardService.globalZSetKey(gameweekId);
    let redisPipelineCommands = 0;

    for (const [squad, delta] of squadPointIncrements) {
      squad.livePoints += delta;
      squad.totalPoints = squad.basePoints + squad.livePoints;

      if (pipeline) {
        pipeline.zincrby(globalKey, delta, squad.squadId);
        redisPipelineCommands++;
      } else if (this.redis?.zincrby) {
        await this.redis.zincrby(globalKey, delta, squad.squadId);
        redisPipelineCommands++;
      }

      const leagueIds = squad.leagueIds;
      for (let i = 0; i < leagueIds.length; i++) {
        const leagueId = leagueIds[i];
        const league = this.leagues.get(leagueId);
        if (league) {
          affectedLeagues.add(league);
        }
        const leagueKey = LiveProvisionalLeaderboardService.leagueZSetKey(leagueId, gameweekId);
        if (pipeline) {
          pipeline.zincrby(leagueKey, delta, squad.squadId);
          redisPipelineCommands++;
        } else if (this.redis?.zincrby) {
          await this.redis.zincrby(leagueKey, delta, squad.squadId);
          redisPipelineCommands++;
        }
      }
    }

    if (pipeline && redisPipelineCommands > 0) {
      await pipeline.exec();
    }

    // 4. Re-rank affected leagues with real-time tie-breaking and emit delta diffs
    const nowIso = new Date().toISOString();
    const shouldPublishFanout = this.fanout !== null;
    const hasGateway = this.gateway !== null;

    for (const league of affectedLeagues) {
      const diffs = this.recalculateLeagueRanks(league, false);
      if (diffs.length > 0) {
        const diffPayload: LeagueRankDiffPayload = {
          leagueId: league.leagueId,
          gameweekId,
          updatedAt: nowIso,
          diffs,
        };
        diffsByLeague.set(league.leagueId, diffPayload);

        // Push to SSE subscribers if any
        const listeners = this.sseListeners.get(league.leagueId);
        if (listeners && listeners.size > 0) {
          for (const listener of listeners) {
            try {
              listener(diffPayload);
            } catch {
              // Ignore individual SSE listener errors
            }
          }
        }

        // Emit on local EventEmitter for in-process consumers
        if (this.events.listenerCount("league:diff") > 0) {
          this.events.emit("league:diff", diffPayload);
        }

        // Push to WebSocket gateway if configured
        if (hasGateway && this.gateway) {
          if (this.gateway.broadcastToLeague) {
            void this.gateway.broadcastToLeague(
              league.leagueId,
              "LEADERBOARD_RANK_DIFF",
              diffPayload
            );
          } else {
            void this.gateway.broadcast("LEADERBOARD_RANK_DIFF", diffPayload);
          }
        }

        // Publish to EventFanout if there are active listeners
        if (shouldPublishFanout && this.fanout) {
          this.fanout.publish(
            `leaderboard:${league.leagueId}`,
            `gw:${gameweekId}`,
            diffPayload as unknown as Record<string, unknown>
          );
        }
      }
    }

    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    return {
      eventsProcessed: validEventsCount,
      squadsUpdated: squadPointIncrements.size,
      leaguesUpdated: affectedLeagues.size,
      redisPipelineCommands,
      elapsedMs,
      diffsByLeague,
    };
  }

  /**
   * Sorts a league's entries with real-time tie-breaking:
   * 1. totalPoints DESC
   * 2. livePoints DESC
   * 3. joinedAtMs ASC (earliest join wins tie)
   * 4. squadId ASC (deterministic fallback)
   */
  private recalculateLeagueRanks(
    league: InternalLeagueState,
    isInitialSeed: boolean
  ): SquadRankDiff[] {
    const entries = league.entries;
    entries.sort(
      (a, b) =>
        b.squad.totalPoints - a.squad.totalPoints ||
        b.squad.livePoints - a.squad.livePoints ||
        a.squad.joinedAtMs - b.squad.joinedAtMs ||
        a.squad.squadId.localeCompare(b.squad.squadId)
    );

    const diffs: SquadRankDiff[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const newRank = i + 1;
      const newCompetitionRank =
        i > 0 && entries[i - 1].squad.totalPoints === entry.squad.totalPoints
          ? entries[i - 1].competitionRank
          : newRank;

      const oldRank = isInitialSeed ? null : entry.lastBroadcastRank;
      const oldPoints = entry.lastBroadcastPoints;
      const newPoints = entry.squad.totalPoints;

      entry.previousRank = oldRank;
      entry.rank = newRank;
      entry.competitionRank = newCompetitionRank;

      if (isInitialSeed) {
        entry.lastBroadcastRank = newRank;
        entry.lastBroadcastPoints = newPoints;
      } else if (oldRank !== newRank || oldPoints !== newPoints) {
        diffs.push({
          squadId: entry.squad.squadId,
          userId: entry.squad.userId,
          username: entry.squad.username,
          squadName: entry.squad.squadName,
          oldRank,
          newRank,
          rankDelta: oldRank !== null ? oldRank - newRank : 0,
          oldPoints,
          newPoints,
          pointsDelta: newPoints - oldPoints,
          livePoints: entry.squad.livePoints,
        });
        entry.lastBroadcastRank = newRank;
        entry.lastBroadcastPoints = newPoints;
      }
    }

    return diffs;
  }

  /**
   * Returns current provisional live standings for a league in O(N) without any DB query.
   */
  public getLeagueLeaderboard(leagueId: string): ProvisionalLeaderboardEntry[] {
    const league = this.leagues.get(leagueId);
    if (!league) return [];

    return league.entries.map((entry) => ({
      rank: entry.rank,
      competitionRank: entry.competitionRank,
      previousRank: entry.previousRank,
      rankDelta: entry.previousRank !== null ? entry.previousRank - entry.rank : 0,
      squadId: entry.squad.squadId,
      userId: entry.squad.userId,
      username: entry.squad.username,
      squadName: entry.squad.squadName,
      basePoints: entry.squad.basePoints,
      livePoints: entry.squad.livePoints,
      totalPoints: entry.squad.totalPoints,
      joinedAtMs: entry.squad.joinedAtMs,
    }));
  }

  /**
   * Returns a single squad's provisional rank and points within a league.
   */
  public getSquadLeaguePosition(
    leagueId: string,
    squadId: string
  ): ProvisionalLeaderboardEntry | null {
    const league = this.leagues.get(leagueId);
    if (!league) return null;
    const entry = league.entryBySquadId.get(squadId);
    if (!entry) return null;

    return {
      rank: entry.rank,
      competitionRank: entry.competitionRank,
      previousRank: entry.previousRank,
      rankDelta: entry.previousRank !== null ? entry.previousRank - entry.rank : 0,
      squadId: entry.squad.squadId,
      userId: entry.squad.userId,
      username: entry.squad.username,
      squadName: entry.squad.squadName,
      basePoints: entry.squad.basePoints,
      livePoints: entry.squad.livePoints,
      totalPoints: entry.squad.totalPoints,
      joinedAtMs: entry.squad.joinedAtMs,
    };
  }

  /**
   * Reconciles provisional in-memory & Redis ZSET rankings against final database
   * records at gameweek close, resolving any drift and persisting final ranks/points.
   */
  public async reconcileWithDatabase(
    gameweekId: number,
    targetLeagueId?: string
  ): Promise<LeaderboardReconciliationReport> {
    const adjustments: LeaderboardReconciliationAdjustment[] = [];
    let leaguesReconciled = 0;
    let squadsChecked = 0;

    const leagueIds = targetLeagueId
      ? [targetLeagueId]
      : Array.from(this.leagues.keys());

    const pipeline = this.redis?.pipeline ? this.redis.pipeline() : null;
    const globalKey = LiveProvisionalLeaderboardService.globalZSetKey(gameweekId);

    for (const leagueId of leagueIds) {
      const leagueState = this.leagues.get(leagueId);
      if (!leagueState) continue;
      leaguesReconciled++;

      // Fetch final database records for this league's members and their gameweek scores
      const dbMembers =
        (await this.db?.leagueMember?.findMany?.({
          where: { leagueId },
          orderBy: [{ totalPoints: "desc" }, { joinedAt: "asc" }],
        })) ?? [];

      const squadIds = leagueState.entries.map((e) => e.squad.squadId);
      const dbGwScores =
        (await this.db?.squadGameweekScore?.findMany?.({
          where: {
            gameweekId,
            squadId: { in: squadIds },
          },
        })) ?? [];

      const gwScoreBySquad = new Map<string, number>(
        dbGwScores.map((s: any) => [s.squadId, Number(s.points)])
      );
      const dbMemberBySquad = new Map<string, any>(
        dbMembers.map((m: any) => [m.squadId, m])
      );

      // Update each squad's points to match authoritative database records if present
      for (const entry of leagueState.entries) {
        squadsChecked++;
        const squad = entry.squad;
        const dbGwPoints = gwScoreBySquad.get(squad.squadId);
        const dbMember = dbMemberBySquad.get(squad.squadId);

        const authoritativeLivePoints =
          dbGwPoints !== undefined ? dbGwPoints : squad.livePoints;
        const authoritativeTotalPoints =
          dbGwPoints !== undefined
            ? squad.basePoints + dbGwPoints
            : dbMember?.totalPoints !== undefined
              ? Number(dbMember.totalPoints)
              : squad.totalPoints;

        if (squad.totalPoints !== authoritativeTotalPoints) {
          const prevPoints = squad.totalPoints;
          const prevRank = entry.rank;
          squad.livePoints = authoritativeLivePoints;
          squad.totalPoints = authoritativeTotalPoints;

          adjustments.push({
            leagueId,
            squadId: squad.squadId,
            provisionalPoints: prevPoints,
            finalPoints: authoritativeTotalPoints,
            provisionalRank: prevRank,
            finalRank: entry.rank, // updated below after re-ranking
          });
        }
      }

      // Re-rank with final points
      this.recalculateLeagueRanks(leagueState, false);

      const leagueKey = LiveProvisionalLeaderboardService.leagueZSetKey(leagueId, gameweekId);

      // Update final ranks in adjustment records, Redis ZSET, and DB LeagueMember rows
      for (const entry of leagueState.entries) {
        const adj = adjustments.find(
          (a) => a.leagueId === leagueId && a.squadId === entry.squad.squadId
        );
        if (adj) {
          adj.finalRank = entry.rank;
        }

        if (pipeline) {
          pipeline.zadd(leagueKey, entry.squad.totalPoints, entry.squad.squadId);
          pipeline.zadd(globalKey, entry.squad.totalPoints, entry.squad.squadId);
        } else if (this.redis?.zadd) {
          await this.redis.zadd(leagueKey, entry.squad.totalPoints, entry.squad.squadId);
          await this.redis.zadd(globalKey, entry.squad.totalPoints, entry.squad.squadId);
        }

        const dbMember = dbMemberBySquad.get(entry.squad.squadId);
        if (
          dbMember &&
          this.db?.leagueMember?.update &&
          (dbMember.totalPoints !== entry.squad.totalPoints || dbMember.rank !== entry.rank)
        ) {
          await this.db.leagueMember.update({
            where: { id: dbMember.id },
            data: {
              totalPoints: entry.squad.totalPoints,
              rank: entry.rank,
            },
          });
        }
      }
    }

    if (pipeline) {
      await pipeline.exec();
    }

    return {
      gameweekId,
      leaguesReconciled,
      squadsChecked,
      discrepanciesFound: adjustments.length,
      discrepanciesResolved: adjustments.length,
      adjustments,
      syncedAt: new Date().toISOString(),
    };
  }
}

export const liveProvisionalLeaderboardService = new LiveProvisionalLeaderboardService();
