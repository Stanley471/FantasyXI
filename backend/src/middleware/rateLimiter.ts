import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Request, RequestHandler, Response } from "express";
import { Redis } from "ioredis";
import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import {
  getRateLimitRouteGroup,
  getRateLimitTier,
  RATE_LIMIT_ROUTE_GROUPS,
  RateLimitRouteGroup,
} from "../config/rateLimit.js";

export interface RateLimitBucket {
  key: string;
  limit: number;
}

export interface SlidingWindowResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterMs: number;
}

export interface SlidingWindowStore {
  consume(
    buckets: RateLimitBucket[],
    windowMs: number
  ): Promise<SlidingWindowResult>;
}

const SLIDING_WINDOW_LUA = `
local window = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local nowParts = redis.call("TIME")
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local cutoff = now - window
local blocked = false
local retryAfter = 0
local selectedLimit = nil
local selectedRemaining = nil
local selectedReset = 0

for i = 1, count do
  local key = KEYS[i]
  local limit = tonumber(ARGV[2 + i])
  redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
  local current = redis.call("ZCARD", key)
  local remaining = math.max(0, limit - current)
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local reset = window
  if #oldest > 1 then
    reset = math.max(0, window - (now - tonumber(oldest[2])))
  end

  if current >= limit then
    blocked = true
    retryAfter = math.max(retryAfter, reset)
  end
  if selectedRemaining == nil or remaining < selectedRemaining then
    selectedRemaining = remaining
    selectedLimit = limit
    selectedReset = reset
  end
end

if blocked then
  return {0, selectedRemaining or 0, retryAfter, selectedLimit or 0}
end

local member = ARGV[3 + count]
for i = 1, count do
  redis.call("ZADD", KEYS[i], now, member .. ":" .. i)
  redis.call("PEXPIRE", KEYS[i], window)
end

selectedRemaining = math.huge
selectedReset = window
selectedLimit = 0
for i = 1, count do
  local limit = tonumber(ARGV[2 + i])
  local current = redis.call("ZCARD", KEYS[i])
  local remaining = math.max(0, limit - current)
  local oldest = redis.call("ZRANGE", KEYS[i], 0, 0, "WITHSCORES")
  local reset = window
  if #oldest > 1 then
    reset = math.max(0, window - (now - tonumber(oldest[2])))
  end
  if remaining < selectedRemaining then
    selectedRemaining = remaining
    selectedLimit = limit
    selectedReset = reset
  end
end
return {1, selectedRemaining, selectedReset, selectedLimit}
`;

export class RedisSlidingWindowStore implements SlidingWindowStore {
  constructor(private readonly redis: Redis) {}

  public async consume(
    buckets: RateLimitBucket[],
    windowMs: number
  ): Promise<SlidingWindowResult> {
    const args = [
      String(windowMs),
      String(buckets.length),
      ...buckets.map((bucket) => String(bucket.limit)),
      randomUUID(),
    ];
    const result = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      buckets.length,
      ...buckets.map((bucket) => bucket.key),
      ...args
    )) as [number, number, number, number];

    return {
      allowed: result[0] === 1,
      remaining: Number(result[1]),
      resetAfterMs: Number(result[2]),
      limit: Number(result[3]),
    };
  }
}

interface MemoryBucket {
  timestamps: number[];
  touchedAt: number;
}

export class MemorySlidingWindowStore implements SlidingWindowStore {
  private readonly buckets = new Map<string, MemoryBucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000
  ) {}

  public async consume(
    requestedBuckets: RateLimitBucket[],
    windowMs: number
  ): Promise<SlidingWindowResult> {
    const now = this.now();
    const active = requestedBuckets.map((requested) => {
      let bucket = this.buckets.get(requested.key);
      if (!bucket) {
        bucket = { timestamps: [], touchedAt: now };
        this.buckets.set(requested.key, bucket);
      }
      bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > now - windowMs);
      bucket.touchedAt = now;
      return { ...requested, bucket };
    });

    let blocked = false;
    let retryAfterMs = 0;
    let selectedLimit = 0;
    let selectedRemaining = Number.POSITIVE_INFINITY;
    let selectedReset = windowMs;

    for (const item of active) {
      const remaining = Math.max(0, item.limit - item.bucket.timestamps.length);
      const reset =
        item.bucket.timestamps.length > 0
          ? Math.max(0, windowMs - (now - item.bucket.timestamps[0]))
          : windowMs;
      if (item.bucket.timestamps.length >= item.limit) {
        blocked = true;
        retryAfterMs = Math.max(retryAfterMs, reset);
      }
      if (remaining < selectedRemaining) {
        selectedRemaining = remaining;
        selectedLimit = item.limit;
        selectedReset = reset;
      }
    }

    if (!blocked) {
      for (const item of active) {
        item.bucket.timestamps.push(now);
      }
      selectedRemaining = Number.POSITIVE_INFINITY;
      for (const item of active) {
        const remaining = Math.max(0, item.limit - item.bucket.timestamps.length);
        const reset = Math.max(0, windowMs - (now - item.bucket.timestamps[0]));
        if (remaining < selectedRemaining) {
          selectedRemaining = remaining;
          selectedLimit = item.limit;
          selectedReset = reset;
        }
      }
    } else {
      selectedReset = retryAfterMs;
    }

    this.evictIfNeeded();
    return {
      allowed: !blocked,
      limit: selectedLimit,
      remaining: Number.isFinite(selectedRemaining) ? selectedRemaining : 0,
      resetAfterMs: selectedReset,
    };
  }

  private evictIfNeeded(): void {
    while (this.buckets.size > this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) return;
      this.buckets.delete(oldestKey);
    }
  }
}

let redisClient: Redis | undefined;
let redisFailureLogged = false;
const fallbackStore = new MemorySlidingWindowStore();

function getRedisStore(): SlidingWindowStore | undefined {
  const redisUrl = process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL;
  if (!redisUrl) return undefined;
  if (!redisClient) {
    redisClient = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
    });
    redisClient.on("error", (error) => {
      if (!redisFailureLogged) {
        console.error("[rate-limit] Redis connection error; local fallback will enforce limits", error);
        redisFailureLogged = true;
      }
    });
  }
  return new RedisSlidingWindowStore(redisClient);
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasVerifiedWebhookSecret(req: Request): boolean {
  const configuredSecret = process.env.WEBHOOK_RATE_LIMIT_SECRET;
  const suppliedSecret = req.header("x-webhook-secret");
  if (!configuredSecret || !suppliedSecret) return false;
  const expected = Buffer.from(configuredSecret);
  const actual = Buffer.from(suppliedSecret);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function getBuckets(
  req: Request,
  group: RateLimitRouteGroup
): { buckets: RateLimitBucket[]; windowMs: number } {
  const authenticated = Boolean(req.user?.id);
  const tier = getRateLimitTier(req.path, authenticated, hasVerifiedWebhookSecret(req));
  const tierConfig = group.tiers[tier];
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const identity =
    tier === "webhook"
      ? `webhook:${ip}`
      : authenticated
        ? `user:${req.user!.id}`
        : `ip:${ip}`;
  const buckets = [
    {
      key: `fantasyxi:rate:{${group.name}}:${tier}:${hashKey(identity)}`,
      limit: tierConfig.limit,
    },
  ];

  if (authenticated) {
    buckets.push({
      key: `fantasyxi:rate:{${group.name}}:ip:${hashKey(ip)}`,
      limit: tierConfig.ipLimit ?? tierConfig.limit,
    });
  }

  return { buckets, windowMs: tierConfig.windowMs };
}

function setRateLimitHeaders(res: Response, result: SlidingWindowResult): void {
  res.setHeader("X-RateLimit-Limit", result.limit);
  res.setHeader("X-RateLimit-Remaining", result.remaining);
  res.setHeader(
    "X-RateLimit-Reset",
    Math.ceil((Date.now() + result.resetAfterMs) / 1000)
  );
  if (!result.allowed) {
    res.setHeader("Retry-After", Math.max(1, Math.ceil(result.resetAfterMs / 1000)));
  }
}

export interface SlidingWindowRateLimiterOptions {
  store?: SlidingWindowStore;
  routeGroups?: RateLimitRouteGroup[];
}

export function createSlidingWindowRateLimiter(
  options: SlidingWindowRateLimiterOptions = {}
): RequestHandler {
  const store = options.store ?? fallbackStore;
  const routeGroups = options.routeGroups ?? RATE_LIMIT_ROUTE_GROUPS;

  return async (req, res, next) => {
    if (req.method === "OPTIONS" || req.path === "/api/health" || req.path === "/") {
      next();
      return;
    }

    const group =
      routeGroups.find(
        (candidate) =>
          candidate.prefixes.length > 0 &&
          candidate.prefixes.some(
            (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
          )
      ) ?? routeGroups[routeGroups.length - 1];
    const { buckets, windowMs } = getBuckets(req, group ?? getRateLimitRouteGroup(req.path));

    let result: SlidingWindowResult;
    try {
      result = await (options.store ? store : getRedisStore() ?? store).consume(
        buckets,
        windowMs
      );
      if (redisFailureLogged) {
        console.info("[rate-limit] Redis sliding-window store recovered");
        redisFailureLogged = false;
      }
    } catch (error) {
      if (!redisFailureLogged) {
        console.error("[rate-limit] Redis unavailable; using bounded in-memory limits", error);
        redisFailureLogged = true;
      }
      result = await fallbackStore.consume(buckets, windowMs);
    }

    setRateLimitHeaders(res, result);
    if (!result.allowed) {
      res.status(429).json({
        success: false,
        message: "Too many requests. Please retry after the indicated delay.",
      });
      return;
    }
    next();
  };
}

/**
 * Strict fixed-window limiter retained for password and account-auth endpoints.
 */
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "5", 10),
import { Request, Response } from "express";

function configuredLimit(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRateLimiter(max: number, message: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { success: false, message },
  });
}

/**
 * Standard 429 Error Response Formatter
 */
const createRateLimitHandler = (message: string) => (req: Request, res: Response) => {
  res.status(429).json({
    success: false,
    message,
    retryAfter: res.getHeader("Retry-After") || 60,
  });
};

/**
 * Rate Limiting and Abuse Prevention Middleware for FantasyXI API.
 *
 * 1. Auth Limiter: Protects authentication & registration endpoints from brute force.
 */
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: configuredLimit("AUTH_RATE_LIMIT_MAX", 5), // Max 5 login/register attempts per IP
  standardHeaders: true,
  legacyHeaders: true,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many authentication requests from this IP. Please try again after 15 minutes."),
});

/**
 * 2. Financial / Settlement / Payment Limiter:
 * Protects blockchain settlement and payment routes from transaction flooding and replay abuse.
 */
export const financialRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes window
  max: configuredLimit("FINANCIAL_RATE_LIMIT_MAX", 20), // 20 financial operations per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many financial requests. Please wait before submitting additional transactions."),
});

/** Redis-backed public API sliding-window limiter, with a bounded local fallback. */
export const apiRateLimiter = createSlidingWindowRateLimiter();
/**
 * 3. Sync & Ingestion Limiter:
 * Protects heavy background sync and daemon polling trigger endpoints.
 */
export const syncRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: configuredLimit("SYNC_RATE_LIMIT_MAX", 10), // 10 sync triggers per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many sync requests. Rate limit reached."),
});

/**
 * 4. Squad & Transfer Limiter:
 * Prevents rapid transfer spam and race conditions during deadline periods.
 */
export const squadRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: configuredLimit("SQUAD_RATE_LIMIT_MAX", 30), // 30 squad operations per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many squad modification requests. Please slow down."),
});

/**
 * 5. General API Limiter:
 * General rate limiter for generic public API routes (issue #139).
 * Protects platform resources and external FPL API polling paths from
 * high-frequency automated scraping / abuse: max 100 requests per minute, per IP.
 */
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: configuredLimit("API_RATE_LIMIT_MAX", 100), // Max 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many API requests from this IP. Please try again later."),
});

/** Additional protection for requests that have passed authentication. */
export const authenticatedRateLimiter = createRateLimiter(
  configuredLimit("AUTHENTICATED_RATE_LIMIT_MAX", 60),
  "Too many authenticated API requests from this IP. Please try again later."
);

/** Lower limit for authenticated mutations that are more expensive or stateful. */
export const mutationRateLimiter = createRateLimiter(
  configuredLimit("MUTATION_RATE_LIMIT_MAX", 30),
  "Too many mutation requests from this IP. Please try again later."
);
