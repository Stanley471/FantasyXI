/**
 * Platform-wide player ownership/captaincy stats (issue #499).
 *
 * Computed by a post-deadline worker (see jobs/ownershipStatsRefresh.ts) right
 * after a gameweek locks, so the numbers reflect squads exactly as they stood
 * at the deadline. Cached in Redis with a 24h TTL; GET /api/v1/players/stats/ownership
 * only ever reads the cache, never recomputes on request.
 */

import { prisma } from "../../config/db.js";
import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";

export interface PlayerOwnershipStat {
  playerId: number;
  /** % of active squads that own this player. */
  ownershipPercent: number;
  /** % of active squads that have this player as captain. */
  captaincyPercent: number;
}

export interface OwnershipStatsSnapshot {
  totalActiveSquads: number;
  stats: PlayerOwnershipStat[];
  computedAt: string;
}

const CACHE_KEY = "ownership:stats:latest";
const CACHE_TTL_SECONDS = 24 * 60 * 60;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export class OwnershipStatsService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly redis: IRedisCacheClient | null;
  private memoryCache: { data: OwnershipStatsSnapshot; expiresAt: number } | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(dbClient: any = prisma, redisClient?: IRedisCacheClient | null) {
    this.db = dbClient;
    this.redis = redisClient !== undefined ? redisClient : getRedisClient();
  }

  /**
   * Recomputes ownership and captaincy percentages for every owned player
   * across every "active" squad (a squad with at least one player picked),
   * and refreshes both cache layers.
   */
  public async computeAndCache(): Promise<OwnershipStatsSnapshot> {
    const totalActiveSquads = await this.db.squad.count({
      where: { players: { some: {} } },
    });

    const ownershipRows: Array<{ playerId: number; _count: { _all: number } }> =
      await this.db.squadPlayer.groupBy({
        by: ["playerId"],
        _count: { _all: true },
      });

    const captaincyRows: Array<{ playerId: number; _count: { _all: number } }> =
      await this.db.squadPlayer.groupBy({
        by: ["playerId"],
        where: { isCaptain: true },
        _count: { _all: true },
      });
    const captaincyByPlayer = new Map(captaincyRows.map((row) => [row.playerId, row._count._all]));

    const stats: PlayerOwnershipStat[] = ownershipRows.map((row) => {
      const captainCount = captaincyByPlayer.get(row.playerId) ?? 0;
      return {
        playerId: row.playerId,
        ownershipPercent:
          totalActiveSquads > 0 ? round1((row._count._all / totalActiveSquads) * 100) : 0,
        captaincyPercent:
          totalActiveSquads > 0 ? round1((captainCount / totalActiveSquads) * 100) : 0,
      };
    });

    const snapshot: OwnershipStatsSnapshot = {
      totalActiveSquads,
      stats,
      computedAt: new Date().toISOString(),
    };

    this.memoryCache = { data: snapshot, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };

    if (this.redis) {
      try {
        await this.redis.set(CACHE_KEY, JSON.stringify(snapshot), "EX", CACHE_TTL_SECONDS);
      } catch (err) {
        console.warn("[ownership-stats] Redis SET failed:", (err as Error).message);
      }
    }

    return snapshot;
  }

  /** Reads the cached snapshot (memory, then Redis) without recomputing. */
  public async getCached(): Promise<OwnershipStatsSnapshot | null> {
    if (this.memoryCache && Date.now() < this.memoryCache.expiresAt) {
      return this.memoryCache.data;
    }

    if (this.redis) {
      try {
        const raw = await this.redis.get(CACHE_KEY);
        if (raw) {
          const data = JSON.parse(raw) as OwnershipStatsSnapshot;
          this.memoryCache = { data, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
          return data;
        }
      } catch (err) {
        console.warn("[ownership-stats] Redis GET failed:", (err as Error).message);
      }
    }

    return null;
  }
}

export const ownershipStatsService = new OwnershipStatsService();
