/**
 * External FPL API Client with Redis & In-Memory Caching Layer.
 *
 * Provides typed methods to query the official Fantasy Premier League endpoints:
 * - /bootstrap-static/ (teams, players, gameweeks)
 * - /fixtures/ (match fixtures)
 * - /event/{gw}/live/ (live player stats per gameweek)
 *
 * Implements a Redis caching layer (with in-memory fallback) to prevent hammering
 * the upstream FPL API, mitigate rate-limiting, and ensure sub-second response times.
 */

import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";

const FPL_BASE_URL = "https://fantasy.premierleague.com/api";

/**
 * Cache TTLs for FPL endpoints (issue #139).
 *
 * Static reference data (players, teams, gameweek calendar) changes at most a
 * few times a day, so it is cached for 24 hours to keep load on the upstream
 * FPL API to a minimum. Live gameweek scores change during matches, so they
 * are cached for only 60 seconds - long enough to absorb bursts of concurrent
 * requests without serving meaningfully stale scores.
 */
export const FPL_CACHE_TTL = {
  DEFAULT_SECONDS: 600, // 10 minutes
  BOOTSTRAP_STATIC_SECONDS: 24 * 60 * 60, // 24 hours: static player/team/gameweek data
  FIXTURES_SECONDS: 24 * 60 * 60, // 24 hours: fixtures rarely change once scheduled
  GAMEWEEK_LIVE_SECONDS: 60, // 60 seconds: live in-match scores
};

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export interface FplClientOptions {
  baseUrl?: string;
  redis?: IRedisCacheClient | null;
  keyPrefix?: string;
  defaultTtlSeconds?: number;
}

export class FplClient {
  private cache = new Map<string, CacheEntry<unknown>>();
  private baseUrl: string;
  private redis: IRedisCacheClient | null = null;
  private keyPrefix: string;
  private defaultTtlSeconds: number;

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    baseUrlOrOptions?: string | FplClientOptions,
    redisClient?: IRedisCacheClient | null
  ) {
    if (typeof baseUrlOrOptions === "object" && baseUrlOrOptions !== null) {
      this.baseUrl = baseUrlOrOptions.baseUrl || FPL_BASE_URL;
      this.redis =
        baseUrlOrOptions.redis !== undefined
          ? baseUrlOrOptions.redis
          : getRedisClient();
      this.keyPrefix = baseUrlOrOptions.keyPrefix || "fpl:cache:";
      this.defaultTtlSeconds =
        baseUrlOrOptions.defaultTtlSeconds || FPL_CACHE_TTL.DEFAULT_SECONDS;
    } else {
      this.baseUrl = baseUrlOrOptions || FPL_BASE_URL;
      this.redis = redisClient !== undefined ? redisClient : getRedisClient();
      this.keyPrefix = "fpl:cache:";
      this.defaultTtlSeconds = FPL_CACHE_TTL.DEFAULT_SECONDS;
    }
  }

  /**
   * Allows injecting or replacing the Redis cache client (e.g. for testing).
   */
  public setRedisClient(client: IRedisCacheClient | null): void {
    this.redis = client;
  }

  /**
   * Returns current Redis cache client or null.
   */
  public getRedisClient(): IRedisCacheClient | null {
    return this.redis;
  }

  private getCacheKey(endpoint: string): string {
    return `${this.keyPrefix}${endpoint}`;
  }

  private async fetchWithRetry(url: string, retries = 3, backoffMs = 1000): Promise<Response> {
    if (Date.now() < this.circuitOpenUntil) {
      const remaining = Math.ceil((this.circuitOpenUntil - Date.now()) / 1000);
      throw new Error(`FPL API Circuit Breaker is open. Skipping request. Try again in ${remaining}s.`);
    }

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "FantasyXI-App/1.0 (Educational open-source fantasy football project)",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          this.consecutiveFailures = 0;
          return response;
        }

        // Retry on rate limit (429) or server errors (5xx)
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`FPL API failed: [${response.status}] ${response.statusText}`);
        }

        // Do not retry on client errors (400-404)
        return response;
      } catch (err) {
        if (i === retries - 1) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= 5) {
            console.warn("🚨 FPL API Circuit Breaker tripped! Pausing upstream requests for 60 seconds.");
            this.circuitOpenUntil = Date.now() + 60_000;
          }
          throw err;
        }
        // Exponential backoff
        const delay = backoffMs * Math.pow(2, i);
        console.warn(`⚠️ FPL API request failed. Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Unreachable");
  }

  /**
   * Generic fetch wrapper with Redis caching, in-memory fallback, and standard User-Agent header.
   * TTL is in seconds (or auto-converted if milliseconds are passed).
   */
  public async get<T>(endpoint: string, ttlSeconds: number = this.defaultTtlSeconds): Promise<T> {
    // ttlSeconds is always whole seconds (e.g. FPL_CACHE_TTL.*). A previous
    // heuristic here mis-detected large-but-valid TTLs (like the 24-hour
    // BOOTSTRAP_STATIC_SECONDS TTL introduced in #139) as milliseconds and
    // silently divided them by 1000, so it has been removed.
    const effectiveTtlSeconds = ttlSeconds;
    const cacheKey = this.getCacheKey(endpoint);

    // 1. Try Redis cache first
    if (this.redis) {
      try {
        const cachedRaw = await this.redis.get(cacheKey);
        if (cachedRaw) {
          console.log(`[FplClient] Cache HIT (Redis) for ${cacheKey}`);
          const parsed = JSON.parse(cachedRaw) as T;
          // Synchronize local memory cache
          this.cache.set(cacheKey, {
            data: parsed,
            expiresAt: Date.now() + effectiveTtlSeconds * 1000,
          });
          return parsed;
        }
      } catch (err) {
        console.warn(
          `[FplClient] Redis GET error for ${cacheKey}, falling back:`,
          (err as Error).message
        );
      }
    }

    // 2. Try in-memory fallback cache
    const memoryCached = this.cache.get(cacheKey);
    if (memoryCached && Date.now() < memoryCached.expiresAt) {
      console.log(`[FplClient] Cache HIT (Memory) for ${cacheKey}`);
      return memoryCached.data as T;
    }

    // 3. Cache MISS: Fetch from upstream official FPL API
    console.log(`[FplClient] Cache MISS for ${cacheKey}. Fetching upstream from ${this.baseUrl}...`);
    const url = `${this.baseUrl}${endpoint}`;
    const response = await this.fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(
        `FPL API request failed permanently: [${response.status}] ${response.statusText} at ${url}`
      );
    }

    const data = (await response.json()) as T;

    // 4. Populate Redis cache
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(data), "EX", effectiveTtlSeconds);
        console.log(
          `[FplClient] Cache SET (Redis) for ${cacheKey} (TTL: ${effectiveTtlSeconds}s)`
        );
      } catch (err) {
        console.warn(
          `[FplClient] Redis SET error for ${cacheKey}:`,
          (err as Error).message
        );
      }
    }

    // 5. Populate in-memory fallback cache
    this.cache.set(cacheKey, {
      data,
      expiresAt: Date.now() + effectiveTtlSeconds * 1000,
    });

    return data;
  }

  /**
   * Clear cache manually (e.g. before an explicit force-sync).
   * Clears both in-memory cache and Redis keys.
   */
  public async clearCache(endpoint?: string): Promise<void> {
    if (endpoint) {
      const cacheKey = this.getCacheKey(endpoint);
      this.cache.delete(cacheKey);
      if (this.redis) {
        try {
          await this.redis.del(cacheKey);
          console.log(`[FplClient] Cache DEL (Redis) for ${cacheKey}`);
        } catch (err) {
          console.warn(`[FplClient] Redis DEL error for ${cacheKey}:`, (err as Error).message);
        }
      }
    } else {
      this.cache.clear();
      if (this.redis) {
        try {
          const keys = await this.redis.keys(`${this.keyPrefix}*`);
          if (keys.length > 0) {
            await this.redis.del(...keys);
            console.log(`[FplClient] Cache DEL (Redis) cleared ${keys.length} keys`);
          }
        } catch (err) {
          console.warn(`[FplClient] Redis DEL pattern error:`, (err as Error).message);
        }
      }
    }
  }

  /**
   * Fetches the core FPL dataset:
   * - events (all 38 gameweeks with deadlines)
   * - teams (all 20 Premier League clubs)
   * - elements (all ~600 players with current prices, totals, form)
   * Cached for 15 minutes.
   */
  public async getBootstrapStatic(): Promise<{
    events: Array<{
      id: number;
      name: string;
      deadline_time: string;
      is_current: boolean;
      finished: boolean;
    }>;
    teams: Array<{
      id: number;
      name: string;
      short_name: string;
      strength?: number;
      strength_overall_home?: number;
      strength_overall_away?: number;
      strength_attack_home?: number;
      strength_attack_away?: number;
      strength_defence_home?: number;
      strength_defence_away?: number;
    }>;
    elements: Array<{
      id: number;
      first_name: string;
      second_name: string;
      web_name: string;
      element_type: number; // 1 = GKP, 2 = DEF, 3 = MID, 4 = FWD
      team: number;
      now_cost: number; // Tenths of a million: e.g. 105 = 10.5m
      total_points: number;
      minutes: number;
      goals_scored: number;
      assists: number;
      clean_sheets: number;
      form?: string;
      status?: string;
      news?: string;
      chance_of_playing_next_round?: number | null;
      selected_by_percent?: string;
      photo?: string;
    }>;
  }> {
    return this.get("/bootstrap-static/", FPL_CACHE_TTL.BOOTSTRAP_STATIC_SECONDS);
  }

  /**
   * Fetches fixtures for the entire season or filtered by gameweek event ID.
   * Cached for 10 minutes.
   */
  public async getFixtures(eventId?: number): Promise<
    Array<{
      id: number;
      event: number | null;
      team_h: number;
      team_a: number;
      kickoff_time: string | null;
      started: boolean;
      finished: boolean;
      team_h_score: number | null;
      team_a_score: number | null;
      minutes: number;
    }>
  > {
    const endpoint = eventId !== undefined ? `/fixtures/?event=${eventId}` : "/fixtures/";
    return this.get(endpoint, FPL_CACHE_TTL.FIXTURES_SECONDS);
  }

  /**
   * Fetches live match stats for a specific gameweek.
   * Contains detailed stats for every player (minutes, goals, clean sheets, bonus, total points).
   * Cached for 5 minutes.
   */
  public async getGameweekLive(gameweekId: number): Promise<{
    elements: Array<{
      id: number;
      stats: {
        minutes: number;
        goals_scored: number;
        assists: number;
        clean_sheets: number;
        goals_conceded?: number;
        own_goals?: number;
        penalties_saved?: number;
        penalties_missed?: number;
        yellow_cards: number;
        red_cards: number;
        saves: number;
        bonus: number;
        total_points: number;
      };
    }>;
  }> {
    return this.get(`/event/${gameweekId}/live/`, FPL_CACHE_TTL.GAMEWEEK_LIVE_SECONDS);
  }
}

export const fplClient = new FplClient();
