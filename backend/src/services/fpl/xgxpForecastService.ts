/**
 * xG/xP Forecasting Service
 *
 * Provides cached per-player xG and xP predictions for upcoming fixtures.
 *
 * - Fetches player and fixture data in bulk
 * - Computes xG and xP using regression models with shrinkage
 * - Caches predictions with TTL (default 2 hours)
 * - Targeted invalidation on injury, fixture reschedule, or data refresh
 * - Graceful degradation if cache unavailable
 * - Prevents thundering herd with backoff on cache miss
 *
 * Implements the repo's existing patterns:
 * - Uses Redis (with in-memory fallback) like fplClient
 * - Bulk data loads followed by in-memory computation
 * - Component breakdown for explainability
 */

import { PrismaClient, Position } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import {
  computeXG,
  computeXA,
  computeExpectedMinutes,
  computeXP,
  XPBreakdown,
  DataSourceType,
  XG_XP_CONFIG,
} from "./xgxpModels.js";

/**
 * Forecast for a single player in a single gameweek.
 */
export interface PlayerXGXPForecast {
  playerId: number;
  playerName: string;
  position: Position;
  gameweekId: number;
  fixtureId: number;
  opponentTeamId: number;
  opponentTeamName: string;
  isHome: boolean;
  expectedMinutes: number;
  xG: number; // Expected goals
  xA: number; // Expected assists
  xP: number; // Expected points
  components: {
    appearancePoints: number;
    expectedGoalPoints: number;
    expectedAssistPoints: number;
    expectedCleanSheetPoints: number;
    expectedCardPoints: number;
    expectedBonusPoints: number;
    expectedSavePoints: number; // GKP only
  };
  dataSource: DataSourceType; // Indicates data quality/confidence
  computedAt: Date;
}

/**
 * Bulk forecast for multiple players, with metadata.
 */
export interface ForecastBatch {
  gameweekId: number;
  playersCount: number;
  forecasts: PlayerXGXPForecast[];
  computedAt: Date;
}

/**
 * Cache key prefix and TTL definitions.
 */
const CACHE_PREFIX = "xgxp:forecast:";
const CACHE_TTL_SECONDS = 2 * 60 * 60; // 2 hours default
const CACHE_INVALIDATION_BATCH_TTL_SECONDS = 60; // Brief lock to prevent thundering herd

/**
 * Generates cache key for player forecast in a gameweek.
 */
function getCacheKey(playerId: number, gameweekId: number): string {
  return `${CACHE_PREFIX}player:${playerId}:gw:${gameweekId}`;
}

/**
 * Generates cache key for batch computation lock (thundering herd prevention).
 */
function getBatchComputationLockKey(gameweekId: number): string {
  return `${CACHE_PREFIX}batch:lock:gw:${gameweekId}`;
}

/**
 * Generates cache key for invalidation batch (for targeted cache clearing).
 */
function getInvalidationBatchKey(gameweekId: number, playerIds: number[]): string {
  const sortedIds = [...playerIds].sort((a, b) => a - b).join(",");
  return `${CACHE_PREFIX}invalidate:gw:${gameweekId}:players:${sortedIds}`;
}

export class XGXPForecastService {
  private readonly db: PrismaClient;
  private readonly redis: IRedisCacheClient | null;
  private readonly inMemoryCache = new Map<string, { data: PlayerXGXPForecast; expiresAt: number }>();

  constructor(dbClient: PrismaClient = prisma, redisClient?: IRedisCacheClient | null) {
    this.db = dbClient;
    this.redis = redisClient !== undefined ? redisClient : getRedisClient();
  }

  /**
   * Retrieves cached forecast for a single player, or computes it if cache miss.
   */
  async getForecast(playerId: number, gameweekId: number): Promise<PlayerXGXPForecast | null> {
    const cacheKey = getCacheKey(playerId, gameweekId);

    // 1. Try in-memory cache
    const memoryCached = this.inMemoryCache.get(cacheKey);
    if (memoryCached && Date.now() < memoryCached.expiresAt) {
      console.log(`[xgxp] Cache HIT (memory) for player ${playerId} GW ${gameweekId}`);
      return memoryCached.data;
    }

    // 2. Try Redis cache
    if (this.redis) {
      try {
        const redisCached = await this.redis.get(cacheKey);
        if (redisCached) {
          console.log(`[xgxp] Cache HIT (redis) for player ${playerId} GW ${gameweekId}`);
          const data = JSON.parse(redisCached) as PlayerXGXPForecast;
          this.inMemoryCache.set(cacheKey, {
            data,
            expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
          });
          return data;
        }
      } catch (err) {
        console.warn("[xgxp] Redis GET failed for %s:", cacheKey, (err as Error).message);
      }
    }

    // 3. Cache MISS: compute forecast
    console.log(`[xgxp] Cache MISS for player ${playerId} GW ${gameweekId}. Computing...`);
    const forecast = await this.computePlayerForecast(playerId, gameweekId);

    if (forecast) {
      // Cache the result
      await this.cacheForecast(cacheKey, forecast);
    }

    return forecast;
  }

  /**
   * Caches a single forecast in Redis and in-memory.
   */
  private async cacheForecast(cacheKey: string, forecast: PlayerXGXPForecast): Promise<void> {
    // In-memory cache
    this.inMemoryCache.set(cacheKey, {
      data: forecast,
      expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
    });

    // Redis cache
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(forecast), "EX", CACHE_TTL_SECONDS);
        console.log(`[xgxp] Cached forecast in Redis: ${cacheKey}`);
      } catch (err) {
        console.warn("[xgxp] Redis SET failed for %s:", cacheKey, (err as Error).message);
      }
    }
  }

  /**
   * Computes forecast for a single player and gameweek without caching.
   * Called after cache miss or for forced recomputation.
   */
  private async computePlayerForecast(
    playerId: number,
    gameweekId: number
  ): Promise<PlayerXGXPForecast | null> {
    // Fetch player
    const player = await this.db.player.findUnique({
      where: { id: playerId },
      include: { team: true },
    });

    if (!player) {
      console.warn(`[xgxp] Player ${playerId} not found`);
      return null;
    }

    // Fetch fixture for this gameweek
    const fixture = await this.db.fixture.findFirst({
      where: {
        gameweekId,
        OR: [{ homeTeamId: player.teamId }, { awayTeamId: player.teamId }],
      },
      include: {
        gameweek: true,
        homeTeam: true,
        awayTeam: true,
      },
    });

    if (!fixture) {
      console.log(`[xgxp] No fixture for player ${playerId} in GW ${gameweekId}`);
      return null;
    }

    const isHome = fixture.homeTeamId === player.teamId;
    const opponentTeam = isHome ? fixture.awayTeam : fixture.homeTeam;
    const opponentDefenseRating = isHome
      ? opponentTeam.strengthDefenceAway
      : opponentTeam.strengthDefenceHome;
    const teamDefenseRating = isHome
      ? player.team.strengthDefenceHome
      : player.team.strengthDefenceAway;

    // Compute expected minutes
    const expectedMinutes = computeExpectedMinutes({
      playerStatus: player.status,
      chanceOfPlayingNextRound: player.chanceOfPlayingNextRound,
      position: player.position,
    });

    // Compute xG and xA
    const xgBreakdown = computeXG({
      playerGoals: player.goalsScored,
      playerMinutes: player.minutesPlayed,
      position: player.position,
      opponentDefenseRating,
      isHome,
      expectedMinutes,
    });

    const xaBreakdown = computeXA({
      playerAssists: player.assists,
      playerMinutes: player.minutesPlayed,
      position: player.position,
      opponentDefenseRating,
      isHome,
      expectedMinutes,
    });

    // Compute xP (full breakdown)
    const xpBreakdown = computeXP({
      position: player.position,
      playerGoals: player.goalsScored,
      playerAssists: player.assists,
      playerMinutes: player.minutesPlayed,
      playerStatus: player.status,
      chanceOfPlayingNextRound: player.chanceOfPlayingNextRound,
      teamDefenseRating,
      opponentDefenseRating,
      isHome,
    });

    return {
      playerId: player.id,
      playerName: player.displayName,
      position: player.position,
      gameweekId,
      fixtureId: fixture.id,
      opponentTeamId: opponentTeam.id,
      opponentTeamName: opponentTeam.name,
      isHome,
      expectedMinutes: xgBreakdown.expectedMinutes,
      xG: xgBreakdown.finalXG,
      xA: xaBreakdown.finalXG,
      xP: xpBreakdown.totalXP,
      components: {
        appearancePoints: xpBreakdown.appearancePoints,
        expectedGoalPoints: xpBreakdown.expectedGoalPoints,
        expectedAssistPoints: xpBreakdown.expectedAssistPoints,
        expectedCleanSheetPoints: xpBreakdown.expectedCleanSheetPoints,
        expectedCardPoints: xpBreakdown.expectedCardPoints,
        expectedBonusPoints: xpBreakdown.expectedBonusPoints,
        expectedSavePoints: xpBreakdown.expectedSavePoints,
      },
      dataSource: xpBreakdown.dataSource,
      computedAt: new Date(),
    };
  }

  /**
   * Computes forecasts for all active players in a gameweek in a single batch.
   * Implements bulk loading, in-memory computation, and thundering herd prevention.
   *
   * @param gameweekId The gameweek to compute forecasts for
   * @param maxRuntimeMs Maximum time budget (default 10 seconds)
   * @returns Batch with all forecasts computed
   */
  async computeBatchForGameweek(
    gameweekId: number,
    maxRuntimeMs: number = 10000
  ): Promise<ForecastBatch> {
    const startTime = Date.now();

    // 1. Check for concurrent batch computation (thundering herd prevention)
    const lockKey = getBatchComputationLockKey(gameweekId);
    const canProceed = await this.acquireBatchLock(lockKey);
    if (!canProceed) {
      console.log(`[xgxp] Batch computation already in progress for GW ${gameweekId}. Skipping.`);
      return { gameweekId, playersCount: 0, forecasts: [], computedAt: new Date() };
    }

    try {
      // 2. Bulk fetch all data in a single query
      const [players, fixtures, gameweek] = await Promise.all([
        this.db.player.findMany({
          where: {
            isAvailable: true, // Only forecast available players
          },
          select: {
            id: true,
            fplId: true,
            displayName: true,
            position: true,
            teamId: true,
            goalsScored: true,
            assists: true,
            minutesPlayed: true,
            status: true,
            chanceOfPlayingNextRound: true,
            team: true,
          },
        }),
        this.db.fixture.findMany({
          where: { gameweekId },
          include: {
            homeTeam: { select: { id: true, name: true, strengthDefenceHome: true, strengthDefenceAway: true } },
            awayTeam: { select: { id: true, name: true, strengthDefenceHome: true, strengthDefenceAway: true } },
          },
        }),
        this.db.gameweek.findUnique({ where: { id: gameweekId } }),
      ]);

      console.log(`[xgxp] Batch computation for GW ${gameweekId}: ${players.length} players, ${fixtures.length} fixtures`);

      // 3. Build fixture map for fast lookup
      const fixturesByTeamId = new Map<number, typeof fixtures>();
      for (const fixture of fixtures) {
        if (!fixturesByTeamId.has(fixture.homeTeamId)) {
          fixturesByTeamId.set(fixture.homeTeamId, []);
        }
        if (!fixturesByTeamId.has(fixture.awayTeamId)) {
          fixturesByTeamId.set(fixture.awayTeamId, []);
        }
        fixturesByTeamId.get(fixture.homeTeamId)!.push(fixture);
        fixturesByTeamId.get(fixture.awayTeamId)!.push(fixture);
      }

      // 4. Compute in-memory with progress tracking
      const forecasts: PlayerXGXPForecast[] = [];
      let playersProcessed = 0;

      for (const player of players) {
        // Check time budget
        if (Date.now() - startTime > maxRuntimeMs) {
          console.warn(
            `[xgxp] Time budget exceeded after ${playersProcessed}/${players.length} players (${Date.now() - startTime}ms)`
          );
          break;
        }

        // Find fixture for this player
        const playerFixtures = fixturesByTeamId.get(player.teamId) || [];
        const fixture = playerFixtures.find(f =>
          f.gameweekId === gameweekId && (f.homeTeamId === player.teamId || f.awayTeamId === player.teamId)
        );

        if (!fixture) continue;

        const isHome = fixture.homeTeamId === player.teamId;
        const opponentTeam = isHome ? fixture.awayTeam : fixture.homeTeam;

        const expectedMinutes = computeExpectedMinutes({
          playerStatus: player.status,
          chanceOfPlayingNextRound: player.chanceOfPlayingNextRound,
          position: player.position,
        });

        const xgBreakdown = computeXG({
          playerGoals: player.goalsScored,
          playerMinutes: player.minutesPlayed,
          position: player.position,
          opponentDefenseRating: isHome ? opponentTeam.strengthDefenceAway : opponentTeam.strengthDefenceHome,
          isHome,
          expectedMinutes,
        });

        const xaBreakdown = computeXA({
          playerAssists: player.assists,
          playerMinutes: player.minutesPlayed,
          position: player.position,
          opponentDefenseRating: isHome ? opponentTeam.strengthDefenceAway : opponentTeam.strengthDefenceHome,
          isHome,
          expectedMinutes,
        });

        const xpBreakdown = computeXP({
          position: player.position,
          playerGoals: player.goalsScored,
          playerAssists: player.assists,
          playerMinutes: player.minutesPlayed,
          playerStatus: player.status,
          chanceOfPlayingNextRound: player.chanceOfPlayingNextRound,
          teamDefenseRating: isHome ? (player.team as any).strengthDefenceHome : (player.team as any).strengthDefenceAway,
          opponentDefenseRating: isHome ? opponentTeam.strengthDefenceAway : opponentTeam.strengthDefenceHome,
          isHome,
        });

        const forecast: PlayerXGXPForecast = {
          playerId: player.id,
          playerName: player.displayName,
          position: player.position,
          gameweekId,
          fixtureId: fixture.id,
          opponentTeamId: opponentTeam.id,
          opponentTeamName: opponentTeam.name,
          isHome,
          expectedMinutes: xgBreakdown.expectedMinutes,
          xG: xgBreakdown.finalXG,
          xA: xaBreakdown.finalXG,
          xP: xpBreakdown.totalXP,
          components: {
            appearancePoints: xpBreakdown.appearancePoints,
            expectedGoalPoints: xpBreakdown.expectedGoalPoints,
            expectedAssistPoints: xpBreakdown.expectedAssistPoints,
            expectedCleanSheetPoints: xpBreakdown.expectedCleanSheetPoints,
            expectedCardPoints: xpBreakdown.expectedCardPoints,
            expectedBonusPoints: xpBreakdown.expectedBonusPoints,
            expectedSavePoints: xpBreakdown.expectedSavePoints,
          },
          dataSource: xpBreakdown.dataSource,
          computedAt: new Date(),
        };

        forecasts.push(forecast);
        playersProcessed++;
      }

      // 5. Cache all forecasts in parallel
      const cacheOps = forecasts.map(f => this.cacheForecast(getCacheKey(f.playerId, gameweekId), f));
      await Promise.allSettled(cacheOps);

      const elapsed = Date.now() - startTime;
      console.log(`[xgxp] Batch computation completed: ${playersProcessed} forecasts in ${elapsed}ms`);

      return {
        gameweekId,
        playersCount: playersProcessed,
        forecasts,
        computedAt: new Date(),
      };
    } finally {
      // Always release the batch lock
      await this.releaseBatchLock(lockKey);
    }
  }

  /**
   * Invalidates cached forecasts for specific players (due to injury or fixture reschedule).
   * Targeted invalidation only affects the specified players, not entire gameweek.
   */
  async invalidatePlayerForecasts(gameweekId: number, playerIds: number[]): Promise<void> {
    if (playerIds.length === 0) return;

    console.log(`[xgxp] Invalidating forecasts for ${playerIds.length} players in GW ${gameweekId}`);

    const keysToDelete = playerIds.map(pId => getCacheKey(pId, gameweekId));

    // Delete from in-memory cache
    for (const key of keysToDelete) {
      this.inMemoryCache.delete(key);
    }

    // Delete from Redis
    if (this.redis && keysToDelete.length > 0) {
      try {
        await this.redis.del(...keysToDelete);
        console.log(`[xgxp] Deleted ${keysToDelete.length} forecasts from Redis cache`);
      } catch (err) {
        console.warn(`[xgxp] Redis batch delete failed:`, (err as Error).message);
      }
    }
  }

  /**
   * Acquires a distributed lock for batch computation to prevent thundering herd.
   * Returns true if lock acquired; false if already held.
   */
  private async acquireBatchLock(lockKey: string): Promise<boolean> {
    if (this.redis) {
      try {
        // SET only if not exists (NX), with TTL
        const result = await this.redis.set(lockKey, "1", "NX", "EX", CACHE_INVALIDATION_BATCH_TTL_SECONDS);
        if (result === "OK") {
          console.log(`[xgxp] Acquired batch computation lock: ${lockKey}`);
          return true;
        }
        return false;
      } catch (err) {
        console.warn(`[xgxp] Redis lock acquisition failed:`, (err as Error).message);
        // Degrade: assume lock not held, proceed anyway
        return true;
      }
    }
    // No Redis: no distributed locking, proceed
    return true;
  }

  /**
   * Releases the batch computation lock.
   */
  private async releaseBatchLock(lockKey: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(lockKey);
      } catch (err) {
        console.warn(`[xgxp] Redis lock release failed:`, (err as Error).message);
      }
    }
  }

  /**
   * Clears all xG/xP forecast cache.
   */
  async clearAllCache(): Promise<void> {
    this.inMemoryCache.clear();

    if (this.redis) {
      try {
        const keys = await this.redis.keys(`${CACHE_PREFIX}*`);
        if (keys.length > 0) {
          await this.redis.del(...keys);
          console.log(`[xgxp] Cleared ${keys.length} forecast keys from Redis`);
        }
      } catch (err) {
        console.warn(`[xgxp] Redis cache clear failed:`, (err as Error).message);
      }
    }
  }
}

// Singleton instance
export const xgxpForecastService = new XGXPForecastService();

export default xgxpForecastService;
