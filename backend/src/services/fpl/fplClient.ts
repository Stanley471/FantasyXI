/**
 * External FPL API Client with Redis & In-Memory Caching Layer and Circuit Breaker.
 *
 * Provides typed methods to query the official Fantasy Premier League endpoints:
 * - /bootstrap-static/ (teams, players, gameweeks)
 * - /fixtures/ (match fixtures)
 * - /event/{gw}/live/ (live player stats per gameweek)
 *
 * Implements a Redis caching layer (with in-memory fallback) and a robust Circuit Breaker
 * with adaptive backoff (decorrelated jitter) and stale cache fallback.
 *
 * Read path (issue #275), cheapest tier first:
 *   fresh:  L1 in-memory -> L2 Redis -> upstream (through the circuit breaker)
 *   stale:  L1 last-known copy -> L2 Redis stale copy -> L3 PostgreSQL snapshot
 * The stale tiers are only consulted when the upstream call fails or the
 * circuit is OPEN, and they survive clearCache() so a forced sync during an
 * outage still has something to serve. Every tier is O(1) per lookup.
 */

import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerOpenError,
  CircuitState,
  calculateDecorrelatedJitter,
} from "./circuitBreaker.js";
import { FplSnapshotStore, prismaFplSnapshotStore } from "./fplSnapshotStore.js";

const FPL_BASE_URL = "https://fantasy.premierleague.com/api";

/** Smallest official endpoint (~200 bytes), used to probe recovery while the circuit is OPEN. */
const FPL_HEALTH_PROBE_ENDPOINT = "/event-status/";

function createDefaultFplCircuitBreaker(probe: () => Promise<unknown>): CircuitBreaker {
  return new CircuitBreaker({
    failureRateThreshold: 0.5,
    rollingWindowMs: 30_000,
    minimumSamples: 4,
    probe,
    onStateChange: (from, to) => {
      if (to !== CircuitState.HALF_OPEN) console.warn(`[FplClient] Circuit breaker transitioned ${from} -> ${to}`);
    },
  });
}

/**
 * Cache TTLs for FPL endpoints (issue #139).
 */
export const FPL_CACHE_TTL = {
  DEFAULT_SECONDS: 600, // 10 minutes
  BOOTSTRAP_STATIC_SECONDS: 24 * 60 * 60, // 24 hours: static player/team/gameweek data
  FIXTURES_SECONDS: 24 * 60 * 60, // 24 hours: fixtures rarely change once scheduled
  GAMEWEEK_LIVE_SECONDS: 60, // 60 seconds: live in-match scores
  STALE_FALLBACK_SECONDS: 7 * 24 * 60 * 60, // 7 days: Redis stale copy served during outages (#275)
};

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/** Fallback tier that answered while the upstream was unavailable. */
export type FplStaleTier = "memory" | "redis" | "postgres";

export interface FplFetchResult<T> {
  data: T;
  isStale: boolean;
  staleSource?: FplStaleTier;
}

export interface FplClientOptions {
  baseUrl?: string;
  redis?: IRedisCacheClient | null;
  keyPrefix?: string;
  /** Prefix of the long-lived Redis stale copies; kept apart so clearCache() never removes them */
  staleKeyPrefix?: string;
  defaultTtlSeconds?: number;
  staleTtlSeconds?: number;
  circuitBreaker?: CircuitBreaker;
  circuitBreakerOptions?: CircuitBreakerOptions;
  /** L3 tier; null disables it */
  snapshotStore?: FplSnapshotStore | null;
}

export class FplClient {
  private cache = new Map<string, CacheEntry<unknown>>();
  private staleCache = new Map<string, unknown>();
  private baseUrl: string;
  private redis: IRedisCacheClient | null = null;
  private keyPrefix: string;
  private staleKeyPrefix: string;
  private defaultTtlSeconds: number;
  private staleTtlSeconds: number;
  private snapshotStore: FplSnapshotStore | null;
  private readonly metrics = {
    l1Hits: 0,
    l2Hits: 0,
    upstreamFetches: 0,
    staleServed: { memory: 0, redis: 0, postgres: 0 } as Record<FplStaleTier, number>,
    unavailable: 0,
  };

  public readonly circuitBreaker: CircuitBreaker;

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
      this.staleKeyPrefix = baseUrlOrOptions.staleKeyPrefix || "fpl:stale:";
      this.defaultTtlSeconds =
        baseUrlOrOptions.defaultTtlSeconds || FPL_CACHE_TTL.DEFAULT_SECONDS;
      this.staleTtlSeconds =
        baseUrlOrOptions.staleTtlSeconds || FPL_CACHE_TTL.STALE_FALLBACK_SECONDS;
      this.snapshotStore =
        baseUrlOrOptions.snapshotStore !== undefined
          ? baseUrlOrOptions.snapshotStore
          : prismaFplSnapshotStore;
      this.circuitBreaker =
        baseUrlOrOptions.circuitBreaker ||
        (baseUrlOrOptions.circuitBreakerOptions
          ? new CircuitBreaker(baseUrlOrOptions.circuitBreakerOptions)
          : createDefaultFplCircuitBreaker(() => this.probeUpstream()));
    } else {
      this.baseUrl = baseUrlOrOptions || FPL_BASE_URL;
      this.redis = redisClient !== undefined ? redisClient : getRedisClient();
      this.keyPrefix = "fpl:cache:";
      this.staleKeyPrefix = "fpl:stale:";
      this.defaultTtlSeconds = FPL_CACHE_TTL.DEFAULT_SECONDS;
      this.staleTtlSeconds = FPL_CACHE_TTL.STALE_FALLBACK_SECONDS;
      this.snapshotStore = prismaFplSnapshotStore;
      this.circuitBreaker = createDefaultFplCircuitBreaker(() => this.probeUpstream());
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

  private getStaleKey(endpoint: string): string {
    return `${this.staleKeyPrefix}${endpoint}`;
  }

  /** True while the circuit is not CLOSED: data synced from FPL may be out of date. */
  public isDegraded(): boolean {
    return this.circuitBreaker.getState() !== CircuitState.CLOSED;
  }

  /** Circuit breaker state and per-tier cache metrics for admin telemetry. */
  public getTelemetry() {
    return {
      circuit: this.circuitBreaker.getStats(),
      cache: {
        l1Hits: this.metrics.l1Hits,
        l2Hits: this.metrics.l2Hits,
        upstreamFetches: this.metrics.upstreamFetches,
        staleServed: { ...this.metrics.staleServed },
        unavailable: this.metrics.unavailable,
        l1Entries: this.cache.size,
        staleEntries: this.staleCache.size,
        snapshotTierEnabled: this.snapshotStore !== null,
      },
    };
  }

  /** Single-attempt upstream health check run by the breaker while OPEN. */
  private async probeUpstream(): Promise<void> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${FPL_HEALTH_PROBE_ENDPOINT}`, 1);
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`FPL health probe failed: [${response.status}] ${response.statusText}`);
    }
  }

  private async readRedis<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      console.warn(`[FplClient] Redis GET error for ${key}, falling back:`, (err as Error).message);
      return null;
    }
  }

  private async writeRedis(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis!.set(key, value, "EX", ttlSeconds);
    } catch (err) {
      console.warn(`[FplClient] Redis SET error for ${key}:`, (err as Error).message);
    }
  }

  private remember(cacheKey: string, data: unknown, ttlSeconds: number): void {
    this.cache.set(cacheKey, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
    this.staleCache.set(cacheKey, data);
  }

  /** Writes a fresh upstream payload to every tier. */
  private async store(endpoint: string, cacheKey: string, data: unknown, ttlSeconds: number): Promise<void> {
    this.remember(cacheKey, data, ttlSeconds);
    if (this.redis) {
      const serialized = JSON.stringify(data);
      await Promise.all([
        this.writeRedis(cacheKey, serialized, ttlSeconds),
        this.writeRedis(this.getStaleKey(endpoint), serialized, this.staleTtlSeconds),
      ]);
      console.log(`[FplClient] Cache SET (Redis) for ${cacheKey} (TTL: ${ttlSeconds}s)`);
    }
    // Off the request path: a slow or unavailable database never delays fresh data
    this.snapshotStore?.save(endpoint, data).catch((err) =>
      console.warn(`[FplClient] Snapshot save failed for ${endpoint}:`, (err as Error).message)
    );
  }

  /** Stale fallback, cheapest tier first; later tiers backfill the in-memory copy. */
  private async readStale<T>(
    endpoint: string,
    cacheKey: string
  ): Promise<{ data: T; source: FplStaleTier } | null> {
    if (this.staleCache.has(cacheKey)) {
      return { data: this.staleCache.get(cacheKey) as T, source: "memory" };
    }
    const fromRedis = await this.readRedis<T>(this.getStaleKey(endpoint));
    if (fromRedis !== null) {
      this.staleCache.set(cacheKey, fromRedis);
      return { data: fromRedis, source: "redis" };
    }
    if (this.snapshotStore) {
      try {
        const snapshot = await this.snapshotStore.load(endpoint);
        if (snapshot) {
          this.staleCache.set(cacheKey, snapshot.payload);
          return { data: snapshot.payload as T, source: "postgres" };
        }
      } catch (err) {
        console.warn(`[FplClient] Snapshot load failed for ${endpoint}:`, (err as Error).message);
      }
    }
    return null;
  }

  /**
   * Fetches an upstream URL with retry logic and decorrelated jitter backoff.
   * Throws on 5xx or 429 errors so the circuit breaker can track failures.
   */
  public async fetchWithRetry(url: string, retries = 3, backoffMs = 1000): Promise<Response> {
    let currentDelay = backoffMs;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "FantasyXI-App/1.0 (Educational open-source fantasy football project)",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
        });

        // A Cloudflare challenge page (any status, `cf-mitigated: challenge`)
        // is an upstream outage for an API client, not a client error
        const cloudflareChallenge = response.headers.get("cf-mitigated") === "challenge";

        if (response.ok && !cloudflareChallenge) {
          return response;
        }

        // Retry on rate limit (429), server errors (5xx) or Cloudflare challenges
        if (response.status === 429 || response.status >= 500 || cloudflareChallenge) {
          await response.body?.cancel();
          throw new Error(`FPL API failed: [${response.status}] ${response.statusText}`);
        }

        // Do not retry on client errors (400-404)
        return response;
      } catch (err) {
        if (i === retries - 1) {
          throw err;
        }
        currentDelay = calculateDecorrelatedJitter(currentDelay, backoffMs, 30000);
        console.warn(
          `⚠️ FPL API request failed. Retrying in ${currentDelay}ms (decorrelated jitter)... (Attempt ${i + 1}/${retries})`
        );
        await new Promise((resolve) => setTimeout(resolve, currentDelay));
      }
    }
    throw new Error("Unreachable");
  }

  /**
   * Generic fetch wrapper with Redis caching, in-memory fallback, Circuit Breaker,
   * and fallback to stale data if upstream is failing or rate-limited.
   */
  public async get<T>(endpoint: string, ttlSeconds: number = this.defaultTtlSeconds): Promise<T> {
    const { data } = await this.getWithMetadata<T>(endpoint, ttlSeconds);
    return data;
  }

  /**
   * Fetch with metadata indicating whether the data returned is fresh or served stale.
   */
  public async getWithMetadata<T>(
    endpoint: string,
    ttlSeconds: number = this.defaultTtlSeconds
  ): Promise<FplFetchResult<T>> {
    const cacheKey = this.getCacheKey(endpoint);

    // 1. L1: in-process memory (no I/O)
    const memoryCached = this.cache.get(cacheKey);
    if (memoryCached && Date.now() < memoryCached.expiresAt) {
      console.log(`[FplClient] Cache HIT (Memory) for ${cacheKey}`);
      this.metrics.l1Hits++;
      return { data: memoryCached.data as T, isStale: false };
    }

    // 2. L2: Redis, shared by every instance
    const redisCached = await this.readRedis<T>(cacheKey);
    if (redisCached !== null) {
      console.log(`[FplClient] Cache HIT (Redis) for ${cacheKey}`);
      this.metrics.l2Hits++;
      this.remember(cacheKey, redisCached, ttlSeconds);
      return { data: redisCached, isStale: false };
    }

    // 3. Cache MISS: Fetch from upstream official FPL API via Circuit Breaker
    console.log(`[FplClient] Cache MISS for ${cacheKey}. Fetching upstream from ${this.baseUrl}...`);
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await this.circuitBreaker.execute(async () => {
        return await this.fetchWithRetry(url);
      });

      if (!response.ok) {
        throw new Error(
          `FPL API request failed permanently: [${response.status}] ${response.statusText} at ${url}`
        );
      }

      const data = (await response.json()) as T;
      this.metrics.upstreamFetches++;
      await this.store(endpoint, cacheKey, data, ttlSeconds);
      return { data, isStale: false };
    } catch (err) {
      // 4. Upstream or Circuit Breaker failed: degrade through the stale tiers
      const stale = await this.readStale<T>(endpoint, cacheKey);
      if (stale) {
        console.warn(
          `[FplClient] Upstream unavailable (${(err as Error).message}). Serving STALE ${stale.source} data for ${cacheKey}`
        );
        this.metrics.staleServed[stale.source]++;
        return { data: stale.data, isStale: true, staleSource: stale.source };
      }

      this.metrics.unavailable++;
      throw err;
    }
  }

  /**
   * Clear cache manually (e.g. before an explicit force-sync).
   * Clears the fresh in-memory and Redis tiers. The stale fallback copies are
   * kept on purpose: every queued sync clears the cache first, and wiping the
   * fallback then would leave nothing to serve if FPL is down.
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
   */
  public async getBootstrapStatic(): Promise<{
    events: Array<{
      id: number;
      name: string;
      deadline_time: string;
      is_previous: boolean;
      is_current: boolean;
      is_next: boolean;
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
   */
  public async getFixtures(eventId?: number): Promise<
    Array<{
      id: number;
      event: number | null;
      team_h: number;
      team_a: number;
      team_h_score: number | null;
      team_a_score: number | null;
      kickoff_time: string | null;
      started: boolean;
      finished: boolean;
      finished_provisional?: boolean;
      minutes: number;
      stats?: Array<{
        identifier: string;
        h: Array<{ value: number; element: number }>;
        a: Array<{ value: number; element: number }>;
      }>;
    }>
  > {
    const endpoint = eventId !== undefined ? `/fixtures/?event=${eventId}` : "/fixtures/";
    return this.get(endpoint, FPL_CACHE_TTL.FIXTURES_SECONDS);
  }

  /**
   * Fetches live in-match stats for all players in a specific gameweek.
   */
  public async getGameweekLive(gameweekId: number): Promise<{
    elements: Array<{
      id: number;
      stats: {
        minutes: number;
        goals_scored: number;
        assists: number;
        clean_sheets: number;
        goals_conceded: number;
        own_goals: number;
        penalties_saved?: number;
        penalties_missed?: number;
        yellow_cards: number;
        red_cards: number;
        saves: number;
        bps: number;
        bonus: number;
        total_points: number;
      };
      explain: Array<{
        fixture: number;
        stats: Array<{
          identifier: string;
          points: number;
          value: number;
        }>;
      }>;
    }>;
  }> {
    return this.get(`/event/${gameweekId}/live/`, FPL_CACHE_TTL.GAMEWEEK_LIVE_SECONDS);
  }
}

export const fplClient = new FplClient();
