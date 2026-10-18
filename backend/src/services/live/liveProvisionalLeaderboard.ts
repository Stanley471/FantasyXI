import { EventEmitter } from "events";
import { prisma } from "../../config/db.js";
import { getRedisClient } from "../../config/redis.js";
import { ChipType, MembershipStatus } from "../../types/index.js";
import type { LiveWebSocketGateway } from "./liveTimelineService.js";

/**
 * Live Provisional Leaderboard (issue #268).
 *
 * Keeps one Redis sorted set per league for the live gameweek so rank updates
 * never touch the primary database while matches are in play:
 *
 *   prime (DB, once per gameweek) -> ingest events (Redis only) -> reconcile (DB, at close)
 *
 * Each member's ZSET score packs the full live tie-break into one number:
 *
 *   score = totalPoints * TOTAL_WEIGHT + (livePoints + LIVE_OFFSET) * LIVE_WEIGHT + joinTieBreak
 *
 * so ZREVRANK orders by total points, then live gameweek points, then earliest
 * join (the same order as rankLiveStandings in liveService). A player scoring d
 * points moves every holding squad by d * multiplier in both the total and live
 * components, applied with one atomic MULTI of ZINCRBY commands.
 *
 * Provisional scores apply the multipliers fixed at kickoff (captain x2, Triple
 * Captain x3, bench only with Bench Boost). Auto-substitutions and vice-captain
 * promotion are settled by the scoring engine; `reconcile` then realigns the
 * sorted sets with the final database scores.
 */

export const LIVE_WEIGHT = 100_000;
const LIVE_RANGE = 2_000;
export const LIVE_OFFSET = 500;
export const TOTAL_WEIGHT = LIVE_RANGE * LIVE_WEIGHT;
export const MAX_LEAGUE_SIZE = LIVE_WEIGHT - 1;
/** Long enough to outlive a gameweek with midweek fixtures until settlement reconciles it */
export const PROVISIONAL_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_STANDINGS_PUSH_SIZE = 50;

/** Chainable Redis command subset used here (ioredis multi/pipeline satisfies it). */
export interface LeaderboardRedisChain {
  del(...keys: string[]): LeaderboardRedisChain;
  hset(key: string, field: string, value: string | number): LeaderboardRedisChain;
  hgetall(key: string): LeaderboardRedisChain;
  hmget(key: string, ...fields: string[]): LeaderboardRedisChain;
  hincrby(key: string, field: string, increment: number): LeaderboardRedisChain;
  sadd(key: string, ...members: string[]): LeaderboardRedisChain;
  smembers(key: string): LeaderboardRedisChain;
  zadd(key: string, score: number, member: string): LeaderboardRedisChain;
  zincrby(key: string, increment: number, member: string): LeaderboardRedisChain;
  zrevrank(key: string, member: string): LeaderboardRedisChain;
  zrevrange(key: string, start: number, stop: number, withScores: "WITHSCORES"): LeaderboardRedisChain;
  expire(key: string, seconds: number): LeaderboardRedisChain;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface LeaderboardRedis {
  /** Atomic transaction */
  multi(): LeaderboardRedisChain;
  /** Non-atomic batch (one round trip) */
  pipeline(): LeaderboardRedisChain;
}

export interface ProvisionalLeagueSeed {
  leagueId: string;
  members: Array<{
    squadId: string;
    /** Points banked from completed gameweeks inside the league window */
    basePoints: number;
    joinedAt: Date | string;
  }>;
}

export interface ProvisionalSquadSeed {
  squadId: string;
  /** Live gameweek points before any match event, e.g. minus the transfer hit */
  livePoints?: number;
  /** Players whose points count for this squad, with their multiplier */
  players: Array<{ playerId: number; multiplier: number }>;
}

export interface ProvisionalSeed {
  leagues: ProvisionalLeagueSeed[];
  squads: ProvisionalSquadSeed[];
}

export interface PlayerPointsEvent {
  playerId: number;
  pointsDelta: number;
}

export interface PlayerPointsTotal {
  playerId: number;
  totalPoints: number;
}

export interface ProvisionalRankChange {
  squadId: string;
  previousRank: number;
  rank: number;
  points: number;
  livePoints: number;
  pointsDelta: number;
}

export interface ProvisionalStanding {
  rank: number;
  squadId: string;
  points: number;
  livePoints: number;
}

export interface ProvisionalRankUpdate {
  gameweekId: number;
  leagueId: string;
  reason: "event" | "reconciled";
  changes: ProvisionalRankChange[];
  /** Fresh top standings, included when someone is subscribed to the league */
  standings?: ProvisionalStanding[];
  generatedAt: string;
}

export interface IngestResult {
  gameweekId: number;
  playersApplied: number;
  squadsUpdated: number;
  updates: ProvisionalRankUpdate[];
  durationMs: number;
}

export interface ReconciliationReport {
  gameweekId: number;
  leaguesReconciled: number;
  membersReconciled: number;
  discrepancies: Array<{ leagueId: string; squadId: string; provisionalPoints: number; finalPoints: number }>;
  missingFinalScores: string[];
}

export function encodeScore(totalPoints: number, livePoints: number, tieBreak: number): number {
  const live = livePoints + LIVE_OFFSET;
  if (!Number.isInteger(totalPoints) || !Number.isInteger(livePoints) || live < 0 || live >= LIVE_RANGE) {
    throw new RangeError(`Live points ${livePoints} outside the provisional leaderboard range`);
  }
  return totalPoints * TOTAL_WEIGHT + live * LIVE_WEIGHT + tieBreak;
}

export function decodeScore(score: number): { points: number; livePoints: number } {
  const points = Math.floor(score / TOTAL_WEIGHT);
  const rest = score - points * TOTAL_WEIGHT;
  return { points, livePoints: Math.floor(rest / LIVE_WEIGHT) - LIVE_OFFSET };
}

const keys = (gw: number) => {
  const p = `live:lb:${gw}`;
  return {
    leagues: `${p}:leagues`,
    players: `${p}:players`,
    squadLive: `${p}:squad-live`,
    playerPoints: `${p}:player-points`,
    league: (leagueId: string) => `${p}:league:${leagueId}`,
    leagueMeta: (leagueId: string) => `${p}:league:${leagueId}:meta`,
    player: (playerId: number | string) => `${p}:player:${playerId}`,
  };
};

async function run(chain: LeaderboardRedisChain): Promise<unknown[]> {
  const results = (await chain.exec()) ?? [];
  return results.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

function parseStandings(flat: string[]): ProvisionalStanding[] {
  const standings: ProvisionalStanding[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    standings.push({ rank: i / 2 + 1, squadId: flat[i], ...decodeScore(Number(flat[i + 1])) });
  }
  return standings;
}

export class LiveProvisionalLeaderboardService {
  private readonly emitter = new EventEmitter();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly redisFactory: () => LeaderboardRedis | null = defaultLeaderboardRedis,
    private readonly gateway: LiveWebSocketGateway | null = null,
    private readonly options: { standingsPushSize?: number; ttlSeconds?: number } = {}
  ) {
    this.emitter.setMaxListeners(0);
  }

  /** Subscribes to provisional rank updates for one league; returns the unsubscribe function. */
  public subscribe(leagueId: string, listener: (update: ProvisionalRankUpdate) => void): () => void {
    this.emitter.on(`league:${leagueId}`, listener);
    return () => this.emitter.off(`league:${leagueId}`, listener);
  }

  /** Subscribes to every provisional rank update. */
  public onUpdate(listener: (update: ProvisionalRankUpdate) => void): () => void {
    this.emitter.on("update", listener);
    return () => this.emitter.off("update", listener);
  }

  /** Replaces all provisional state for a gameweek. */
  public async prime(gameweekId: number, seed: ProvisionalSeed): Promise<void> {
    return this.serialize(() => this.primeNow(gameweekId, seed));
  }

  /** Applies point deltas from the live match event stream (Redis only, no database reads). */
  public async ingestEvents(gameweekId: number, events: PlayerPointsEvent[]): Promise<IngestResult> {
    return this.serialize(async () => {
      const deltas = new Map<number, number>();
      for (const e of events) {
        if (!Number.isInteger(e.pointsDelta) || e.pointsDelta === 0) continue;
        deltas.set(e.playerId, (deltas.get(e.playerId) ?? 0) + e.pointsDelta);
      }
      return this.applyDeltas(gameweekId, deltas);
    });
  }

  /**
   * Applies absolute live point totals per player. Idempotent: deltas are taken
   * against the totals last applied, so replaying a poll after a restart is safe.
   */
  public async ingestPlayerTotals(gameweekId: number, totals: PlayerPointsTotal[]): Promise<IngestResult> {
    return this.serialize(async () => {
      const latest = new Map<number, number>();
      for (const t of totals) {
        if (Number.isInteger(t.totalPoints)) latest.set(t.playerId, t.totalPoints);
      }
      const redis = this.requireRedis();
      const ids = [...latest.keys()];
      const stored =
        ids.length > 0
          ? ((await run(redis.pipeline().hmget(keys(gameweekId).playerPoints, ...ids.map(String))))[0] as Array<
              string | null
            >)
          : [];
      const deltas = new Map<number, number>();
      ids.forEach((id, i) => {
        const delta = latest.get(id)! - Number(stored[i] ?? 0);
        if (delta !== 0) deltas.set(id, delta);
      });
      return this.applyDeltas(gameweekId, deltas);
    });
  }

  /** Current provisional standings for a league, from Redis only. */
  public async getStandings(gameweekId: number, leagueId: string, limit = 100): Promise<ProvisionalStanding[]> {
    const redis = this.requireRedis();
    const [flat] = await run(redis.pipeline().zrevrange(keys(gameweekId).league(leagueId), 0, limit - 1, "WITHSCORES"));
    return parseStandings(flat as string[]);
  }

  /**
   * Realigns every league with the final gameweek scores (squadId -> final
   * gameweek points from SquadGameweekScore) and reports what differed.
   */
  public async reconcile(gameweekId: number, finalLivePoints: Map<string, number>): Promise<ReconciliationReport> {
    return this.serialize(async () => {
      const redis = this.requireRedis();
      const k = keys(gameweekId);
      const [leagueIds] = (await run(redis.pipeline().smembers(k.leagues))) as [string[]];

      const reads = redis.pipeline();
      for (const leagueId of leagueIds) {
        reads.hgetall(k.leagueMeta(leagueId));
        reads.zrevrange(k.league(leagueId), 0, -1, "WITHSCORES");
      }
      const results = await run(reads);

      const report: ReconciliationReport = {
        gameweekId,
        leaguesReconciled: leagueIds.length,
        membersReconciled: 0,
        discrepancies: [],
        missingFinalScores: [],
      };
      const missing = new Set<string>();
      const writes = redis.multi();
      const changedLeagues = new Map<string, ProvisionalRankChange[]>();

      leagueIds.forEach((leagueId, i) => {
        const meta = results[i * 2] as Record<string, string>;
        const before = parseStandings(results[i * 2 + 1] as string[]);
        const beforeBySquad = new Map(before.map((s) => [s.squadId, s]));
        const after: Array<{ squadId: string; score: number }> = [];

        for (const [squadId, raw] of Object.entries(meta)) {
          const [base, tie] = raw.split("|").map(Number);
          const finalLive = finalLivePoints.get(squadId);
          if (finalLive === undefined) missing.add(squadId);
          const live = finalLive ?? 0;
          const score = encodeScore(base + live, live, tie);
          writes.zadd(k.league(leagueId), score, squadId);
          writes.hset(k.squadLive, squadId, live);
          after.push({ squadId, score });
          report.membersReconciled++;

          const provisional = beforeBySquad.get(squadId);
          if (!provisional || provisional.points !== base + live) {
            report.discrepancies.push({
              leagueId,
              squadId,
              provisionalPoints: provisional?.points ?? base,
              finalPoints: base + live,
            });
          }
        }

        after.sort((a, b) => b.score - a.score);
        const changes: ProvisionalRankChange[] = [];
        after.forEach(({ squadId, score }, idx) => {
          const prev = beforeBySquad.get(squadId);
          const decoded = decodeScore(score);
          if (!prev || prev.rank !== idx + 1 || prev.points !== decoded.points) {
            changes.push({
              squadId,
              previousRank: prev?.rank ?? idx + 1,
              rank: idx + 1,
              ...decoded,
              pointsDelta: decoded.points - (prev?.points ?? decoded.points),
            });
          }
        });
        if (changes.length > 0) changedLeagues.set(leagueId, changes);
      });

      await run(writes);
      report.missingFinalScores = [...missing];
      await this.publish(gameweekId, changedLeagues, "reconciled");
      return report;
    });
  }

  /** Removes all provisional state for a gameweek. */
  public async clear(gameweekId: number): Promise<void> {
    return this.serialize(() => this.clearNow(gameweekId));
  }

  private async primeNow(gameweekId: number, seed: ProvisionalSeed): Promise<void> {
    await this.clearNow(gameweekId);
    const redis = this.requireRedis();
    const k = keys(gameweekId);
    const ttl = this.options.ttlSeconds ?? PROVISIONAL_KEY_TTL_SECONDS;
    const chain = redis.multi();
    const touched = new Set<string>([k.leagues, k.players, k.squadLive, k.playerPoints]);

    const leaguesBySquad = new Map<string, string[]>();
    for (const league of seed.leagues) {
      if (league.members.length > MAX_LEAGUE_SIZE) {
        throw new RangeError(`League ${league.leagueId} exceeds ${MAX_LEAGUE_SIZE} members`);
      }
      for (const m of league.members) {
        const list = leaguesBySquad.get(m.squadId) ?? [];
        list.push(league.leagueId);
        leaguesBySquad.set(m.squadId, list);
      }
    }
    const squadLive = new Map(seed.squads.map((s) => [s.squadId, s.livePoints ?? 0]));

    for (const league of seed.leagues) {
      chain.sadd(k.leagues, league.leagueId);
      const ordered = [...league.members].sort(
        (a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime() || a.squadId.localeCompare(b.squadId)
      );
      ordered.forEach((m, idx) => {
        const tie = MAX_LEAGUE_SIZE - 1 - idx;
        const live = squadLive.get(m.squadId) ?? 0;
        chain.zadd(k.league(league.leagueId), encodeScore(m.basePoints + live, live, tie), m.squadId);
        chain.hset(k.leagueMeta(league.leagueId), m.squadId, `${m.basePoints}|${tie}`);
      });
      touched.add(k.league(league.leagueId));
      touched.add(k.leagueMeta(league.leagueId));
    }

    for (const squad of seed.squads) {
      const leagues = leaguesBySquad.get(squad.squadId);
      if (!leagues) continue;
      chain.hset(k.squadLive, squad.squadId, squad.livePoints ?? 0);
      for (const { playerId, multiplier } of squad.players) {
        if (!(multiplier > 0)) continue;
        chain.sadd(k.players, String(playerId));
        chain.hset(k.player(playerId), squad.squadId, JSON.stringify({ m: multiplier, l: leagues }));
        touched.add(k.player(playerId));
      }
    }

    for (const key of touched) chain.expire(key, ttl);
    await run(chain);
  }

  private async clearNow(gameweekId: number): Promise<void> {
    const redis = this.requireRedis();
    const k = keys(gameweekId);
    const [leagueIds, playerIds] = (await run(redis.pipeline().smembers(k.leagues).smembers(k.players))) as [
      string[],
      string[],
    ];
    const toDelete = [
      k.leagues,
      k.players,
      k.squadLive,
      k.playerPoints,
      ...leagueIds.flatMap((id) => [k.league(id), k.leagueMeta(id)]),
      ...playerIds.map((id) => k.player(id)),
    ];
    await run(redis.pipeline().del(...toDelete));
  }

  private async applyDeltas(gameweekId: number, deltas: Map<number, number>): Promise<IngestResult> {
    const started = performance.now();
    const result: IngestResult = { gameweekId, playersApplied: 0, squadsUpdated: 0, updates: [], durationMs: 0 };
    if (deltas.size === 0) return result;

    const redis = this.requireRedis();
    const k = keys(gameweekId);
    const playerIds = [...deltas.keys()];

    // 1 round trip: who holds each scoring player, with multiplier and leagues
    const lookup = redis.pipeline();
    for (const id of playerIds) lookup.hgetall(k.player(id));
    const holdings = (await run(lookup)) as Array<Record<string, string>>;

    const squadDelta = new Map<string, number>();
    const squadLeagues = new Map<string, string[]>();
    playerIds.forEach((playerId, i) => {
      for (const [squadId, raw] of Object.entries(holdings[i] ?? {})) {
        const { m, l } = JSON.parse(raw) as { m: number; l: string[] };
        squadDelta.set(squadId, (squadDelta.get(squadId) ?? 0) + deltas.get(playerId)! * m);
        squadLeagues.set(squadId, l);
      }
    });

    // 1 atomic round trip: rank before, ZINCRBY, rank after for every (league, squad)
    const tx = redis.multi();
    for (const [playerId, delta] of deltas) tx.hincrby(k.playerPoints, String(playerId), delta);
    const order: Array<{ leagueId: string; squadId: string; delta: number }> = [];
    for (const [squadId, delta] of squadDelta) {
      if (delta === 0) continue;
      tx.hincrby(k.squadLive, squadId, delta);
      for (const leagueId of squadLeagues.get(squadId)!) {
        tx.zrevrank(k.league(leagueId), squadId);
        tx.zincrby(k.league(leagueId), delta * (TOTAL_WEIGHT + LIVE_WEIGHT), squadId);
        tx.zrevrank(k.league(leagueId), squadId);
        order.push({ leagueId, squadId, delta });
      }
    }
    // Refresh expiry so state created by an ingest before priming cannot leak
    const ttl = this.options.ttlSeconds ?? PROVISIONAL_KEY_TTL_SECONDS;
    tx.expire(k.playerPoints, ttl);
    tx.expire(k.squadLive, ttl);
    const replies = await run(tx);

    const byLeague = new Map<string, ProvisionalRankChange[]>();
    // Replies are laid out as: player HINCRBYs, then per squad one HINCRBY followed by 3 replies per league
    let cursor = deltas.size;
    let seenSquad: string | null = null;
    for (const entry of order) {
      if (entry.squadId !== seenSquad) {
        cursor++; // squad-live HINCRBY
        seenSquad = entry.squadId;
      }
      const before = replies[cursor] as number | null;
      const score = Number(replies[cursor + 1]);
      const after = replies[cursor + 2] as number;
      cursor += 3;
      const list = byLeague.get(entry.leagueId) ?? [];
      list.push({
        squadId: entry.squadId,
        previousRank: (before ?? after) + 1,
        rank: after + 1,
        ...decodeScore(score),
        pointsDelta: entry.delta,
      });
      byLeague.set(entry.leagueId, list);
    }

    result.playersApplied = deltas.size;
    result.squadsUpdated = [...squadDelta.values()].filter((d) => d !== 0).length;
    result.updates = await this.publish(gameweekId, byLeague, "event");
    result.durationMs = performance.now() - started;
    return result;
  }

  private async publish(
    gameweekId: number,
    byLeague: Map<string, ProvisionalRankChange[]>,
    reason: ProvisionalRankUpdate["reason"]
  ): Promise<ProvisionalRankUpdate[]> {
    const watched = [...byLeague.keys()].filter((id) => this.emitter.listenerCount(`league:${id}`) > 0);
    const standings = new Map<string, ProvisionalStanding[]>();
    if (watched.length > 0) {
      const size = this.options.standingsPushSize ?? DEFAULT_STANDINGS_PUSH_SIZE;
      const reads = this.requireRedis().pipeline();
      for (const id of watched) reads.zrevrange(keys(gameweekId).league(id), 0, size - 1, "WITHSCORES");
      const results = await run(reads);
      watched.forEach((id, i) => standings.set(id, parseStandings(results[i] as string[])));
    }

    const generatedAt = new Date().toISOString();
    const updates: ProvisionalRankUpdate[] = [];
    for (const [leagueId, changes] of byLeague) {
      const update: ProvisionalRankUpdate = {
        gameweekId,
        leagueId,
        reason,
        changes,
        ...(standings.has(leagueId) ? { standings: standings.get(leagueId) } : {}),
        generatedAt,
      };
      updates.push(update);
      this.emitter.emit(`league:${leagueId}`, update);
      this.emitter.emit("update", update);
      if (this.gateway?.broadcastToLeague) {
        try {
          await this.gateway.broadcastToLeague(leagueId, "PROVISIONAL_RANKS_UPDATED", update);
        } catch (err) {
          console.warn(`[LiveProvisionalLeaderboard] Broadcast failed for league ${leagueId}: ${err}`);
        }
      }
    }
    return updates;
  }

  private requireRedis(): LeaderboardRedis {
    const redis = this.redisFactory();
    if (!redis) throw new Error("Provisional leaderboard store is unavailable");
    return redis;
  }

  /** Runs state changes one at a time so concurrent ingests cannot interleave reads and writes. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(fn);
    this.queue = next;
    return next;
  }
}

/**
 * Loads the seed for a gameweek from the database (run once at kickoff, never
 * during the live stream) and the final scores used for reconciliation.
 */
export class ProvisionalLeaderboardLoader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  public async loadSeed(gameweekId: number): Promise<ProvisionalSeed> {
    const leagues = await this.db.league.findMany({
      where: { status: "ACTIVE", startGameweekId: { lte: gameweekId }, endGameweekId: { gte: gameweekId } },
      select: {
        id: true,
        startGameweekId: true,
        endGameweekId: true,
        members: {
          where: { status: { notIn: [MembershipStatus.CANCELLED, MembershipStatus.REFUNDED] } },
          select: { squadId: true, joinedAt: true },
        },
      },
    });
    const squadIds: string[] = [...new Set<string>(leagues.flatMap((l: any) => l.members.map((m: any) => m.squadId)))];
    if (squadIds.length === 0) return { leagues: [], squads: [] };

    const minStart = Math.min(...leagues.map((l: any) => l.startGameweekId));
    const [scores, squadPlayers, chips, hits] = await Promise.all([
      this.db.squadGameweekScore.findMany({
        where: { squadId: { in: squadIds }, gameweekId: { gte: minStart, lt: gameweekId } },
        select: { squadId: true, gameweekId: true, points: true },
      }),
      this.db.squadPlayer.findMany({
        where: { squadId: { in: squadIds } },
        select: { squadId: true, playerId: true, isStarter: true, isCaptain: true },
      }),
      this.db.squadChipUsage.findMany({
        where: { squadId: { in: squadIds }, gameweekId },
        select: { squadId: true, chipType: true },
      }),
      this.db.squadTransfer.groupBy({
        by: ["squadId"],
        where: { squadId: { in: squadIds }, gameweekId },
        _sum: { pointsCost: true },
      }),
    ]);

    const chipBySquad = new Map<string, ChipType>(chips.map((c: any) => [c.squadId, c.chipType]));
    const hitsBySquad = new Map<string, number>(hits.map((h: any) => [h.squadId, h._sum.pointsCost ?? 0]));

    const seedLeagues: ProvisionalLeagueSeed[] = leagues.map((league: any) => {
      const base = new Map<string, number>();
      for (const s of scores) {
        if (s.gameweekId >= league.startGameweekId && s.gameweekId <= league.endGameweekId) {
          base.set(s.squadId, (base.get(s.squadId) ?? 0) + s.points);
        }
      }
      return {
        leagueId: league.id,
        members: league.members.map((m: any) => ({
          squadId: m.squadId,
          basePoints: base.get(m.squadId) ?? 0,
          joinedAt: m.joinedAt,
        })),
      };
    });

    const playersBySquad = new Map<string, Array<{ playerId: number; multiplier: number }>>();
    for (const sp of squadPlayers) {
      const chip = chipBySquad.get(sp.squadId);
      const multiplier = sp.isCaptain
        ? chip === ChipType.TRIPLE_CAPTAIN
          ? 3
          : 2
        : sp.isStarter || chip === ChipType.BENCH_BOOST
          ? 1
          : 0;
      const list = playersBySquad.get(sp.squadId) ?? [];
      list.push({ playerId: sp.playerId, multiplier });
      playersBySquad.set(sp.squadId, list);
    }

    return {
      leagues: seedLeagues,
      squads: squadIds.map((squadId) => {
        const chip = chipBySquad.get(squadId);
        const waived = chip === ChipType.WILDCARD || chip === ChipType.FREE_HIT;
        return {
          squadId,
          livePoints: waived ? 0 : -(hitsBySquad.get(squadId) ?? 0),
          players: playersBySquad.get(squadId) ?? [],
        };
      }),
    };
  }

  /** Live player totals already recorded for the gameweek (summed across a double gameweek). */
  public async loadPlayerTotals(gameweekId: number): Promise<PlayerPointsTotal[]> {
    const rows = await this.db.playerGameweekStats.findMany({
      where: { gameweekId },
      select: { playerId: true, totalPoints: true },
    });
    const totals = new Map<number, number>();
    for (const r of rows) totals.set(r.playerId, (totals.get(r.playerId) ?? 0) + r.totalPoints);
    return [...totals].map(([playerId, totalPoints]) => ({ playerId, totalPoints }));
  }

  /** Final gameweek points per squad from the scoring engine. */
  public async loadFinalScores(gameweekId: number): Promise<Map<string, number>> {
    const rows = await this.db.squadGameweekScore.findMany({
      where: { gameweekId },
      select: { squadId: true, points: true },
    });
    return new Map(rows.map((r: any) => [r.squadId, r.points]));
  }
}

/**
 * In-process implementation of the Redis commands above, used in tests and as
 * a single-instance fallback when Redis is disabled.
 */
export class InMemoryLeaderboardRedis implements LeaderboardRedis {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly zsets = new Map<string, Map<string, number>>();

  public multi(): LeaderboardRedisChain {
    return this.chain();
  }

  public pipeline(): LeaderboardRedisChain {
    return this.chain();
  }

  private chain(): LeaderboardRedisChain {
    const ops: Array<() => unknown> = [];
    const self = this;
    const chain: LeaderboardRedisChain = {
      del: (...ks) => (ops.push(() => ks.reduce((n, key) => n + (self.delete(key) ? 1 : 0), 0)), chain),
      hset: (key, field, value) => (ops.push(() => (self.hash(key).set(field, String(value)), 1)), chain),
      hgetall: (key) => (ops.push(() => Object.fromEntries(self.hashes.get(key) ?? [])), chain),
      hmget: (key, ...fields) => (ops.push(() => fields.map((f) => self.hashes.get(key)?.get(f) ?? null)), chain),
      hincrby: (key, field, inc) =>
        (ops.push(() => {
          const next = Number(self.hash(key).get(field) ?? 0) + inc;
          self.hash(key).set(field, String(next));
          return next;
        }),
        chain),
      sadd: (key, ...members) =>
        (ops.push(() => {
          const set = self.sets.get(key) ?? new Set<string>();
          self.sets.set(key, set);
          const before = set.size;
          for (const m of members) set.add(m);
          return set.size - before;
        }),
        chain),
      smembers: (key) => (ops.push(() => [...(self.sets.get(key) ?? [])]), chain),
      zadd: (key, score, member) => (ops.push(() => (self.zset(key).set(member, score), 1)), chain),
      zincrby: (key, inc, member) =>
        (ops.push(() => {
          const next = (self.zset(key).get(member) ?? 0) + inc;
          self.zset(key).set(member, next);
          return String(next);
        }),
        chain),
      zrevrank: (key, member) =>
        (ops.push(() => {
          const z = self.zsets.get(key);
          const score = z?.get(member);
          if (z === undefined || score === undefined) return null;
          let rank = 0;
          for (const [m, s] of z) if (s > score || (s === score && m > member)) rank++;
          return rank;
        }),
        chain),
      zrevrange: (key, start, stop) =>
        (ops.push(() => {
          const sorted = [...(self.zsets.get(key) ?? [])].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
          const end = stop < 0 ? sorted.length + stop : stop;
          return sorted.slice(start, end + 1).flatMap(([m, s]) => [m, String(s)]);
        }),
        chain),
      expire: () => (ops.push(() => 1), chain),
      exec: async () => ops.map((op) => [null, op()] as [Error | null, unknown]),
    };
    return chain;
  }

  private delete(key: string): boolean {
    return this.hashes.delete(key) || this.sets.delete(key) || this.zsets.delete(key);
  }

  private hash(key: string): Map<string, string> {
    const h = this.hashes.get(key) ?? new Map<string, string>();
    this.hashes.set(key, h);
    return h;
  }

  private zset(key: string): Map<string, number> {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    this.zsets.set(key, z);
    return z;
  }
}

let fallbackStore: InMemoryLeaderboardRedis | null = null;

/** Redis when enabled, otherwise a process-local store. */
export function defaultLeaderboardRedis(): LeaderboardRedis {
  const client = getRedisClient();
  if (client) return client as unknown as LeaderboardRedis;
  fallbackStore ??= new InMemoryLeaderboardRedis();
  return fallbackStore;
}

export const liveProvisionalLeaderboard = new LiveProvisionalLeaderboardService();
export const provisionalLeaderboardLoader = new ProvisionalLeaderboardLoader();

/**
 * Seeds the provisional leaderboard when a gameweek locks: squads and leagues
 * are read once, then any live stats already recorded are applied.
 */
export async function primeProvisionalLeaderboard(
  gameweekId: number,
  service: LiveProvisionalLeaderboardService = liveProvisionalLeaderboard,
  loader: ProvisionalLeaderboardLoader = provisionalLeaderboardLoader
): Promise<void> {
  await service.prime(gameweekId, await loader.loadSeed(gameweekId));
  await service.ingestPlayerTotals(gameweekId, await loader.loadPlayerTotals(gameweekId));
}

/** Aligns provisional ranks with the final database scores at gameweek close. */
export async function reconcileProvisionalLeaderboard(
  gameweekId: number,
  service: LiveProvisionalLeaderboardService = liveProvisionalLeaderboard,
  loader: ProvisionalLeaderboardLoader = provisionalLeaderboardLoader
): Promise<ReconciliationReport> {
  return service.reconcile(gameweekId, await loader.loadFinalScores(gameweekId));
}
