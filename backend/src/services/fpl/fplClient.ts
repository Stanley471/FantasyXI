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
 * Degradation tiers when the upstream fails or the circuit is open (issue #275):
 *   L1  in-memory last-good copy (per process)
 *   L2  Redis last-good copy (`<key>:stale`, shared, long TTL)
 *   L3  PostgreSQL snapshot (survives restarts and Redis flushes)
 * Responses served from a fallback tier carry `isStale: true` plus the tier and
 * capture time, which `fplDataFreshness` middleware surfaces as X-Data-Stale headers.
 */

import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerStats,
  CircuitState,
  calculateDecorrelatedJitter,
} from "./circuitBreaker.js";
import { FplSnapshotStore, PrismaFplSnapshotStore } from "./fplSnapshotStore.js";

const FPL_BASE_URL = "https://fantasy.premierleague.com/api";

/**
 * Cache TTLs for FPL endpoints (issue #139).
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

interface StaleEntry {
  data: unknown;
  fetchedAt: number;
}

/** Where a response came from: fresh tiers first, then the degraded fallbacks. */
export type FplDataSource =
  | "upstream"
  | "redis"
  | "memory"
  | "stale-memory"
  | "stale-redis"
  | "stale-snapshot";

export interface FplFetchResult<T> {
  data: T;
  isStale: boolean;
  source: FplDataSource;
  /** When the served data was originally fetched from upstream (stale responses only). */
  staleSince: Date | null;
}

export interface FplFreshnessStatus {
  stale: boolean;
  circuitState: CircuitState;
  lastStaleSource: FplDataSource | null;
  lastStaleServedAt: Date | null;
  staleSince: Date | null;
}

export interface FplClientTelemetry {
  circuitBreaker: CircuitBreakerStats;
  freshness: FplFreshnessStatus;
  counters: Record<
    "upstreamFetches" | "redisHits" | "memoryHits" | "staleMemory" | "staleRedis" | "staleSnapshot" | "unservable",
    number
  >;
  snapshotFallbackEnabled: boolean;
}

function envInt(name: string): number | undefined {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Breaker settings for the shared client, overridable per deployment. */
export function getFplCircuitBreakerOptionsFromEnv(): CircuitBreakerOptions {
  return {
    failureThreshold: envInt("FPL_CB_FAILURE_THRESHOLD") || 5,
    cooldownPeriodMs: envInt("FPL_CB_COOLDOWN_MS") || 30_000,
    maxCooldownMs: envInt("FPL_CB_MAX_COOLDOWN_MS") || 5 * 60_000,
    cooldownJitterRatio: 0.2,
  };
}

export interface FplClientOptions {
  baseUrl?: string;
  redis?: IRedisCacheClient | null;
  keyPrefix?: string;
  defaultTtlSeconds?: number;
  circuitBreaker?: CircuitBreaker;
  circuitBreakerOptions?: CircuitBreakerOptions;
  /** L3 fallback store; null disables it. Defaults to Postgres when DATABASE_URL is set. */
  snapshotStore?: FplSnapshotStore | null;
  /** TTL of the Redis last-good copy. Default 7 days. */
  staleTtlSeconds?: number;
  /** Minimum interval between snapshot writes per endpoint. Default 5 minutes. */
  snapshotMinIntervalMs?: number;
  /** Attempts per upstream request inside one breaker call. Default 3. */
  retries?: number;
  /** Base delay for retry backoff. Default 1000ms. */
  retryBackoffMs?: number;
  /** How long after serving stale data the client still reports itself degraded. Default 60s. */
  degradedWindowMs?: number;
}

export class FplClient {
  private cache = new Map<string, CacheEntry<unknown>>();
  private staleCache = new Map<string, StaleEntry>();
  private snapshotWrittenAt = new Map<string, number>();
  private baseUrl: string;
  private redis: IRedisCacheClient | null = null;
  private keyPrefix: string;
  private defaultTtlSeconds: number;
  private snapshotStore: FplSnapshotStore | null;
  private staleTtlSeconds: number;
  private snapshotMinIntervalMs: number;
  private retries: number;
  private retryBackoffMs: number;
  private degradedWindowMs: number;
  private lastStale: { source: FplDataSource; servedAt: number; staleSince: Date | null } | null =
    null;
  private counters: FplClientTelemetry["counters"] = {
    upstreamFetches: 0,
    redisHits: 0,
    memoryHits: 0,
    staleMemory: 0,
    staleRedis: 0,
    staleSnapshot: 0,
    unservable: 0,
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
      this.defaultTtlSeconds =
        baseUrlOrOptions.defaultTtlSeconds || FPL_CACHE_TTL.DEFAULT_SECONDS;
      this.circuitBreaker =
        baseUrlOrOptions.circuitBreaker ||
        new CircuitBreaker(
          baseUrlOrOptions.circuitBreakerOptions ?? getFplCircuitBreakerOptionsFromEnv()
        );
    } else {
      this.baseUrl = baseUrlOrOptions || FPL_BASE_URL;
      this.redis = redisClient !== undefined ? redisClient : getRedisClient();
      this.keyPrefix = "fpl:cache:";
      this.defaultTtlSeconds = FPL_CACHE_TTL.DEFAULT_SECONDS;
      this.circuitBreaker = new CircuitBreaker(getFplCircuitBreakerOptionsFromEnv());
    }

    const options: FplClientOptions =
      typeof baseUrlOrOptions === "object" && baseUrlOrOptions !== null ? baseUrlOrOptions : {};
    this.snapshotStore =
      options.snapshotStore !== undefined
        ? options.snapshotStore
        : process.env.DATABASE_URL && process.env.FPL_SNAPSHOT_FALLBACK_ENABLED !== "false"
          ? new PrismaFplSnapshotStore()
          : null;
    this.staleTtlSeconds = options.staleTtlSeconds ?? 7 * 24 * 60 * 60;
    this.snapshotMinIntervalMs = options.snapshotMinIntervalMs ?? 5 * 60 * 1000;
    this.retries = Math.max(1, options.retries ?? 3);
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;
    this.degradedWindowMs = options.degradedWindowMs ?? 60_000;
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

  private getStaleKey(cacheKey: string): string {
    return `${cacheKey}:stale`;
  }

  private markStale<T>(source: FplDataSource, data: T, staleSince: Date | null): FplFetchResult<T> {
    this.lastStale = { source, servedAt: Date.now(), staleSince };
    return { data, isStale: true, source, staleSince };
  }

  /**
   * Whether clients should currently be told FPL-derived data may be stale:
   * the circuit is not CLOSED, or stale data was served within the degraded window.
   */
  public getFreshnessStatus(): FplFreshnessStatus {
    const circuitState = this.circuitBreaker.getState();
    const recentlyStale =
      this.lastStale !== null && Date.now() - this.lastStale.servedAt < this.degradedWindowMs;
    return {
      stale: circuitState !== CircuitState.CLOSED || recentlyStale,
      circuitState,
      lastStaleSource: this.lastStale?.source ?? null,
      lastStaleServedAt: this.lastStale ? new Date(this.lastStale.servedAt) : null,
      staleSince: this.lastStale?.staleSince ?? null,
    };
  }

  /** Circuit breaker state, cache-tier counters and freshness, for admin telemetry. */
  public getTelemetry(): FplClientTelemetry {
    return {
      circuitBreaker: this.circuitBreaker.getStats(),
      freshness: this.getFreshnessStatus(),
      counters: { ...this.counters },
      snapshotFallbackEnabled: this.snapshotStore !== null,
    };
  }

  /** Walks the L1 -> L2 -> L3 fallback tiers; null when none holds the key. */
  private async readFallback<T>(cacheKey: string): Promise<FplFetchResult<T> | null> {
    const memory = this.staleCache.get(cacheKey);
    if (memory) {
      this.counters.staleMemory++;
      return this.markStale("stale-memory", memory.data as T, new Date(memory.fetchedAt));
    }

    if (this.redis) {
      try {
        const raw = await this.redis.get(this.getStaleKey(cacheKey));
        if (raw) {
          const envelope = JSON.parse(raw) as { data: T; fetchedAt: number };
          this.staleCache.set(cacheKey, { data: envelope.data, fetchedAt: envelope.fetchedAt });
          this.counters.staleRedis++;
          return this.markStale("stale-redis", envelope.data, new Date(envelope.fetchedAt));
        }
      } catch (err) {
        console.warn(`[FplClient] Redis stale GET error for ${cacheKey}:`, (err as Error).message);
      }
    }

    if (this.snapshotStore) {
      try {
        const snapshot = await this.snapshotStore.load<T>(cacheKey);
        if (snapshot) {
          this.staleCache.set(cacheKey, {
            data: snapshot.data,
            fetchedAt: snapshot.capturedAt.getTime(),
          });
          this.counters.staleSnapshot++;
          return this.markStale("stale-snapshot", snapshot.data, snapshot.capturedAt);
        }
      } catch (err) {
        console.warn(`[FplClient] Snapshot load error for ${cacheKey}:`, (err as Error).message);
      }
    }

    return null;
  }

  /** Writes the last-good copy to the L2 and (throttled) L3 tiers without blocking the caller. */
  private persistLastGood(cacheKey: string, data: unknown, fetchedAt: number): void {
    if (this.redis) {
      this.redis
        .set(this.getStaleKey(cacheKey), JSON.stringify({ data, fetchedAt }), "EX", this.staleTtlSeconds)
        .catch((err: Error) =>
          console.warn(`[FplClient] Redis stale SET error for ${cacheKey}:`, err.message)
        );
    }

    if (this.snapshotStore) {
      const lastWrite = this.snapshotWrittenAt.get(cacheKey) ?? 0;
      if (fetchedAt - lastWrite >= this.snapshotMinIntervalMs) {
        this.snapshotWrittenAt.set(cacheKey, fetchedAt);
        this.snapshotStore.save(cacheKey, data).catch((err: Error) => {
          this.snapshotWrittenAt.delete(cacheKey);
          console.warn(`[FplClient] Snapshot save error for ${cacheKey}:`, err.message);
        });
      }
    }
  }

  /**
   * Fetches an upstream URL with retry logic and decorrelated jitter backoff.
   * Throws on 5xx or 429 errors so the circuit breaker can track failures.
   */
  public async fetchWithRetry(
    url: string,
    retries = this.retries,
    backoffMs = this.retryBackoffMs
  ): Promise<Response> {
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

        if (response.ok) {
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
   * Fetch with metadata indicating whether the data returned is fresh or served stale,
   * which tier served it, and (for stale data) when it was originally fetched.
   */
  public async getWithMetadata<T>(
    endpoint: string,
    ttlSeconds: number = this.defaultTtlSeconds
  ): Promise<FplFetchResult<T>> {
    const effectiveTtlSeconds = ttlSeconds;
    const cacheKey = this.getCacheKey(endpoint);

    // 1. Try Redis cache first
    if (this.redis) {
      try {
        const cachedRaw = await this.redis.get(cacheKey);
        if (cachedRaw) {
          console.log(`[FplClient] Cache HIT (Redis) for ${cacheKey}`);
          const parsed = JSON.parse(cachedRaw) as T;
          this.cache.set(cacheKey, {
            data: parsed,
            expiresAt: Date.now() + effectiveTtlSeconds * 1000,
          });
          this.staleCache.set(cacheKey, { data: parsed, fetchedAt: Date.now() });
          this.counters.redisHits++;
          return { data: parsed, isStale: false, source: "redis", staleSince: null };
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
      this.counters.memoryHits++;
      return { data: memoryCached.data as T, isStale: false, source: "memory", staleSince: null };
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
      const fetchedAt = Date.now();
      this.counters.upstreamFetches++;

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

      // 5. Populate in-memory caches and the L2/L3 last-good copies
      this.cache.set(cacheKey, {
        data,
        expiresAt: fetchedAt + effectiveTtlSeconds * 1000,
      });
      this.staleCache.set(cacheKey, { data, fetchedAt });
      this.persistLastGood(cacheKey, data, fetchedAt);

      return { data, isStale: false, source: "upstream", staleSince: null };
    } catch (err) {
      // 6. Upstream or Circuit Breaker failed: degrade through L1 -> L2 -> L3
      const fallback = await this.readFallback<T>(cacheKey);
      if (fallback) {
        console.warn(
          `[FplClient] Upstream unavailable (${(err as Error).message}). Serving STALE data for ${cacheKey} from ${fallback.source}`
        );
        return fallback;
      }

      if (memoryCached) {
        console.warn(
          `[FplClient] Upstream unavailable (${(err as Error).message}). Serving expired in-memory STALE data for ${cacheKey}`
        );
        this.counters.staleMemory++;
        return this.markStale("stale-memory", memoryCached.data as T, null);
      }

      this.counters.unservable++;
      throw err;
    }
  }

  /**
   * Clear cache manually (e.g. before an explicit force-sync).
   * Clears both in-memory cache and Redis keys.
   */
  public async clearCache(endpoint?: string): Promise<void> {
    if (endpoint) {
      const cacheKey = this.getCacheKey(endpoint);
      this.cache.delete(cacheKey);
      this.staleCache.delete(cacheKey);
      if (this.redis) {
        try {
          await this.redis.del(cacheKey, this.getStaleKey(cacheKey));
          console.log(`[FplClient] Cache DEL (Redis) for ${cacheKey}`);
        } catch (err) {
          console.warn(`[FplClient] Redis DEL error for ${cacheKey}:`, (err as Error).message);
        }
      }
    } else {
      this.cache.clear();
      this.staleCache.clear();
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
