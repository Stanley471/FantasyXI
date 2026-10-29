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
        message: "Too many API requests. Please retry after the indicated delay.",
      });
      return;
    }
    next();
  };
}

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

/** Standard 429 response body used by the fixed-window limiters. */
const createRateLimitHandler = (message: string) => (_req: Request, res: Response) => {
  res.status(429).json({
    success: false,
    message,
    retryAfter: res.getHeader("Retry-After") || 60,
  });
};

/** Protects authentication and registration endpoints from brute force. */
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: configuredLimit("AUTH_RATE_LIMIT_MAX", 5),
  standardHeaders: true,
  legacyHeaders: true,
  validate: { trustProxy: false },
  handler: createRateLimitHandler(
    "Too many authentication requests from this IP. Please try again after 15 minutes."
  ),
});

/** Protects settlement and payment routes from transaction flooding and replay abuse. */
export const financialRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: configuredLimit("FINANCIAL_RATE_LIMIT_MAX", 20),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler(
    "Too many financial requests. Please wait before submitting additional transactions."
  ),
});

/** Redis-backed public API sliding-window limiter, with a bounded local fallback. */
export const apiRateLimiter = createSlidingWindowRateLimiter();

/** Protects heavy background sync and daemon polling trigger endpoints. */
export const syncRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: configuredLimit("SYNC_RATE_LIMIT_MAX", 10),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many sync requests. Rate limit reached."),
});

/** Prevents rapid transfer spam and race conditions during deadline periods. */
export const squadRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: configuredLimit("SQUAD_RATE_LIMIT_MAX", 30),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many squad modification requests. Please slow down."),
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

// ============================================================
// Wallet-keyed deposit verification limiter (issue #233)
// ============================================================

/**
 * Outcome a deposit controller reports through `res.locals.depositVerificationOutcome`.
 * "not_found" means Horizon has no transaction for the submitted hash.
 */
export type DepositVerificationOutcome = "found" | "not_found";

/**
 * Tracks consecutive non-existent transaction hashes per wallet and locks out
 * wallets that look like they are scanning hashes.
 */
export interface WalletScanGuardStore {
  /** Milliseconds left on an active lockout, or 0 when the wallet is not locked. */
  lockRemainingMs(wallet: string): Promise<number>;
  /** Records a miss. Returns the lockout length in ms when this miss triggers a lockout, else 0. */
  recordMiss(wallet: string, threshold: number, lockoutMs: number, missWindowMs: number): Promise<number>;
  /** Clears the consecutive-miss counter after a transaction is found. */
  reset(wallet: string): Promise<void>;
}

export class MemoryWalletScanGuardStore implements WalletScanGuardStore {
  private readonly misses = new Map<string, { count: number; expiresAt: number }>();
  private readonly locks = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000
  ) {}

  public async lockRemainingMs(wallet: string): Promise<number> {
    const until = this.locks.get(wallet);
    if (until === undefined) return 0;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.locks.delete(wallet);
      return 0;
    }
    return remaining;
  }

  public async recordMiss(
    wallet: string,
    threshold: number,
    lockoutMs: number,
    missWindowMs: number
  ): Promise<number> {
    const now = this.now();
    const current = this.misses.get(wallet);
    const count = current && current.expiresAt > now ? current.count + 1 : 1;
    if (count >= threshold) {
      this.misses.delete(wallet);
      this.locks.set(wallet, now + lockoutMs);
      this.evict();
      return lockoutMs;
    }
    this.misses.set(wallet, { count, expiresAt: now + missWindowMs });
    this.evict();
    return 0;
  }

  public async reset(wallet: string): Promise<void> {
    this.misses.delete(wallet);
  }

  private evict(): void {
    for (const map of [this.misses, this.locks] as Map<string, unknown>[]) {
      while (map.size > this.maxKeys) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
  }
}

const SCAN_GUARD_MISS_LUA = `
local count = redis.call("INCR", KEYS[1])
redis.call("PEXPIRE", KEYS[1], ARGV[3])
if count >= tonumber(ARGV[1]) then
  redis.call("DEL", KEYS[1])
  redis.call("SET", KEYS[2], "1", "PX", ARGV[2])
  return tonumber(ARGV[2])
end
return 0
`;

export class RedisWalletScanGuardStore implements WalletScanGuardStore {
  constructor(private readonly redis: Redis) {}

  private keys(wallet: string): [string, string] {
    const id = hashKey(wallet);
    return [`fantasyxi:scan:{${id}}:misses`, `fantasyxi:scan:{${id}}:lock`];
  }

  public async lockRemainingMs(wallet: string): Promise<number> {
    const ttl = await this.redis.pttl(this.keys(wallet)[1]);
    return ttl > 0 ? ttl : 0;
  }

  public async recordMiss(
    wallet: string,
    threshold: number,
    lockoutMs: number,
    missWindowMs: number
  ): Promise<number> {
    const [missKey, lockKey] = this.keys(wallet);
    const result = await this.redis.eval(
      SCAN_GUARD_MISS_LUA,
      2,
      missKey,
      lockKey,
      String(threshold),
      String(lockoutMs),
      String(missWindowMs)
    );
    return Number(result);
  }

  public async reset(wallet: string): Promise<void> {
    await this.redis.del(this.keys(wallet)[0]);
  }
}

export interface WalletRateLimiterOptions {
  /** Sliding-window store; defaults to Redis when configured, else in-memory. */
  store?: SlidingWindowStore;
  /** Anti-scanning store; defaults to Redis when configured, else in-memory. */
  scanGuard?: WalletScanGuardStore;
  /** Finds the wallet for a request when the body does not carry `stellarAddress`. */
  resolveWallet?: (req: Request) => Promise<string | undefined> | string | undefined;
  /** Max verification attempts per wallet per window. Default 5. */
  walletLimit?: number;
  /** Max attempts per authenticated user per window. Default 10. */
  userLimit?: number;
  /** Max attempts per IP per window. Default 30. */
  ipLimit?: number;
  /** Window length in ms. Default 60s. */
  windowMs?: number;
  /** Consecutive non-existent hashes that trigger a lockout. Default 3. */
  scanThreshold?: number;
  /** Lockout length in ms. Default 15 minutes. */
  lockoutMs?: number;
  /** How long a miss counts toward the streak. Default 15 minutes. */
  missWindowMs?: number;
}

const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;
const fallbackScanGuard = new MemoryWalletScanGuardStore();
let redisScanGuard: RedisWalletScanGuardStore | undefined;

function getRedisScanGuard(): WalletScanGuardStore | undefined {
  if (!getRedisStore() || !redisClient) return undefined;
  redisScanGuard ??= new RedisWalletScanGuardStore(redisClient);
  return redisScanGuard;
}

async function defaultResolveWallet(req: Request): Promise<string | undefined> {
  if (!req.user?.id) return undefined;
  const { prisma } = await import("../config/db.js");
  const wallet = await prisma.wallet.findUnique({
    where: { userId: req.user.id },
    select: { stellarAddress: true },
  });
  return wallet?.stellarAddress ?? undefined;
}

function sendTooManyRequests(res: Response, retryAfterMs: number, message: string): void {
  res.setHeader("Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({
    success: false,
    message,
    retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });
}

/**
 * Rate limits deposit submit/verify endpoints by wallet address, user ID and IP
 * together, so cycling IPs does not reset the per-wallet quota. Also locks out
 * wallets that submit several non-existent transaction hashes in a row.
 *
 * Controllers report Horizon lookups by setting
 * `res.locals.depositVerificationOutcome` to "found" or "not_found".
 */
export function createWalletRateLimiter(options: WalletRateLimiterOptions = {}): RequestHandler {
  const walletLimit = options.walletLimit ?? configuredLimit("WALLET_VERIFY_RATE_LIMIT_MAX", 5);
  const userLimit = options.userLimit ?? configuredLimit("USER_VERIFY_RATE_LIMIT_MAX", 10);
  const ipLimit = options.ipLimit ?? configuredLimit("IP_VERIFY_RATE_LIMIT_MAX", 30);
  const windowMs = options.windowMs ?? 60_000;
  const scanThreshold = options.scanThreshold ?? 3;
  const lockoutMs = options.lockoutMs ?? 15 * 60_000;
  const missWindowMs = options.missWindowMs ?? 15 * 60_000;
  const resolveWallet = options.resolveWallet ?? defaultResolveWallet;

  const pickStore = () => options.store ?? getRedisStore() ?? fallbackStore;
  const pickGuard = () => options.scanGuard ?? getRedisScanGuard() ?? fallbackScanGuard;

  return async (req, res, next) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const bodyWallet =
        typeof req.body?.stellarAddress === "string" ? req.body.stellarAddress.trim() : "";
      const wallet = STELLAR_ADDRESS_PATTERN.test(bodyWallet)
        ? bodyWallet
        : await resolveWallet(req);

      let guard = pickGuard();
      if (wallet) {
        let lockedMs: number;
        try {
          lockedMs = await guard.lockRemainingMs(wallet);
        } catch {
          guard = fallbackScanGuard;
          lockedMs = await guard.lockRemainingMs(wallet);
        }
        if (lockedMs > 0) {
          sendTooManyRequests(
            res,
            lockedMs,
            "This wallet is temporarily locked after repeated lookups of non-existent transactions."
          );
          return;
        }
      }

      const buckets: RateLimitBucket[] = [
        { key: `fantasyxi:rate:{deposit-verify}:ip:${hashKey(ip)}`, limit: ipLimit },
      ];
      if (wallet) {
        buckets.push({
          key: `fantasyxi:rate:{deposit-verify}:wallet:${hashKey(wallet)}`,
          limit: walletLimit,
        });
      }
      if (req.user?.id) {
        buckets.push({
          key: `fantasyxi:rate:{deposit-verify}:user:${hashKey(req.user.id)}`,
          limit: userLimit,
        });
      }

      let result: SlidingWindowResult;
      try {
        result = await pickStore().consume(buckets, windowMs);
      } catch {
        result = await fallbackStore.consume(buckets, windowMs);
      }

      setRateLimitHeaders(res, result);
      if (!result.allowed) {
        sendTooManyRequests(
          res,
          result.resetAfterMs,
          "Too many deposit verification attempts for this wallet. Please retry after the indicated delay."
        );
        return;
      }

      if (wallet) {
        res.on("finish", () => {
          const outcome = res.locals.depositVerificationOutcome as
            | DepositVerificationOutcome
            | undefined;
          if (!outcome) return;
          const update =
            outcome === "not_found"
              ? guard.recordMiss(wallet, scanThreshold, lockoutMs, missWindowMs)
              : guard.reset(wallet);
          update.catch((error) =>
            console.error("[rate-limit] Failed to update wallet scan guard", error)
          );
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Per-wallet limiter for POST /financial/submit and /financial/verify. */
export const walletVerificationRateLimiter = createWalletRateLimiter();
