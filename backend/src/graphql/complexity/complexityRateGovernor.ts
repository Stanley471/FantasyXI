import { getRedisClient } from "../../config/redis.js";

/**
 * Complexity-weighted token-bucket rate governor (issue #265).
 *
 * Every client (authenticated user, else IP) owns a bucket of `capacity`
 * complexity tokens that refills continuously at `refillPerSecond`. Each
 * operation spends tokens equal to its computed complexity, so a client can
 * send many cheap queries or a few expensive ones, but cannot sustain a
 * stream of expensive ones.
 *
 * Buckets live in Redis so the budget is shared across API instances; the
 * refill-and-take step runs as one Lua script, making it atomic under
 * concurrency. If Redis is unavailable the governor falls back to an
 * in-process bucket: limits stay enforced per instance rather than failing
 * open entirely.
 */

export interface TokenBucketDecision {
  allowed: boolean;
  /** Tokens left after this request (unchanged when rejected). */
  remaining: number;
  /** How long until enough tokens exist for this cost; 0 when allowed. */
  retryAfterMs: number;
}

export interface TokenBucketStore {
  take(
    key: string,
    cost: number,
    capacity: number,
    refillPerSecond: number,
    nowMs: number
  ): Promise<{ allowed: boolean; tokens: number }>;
}

/** In-process token buckets, lazily refilled on access. */
export class MemoryTokenBucketStore implements TokenBucketStore {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(private readonly maxKeys = 50_000) {}

  public async take(
    key: string,
    cost: number,
    capacity: number,
    refillPerSecond: number,
    nowMs: number
  ): Promise<{ allowed: boolean; tokens: number }> {
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: nowMs };
    const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAt) / 1000;
    let tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    const allowed = tokens >= cost;
    if (allowed) tokens -= cost;

    // Refresh insertion order so the oldest-touched key is evicted first
    this.buckets.delete(key);
    this.buckets.set(key, { tokens, updatedAt: nowMs });
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return { allowed, tokens };
  }

  public clear(): void {
    this.buckets.clear();
  }
}

/** Minimal slice of ioredis used by the Redis-backed store. */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const TAKE_SCRIPT = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, ttl)
return { allowed, tostring(tokens) }
`;

/** Redis token buckets shared by every API instance, with an in-memory fallback. */
export class RedisTokenBucketStore implements TokenBucketStore {
  private readonly fallback = new MemoryTokenBucketStore();
  private warned = false;

  constructor(
    private readonly redis: RedisEvalClient,
    private readonly keyPrefix = "graphql:complexity:"
  ) {}

  public async take(
    key: string,
    cost: number,
    capacity: number,
    refillPerSecond: number,
    nowMs: number
  ): Promise<{ allowed: boolean; tokens: number }> {
    // An idle bucket is full again after capacity / refill seconds; expire it then
    const ttlMs = Math.max(1000, Math.ceil((capacity / Math.max(refillPerSecond, 1e-9)) * 1000));
    try {
      const result = (await this.redis.eval(
        TAKE_SCRIPT,
        1,
        `${this.keyPrefix}${key}`,
        cost,
        capacity,
        refillPerSecond,
        nowMs,
        ttlMs
      )) as [number, string];
      return { allowed: Number(result[0]) === 1, tokens: Number(result[1]) };
    } catch (err) {
      if (!this.warned) {
        console.warn(
          `[graphql] Redis complexity bucket unavailable (${(err as Error).message}); using in-process buckets`
        );
        this.warned = true;
      }
      return this.fallback.take(key, cost, capacity, refillPerSecond, nowMs);
    }
  }
}

export interface ComplexityRateGovernorOptions {
  /** Maximum burst of complexity tokens per client. */
  capacity?: number;
  /** Tokens restored per second. */
  refillPerSecond?: number;
  store?: TokenBucketStore;
  now?: () => number;
}

function envNumber(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class ComplexityRateGovernor {
  public readonly capacity: number;
  public readonly refillPerSecond: number;
  private readonly store: TokenBucketStore;
  private readonly now: () => number;

  constructor(options: ComplexityRateGovernorOptions = {}) {
    this.capacity = options.capacity ?? envNumber("GRAPHQL_COMPLEXITY_BUDGET", 10_000);
    this.refillPerSecond =
      options.refillPerSecond ?? envNumber("GRAPHQL_COMPLEXITY_REFILL_PER_SECOND", 100);
    this.store = options.store ?? new MemoryTokenBucketStore();
    this.now = options.now ?? Date.now;
  }

  /** Spends `cost` tokens from `clientKey`'s bucket if it has enough. */
  public async consume(clientKey: string, cost: number): Promise<TokenBucketDecision> {
    const spend = Math.max(0, cost);
    if (spend > this.capacity) {
      // Can never be satisfied, however long the client waits
      return { allowed: false, remaining: 0, retryAfterMs: Number.POSITIVE_INFINITY };
    }
    const { allowed, tokens } = await this.store.take(
      clientKey,
      spend,
      this.capacity,
      this.refillPerSecond,
      this.now()
    );
    const retryAfterMs = allowed
      ? 0
      : Math.ceil(((spend - tokens) / this.refillPerSecond) * 1000);
    return { allowed, remaining: Math.max(0, Math.floor(tokens)), retryAfterMs };
  }
}

/** Builds the process-wide governor: Redis-backed when Redis is configured. */
export function createDefaultComplexityRateGovernor(): ComplexityRateGovernor {
  const redis = getRedisClient();
  return new ComplexityRateGovernor({
    store: redis ? new RedisTokenBucketStore(redis as unknown as RedisEvalClient) : undefined,
  });
}
