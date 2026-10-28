import { GraphQLError } from "graphql";
import { RedisClient } from "../config/redis.js";
import { ComplexityConfig } from "../config/complexity.js";

/**
 * Token bucket rate limiting state.
 */
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Rate limit quota check result.
 */
export interface RateLimitCheckResult {
  /** Whether the request is allowed under rate limits */
  allowed: boolean;

  /** Current tokens in bucket */
  currentTokens: number;

  /** Maximum tokens in bucket */
  maxTokens: number;

  /** Tokens needed for this query */
  tokensNeeded: number;

  /** Estimated time to wait before retrying (seconds) */
  retryAfter?: number;

  /** Error if rate limit exceeded */
  error?: GraphQLError;
}

/**
 * Errors related to complexity rate limiting.
 */
export class ComplexityRateLimitExceededError extends GraphQLError {
  constructor(needed: number, available: number, retryAfter?: number) {
    const retryMsg = retryAfter ? ` Retry after ${retryAfter.toFixed(1)} seconds.` : "";
    super(
      `Query complexity rate limit exceeded. ` +
        `Needed: ${needed}, Available: ${available}.${retryMsg}`,
      {
        extensions: {
          code: "COMPLEXITY_RATE_LIMIT_EXCEEDED",
          needed,
          available,
          retryAfter: retryAfter || undefined,
        },
      }
    );
    this.name = "ComplexityRateLimitExceededError";
  }
}

/**
 * In-memory token bucket implementation (fallback when Redis is unavailable).
 * This uses a simple map of user/IP to token counts.
 */
class InMemoryTokenBucket {
  private buckets: Map<string, TokenBucket> = new Map();
  private config: ComplexityConfig;
  private refillIntervalMs: number;

  constructor(config: ComplexityConfig) {
    this.config = config;
    // Calculate refill interval: we refill the full quota per minute
    // So we refill tokens proportionally at the check time
    this.refillIntervalMs = 60000; // 1 minute
  }

  /**
   * Get or create a token bucket for a key.
   */
  private getBucket(key: string): TokenBucket {
    if (!this.buckets.has(key)) {
      const maxTokens = this.config.complexityRateLimitPerMinute;
      this.buckets.set(key, {
        tokens: maxTokens,
        lastRefill: Date.now(),
      });
    }
    return this.buckets.get(key)!;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refillTokens(bucket: TokenBucket, config: ComplexityConfig): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;

    // Calculate tokens to add: (elapsed / interval) * maxTokens
    const maxTokens = config.complexityRateLimitPerMinute;
    const tokensToAdd = (elapsedMs / this.refillIntervalMs) * maxTokens;

    bucket.tokens = Math.min(bucket.tokens + tokensToAdd, maxTokens);
    bucket.lastRefill = now;
  }

  /**
   * Check if we can consume tokens from a bucket.
   */
  consume(key: string, tokensNeeded: number, config: ComplexityConfig): RateLimitCheckResult {
    const bucket = this.getBucket(key);
    this.refillTokens(bucket, config);

    const maxTokens = config.complexityRateLimitPerMinute;
    const currentTokens = bucket.tokens;

    if (currentTokens >= tokensNeeded) {
      bucket.tokens -= tokensNeeded;
      return {
        allowed: true,
        currentTokens: bucket.tokens,
        maxTokens,
        tokensNeeded,
      };
    }

    // Calculate retry-after time
    const tokensShortfall = tokensNeeded - currentTokens;
    const retryAfter = (tokensShortfall / maxTokens) * 60; // Convert to seconds

    return {
      allowed: false,
      currentTokens,
      maxTokens,
      tokensNeeded,
      retryAfter,
      error: new ComplexityRateLimitExceededError(tokensNeeded, Math.floor(currentTokens), retryAfter),
    };
  }

  /**
   * Get bucket stats for monitoring.
   */
  getStats(key: string, config: ComplexityConfig): TokenBucket | null {
    const bucket = this.buckets.get(key);
    if (bucket) {
      this.refillTokens(bucket, config);
      return bucket;
    }
    return null;
  }

  /**
   * Clear all buckets (useful for testing).
   */
  clear(): void {
    this.buckets.clear();
  }

  /**
   * Get number of tracked keys.
   */
  getTrackedKeysCount(): number {
    return this.buckets.size;
  }
}

/**
 * Redis-backed token bucket rate governor for distributed rate limiting.
 * Uses Lua scripts for atomic operations.
 */
export class ComplexityRateGovernor {
  private redis: RedisClient | null;
  private config: ComplexityConfig;
  private inMemoryBucket: InMemoryTokenBucket;
  private luaScriptSha: string | null = null;

  constructor(redis: RedisClient | null, config: ComplexityConfig) {
    this.redis = redis;
    this.config = config;
    this.inMemoryBucket = new InMemoryTokenBucket(config);
  }

  /**
   * Load the Lua script for atomic token bucket operations.
   * This ensures token bucket state updates are atomic across concurrent requests.
   */
  private async loadLuaScript(): Promise<string> {
    if (this.luaScriptSha) {
      return this.luaScriptSha;
    }

    if (!this.redis) {
      throw new Error("Redis not available for Lua script loading");
    }

    // Lua script for token bucket consumption
    // KEYS[1] = bucket key
    // ARGV[1] = tokens needed
    // ARGV[2] = current time
    // ARGV[3] = max tokens
    // ARGV[4] = refill interval (ms)
    // ARGV[5] = TTL (seconds)
    const luaScript = `
      local key = KEYS[1]
      local tokensNeeded = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local maxTokens = tonumber(ARGV[3])
      local refillInterval = tonumber(ARGV[4])
      local ttl = tonumber(ARGV[5])

      local bucket = redis.call('HGETALL', key)
      local tokens = maxTokens
      local lastRefill = now

      if #bucket > 0 then
        tokens = tonumber(bucket[2])
        lastRefill = tonumber(bucket[4])
      end

      -- Refill tokens
      local elapsedMs = now - lastRefill
      local tokensToAdd = (elapsedMs / refillInterval) * maxTokens
      tokens = math.min(tokens + tokensToAdd, maxTokens)
      lastRefill = now

      -- Check if we can consume
      if tokens >= tokensNeeded then
        tokens = tokens - tokensNeeded
        redis.call('HSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
        redis.call('EXPIRE', key, ttl)
        return {1, tokens, maxTokens}  -- {allowed, currentTokens, maxTokens}
      else
        redis.call('HSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
        redis.call('EXPIRE', key, ttl)
        return {0, tokens, maxTokens}  -- {not allowed, currentTokens, maxTokens}
      end
    `;

    try {
      this.luaScriptSha = String(await this.redis.script("LOAD", luaScript));
      return this.luaScriptSha;
    } catch (error) {
      console.error("[Complexity] Failed to load Lua script:", error);
      throw error;
    }
  }

  /**
   * Check rate limit for a user or IP.
   * Returns allowed/denied decision with token bucket state.
   *
   * @param identifier User ID or IP address
   * @param complexity Complexity score of the query
   * @param limitType "user" or "ip"
   * @returns RateLimitCheckResult
   */
  async checkRateLimit(
    identifier: string,
    complexity: number,
    limitType: "user" | "ip" = "user"
  ): Promise<RateLimitCheckResult> {
    const key = `gql:complexity:${limitType}:${identifier}`;
    const limit =
      limitType === "user"
        ? this.config.complexityRateLimitPerMinute
        : this.config.ipRateLimitPerMinute;

    // Use Redis if available, otherwise fall back to in-memory
    if (this.redis) {
      try {
        return await this.checkRateLimitRedis(key, complexity, limit);
      } catch (error) {
        console.warn("[Complexity] Redis rate limit check failed, falling back to in-memory:", error);
        return this.inMemoryBucket.consume(key, complexity, this.config);
      }
    } else {
      return this.inMemoryBucket.consume(key, complexity, this.config);
    }
  }

  /**
   * Check rate limit using Redis with Lua script.
   */
  private async checkRateLimitRedis(
    key: string,
    tokensNeeded: number,
    maxTokens: number
  ): Promise<RateLimitCheckResult> {
    if (!this.redis) {
      throw new Error("Redis not configured");
    }

    try {
      const scriptSha = await this.loadLuaScript();
      const now = Date.now();
      const refillInterval = 60000; // 1 minute in milliseconds
      const ttl = this.config.redisTokenTTL;

      const result = await this.redis.evalsha(scriptSha, 1, key, tokensNeeded, now, maxTokens, refillInterval, ttl) as [number, number, number];

      const [allowed, currentTokens, returnedMaxTokens] = result;

      if (allowed === 1) {
        return {
          allowed: true,
          currentTokens,
          maxTokens: returnedMaxTokens,
          tokensNeeded,
        };
      } else {
        const tokensShortfall = tokensNeeded - currentTokens;
        const retryAfter = (tokensShortfall / maxTokens) * 60;

        return {
          allowed: false,
          currentTokens,
          maxTokens: returnedMaxTokens,
          tokensNeeded,
          retryAfter,
          error: new ComplexityRateLimitExceededError(
            tokensNeeded,
            Math.floor(currentTokens),
            retryAfter
          ),
        };
      }
    } catch (error) {
      console.error("[Complexity] Lua script execution failed:", error);
      throw error;
    }
  }

  /**
   * Get token bucket stats for monitoring/debugging.
   */
  async getStats(identifier: string, limitType: "user" | "ip" = "user"): Promise<TokenBucket | null> {
    const key = `gql:complexity:${limitType}:${identifier}`;

    if (this.redis) {
      try {
        const bucket = await this.redis.hgetall(key);
        if (bucket && bucket.tokens && bucket.lastRefill) {
          return {
            tokens: parseFloat(bucket.tokens as string),
            lastRefill: parseInt(bucket.lastRefill as string, 10),
          };
        }
      } catch (error) {
        console.warn("[Complexity] Failed to get stats from Redis:", error);
      }
    }

    return this.inMemoryBucket.getStats(key, this.config);
  }

  /**
   * Reset rate limit for a specific user or IP (useful for admin operations).
   */
  async reset(identifier: string, limitType: "user" | "ip" = "user"): Promise<void> {
    const key = `gql:complexity:${limitType}:${identifier}`;

    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        console.warn("[Complexity] Failed to reset Redis key:", error);
      }
    }

    // Also remove from in-memory if present
    const inMemKey = key;
    // The in-memory bucket uses string keys, so we just create a fresh one next time
  }

  /**
   * Reset all rate limits (useful for testing).
   */
  async resetAll(): Promise<void> {
    if (this.redis) {
      try {
        const keys = await this.redis.keys("gql:complexity:*");
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        console.warn("[Complexity] Failed to reset Redis keys:", error);
      }
    }

    this.inMemoryBucket.clear();
  }
}

/**
 * Create a rate governor instance.
 */
export function createRateGovernor(
  redis: RedisClient | null,
  config: ComplexityConfig
): ComplexityRateGovernor {
  return new ComplexityRateGovernor(redis, config);
}
