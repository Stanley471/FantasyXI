import { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyAccessToken } from "../config/jwt.js";
import { getRedisClient } from "../config/redis.js";
import {
  SERVICE_KEY_HEADER,
  authenticateServiceKey,
} from "../config/serviceAuth.js";
import {
  CallerTier,
  FallbackBehavior,
  RateLimitGatewayConfig,
  RouteGroupName,
  RouteGroupRateLimitConfig,
  loadRateLimitGatewayConfig,
  resolveRouteGroup,
} from "../config/rateLimitConfig.js";
import { Role } from "../config/permissions.js";

/**
 * Atomic Redis Lua script implementing the Sliding-Window Log algorithm.
 *
 * KEYS[1] = sorted-set key for (routeGroup, tier, callerId)
 * ARGV[1] = current timestamp in milliseconds (nowMs)
 * ARGV[2] = sliding window size in milliseconds (windowMs)
 * ARGV[3] = maximum requests permitted in window (limit)
 * ARGV[4] = unique request entry ID
 *
 * Returns a 5-element tuple:
 *   [1] allowed (1 = allowed, 0 = rejected)
 *   [2] active request count within window
 *   [3] remaining request quota
 *   [4] retryAfterMs (0 when allowed, >0 when rejected)
 *   [5] resetAtMs (epoch ms when the oldest request expires from window)
 */
export const SLIDING_WINDOW_LUA_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local windowStart = now - window

redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  local newCount = count + 1
  local remaining = limit - newCount
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestScore = now
  if oldest and #oldest >= 2 then
    oldestScore = tonumber(oldest[2]) or now
  end
  local resetMs = oldestScore + window
  return { 1, newCount, remaining, 0, resetMs }
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestScore = now
  if oldest and #oldest >= 2 then
    oldestScore = tonumber(oldest[2]) or now
  end
  local retryAfterMs = math.max(1, (oldestScore + window) - now)
  local resetMs = oldestScore + window
  redis.call('PEXPIRE', key, window)
  return { 0, count, 0, retryAfterMs, resetMs }
end
`.trim();

export interface ISlidingWindowRedisClient {
  eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  status?: string;
}

export interface SlidingWindowEvaluation {
  allowed: boolean;
  limit: number;
  currentCount: number;
  remaining: number;
  retryAfterSeconds: number;
  retryAfterMs: number;
  resetAtEpochSeconds: number;
  tier: CallerTier;
  routeGroup: RouteGroupName;
  callerKey: string;
  usedFallback: boolean;
  fallbackMode?: FallbackBehavior;
}

export interface CallerIdentity {
  tier: CallerTier;
  callerId: string;
}

/**
 * Extracts client IP respecting `X-Forwarded-For` and Express `req.ip`.
 */
export function extractClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "127.0.0.1";
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 64) || "unknown";
}

/**
 * Determines the caller tier (anonymous, authenticated, webhook) and unique caller ID
 * without mutating authentication logic.
 */
export function resolveCallerIdentity(
  req: Request,
  routeGroup: RouteGroupName
): CallerIdentity {
  const clientIp = sanitizeIdentifier(extractClientIp(req));

  // 1. Check webhook caller indicators (header signatures, service keys, or webhook route)
  const webhookIdHeader =
    req.headers["x-webhook-id"] ||
    req.headers["x-fantasyxi-webhook-id"] ||
    req.headers["x-webhook-caller"];
  const webhookSignatureHeader =
    req.headers["x-webhook-signature"] ||
    req.headers["x-fantasyxi-signature"] ||
    req.headers["x-hub-signature-256"];

  if (req.user?.role === Role.SERVICE) {
    return {
      tier: "webhook",
      callerId: `svc:${sanitizeIdentifier(req.user.id)}`,
    };
  }

  const rawServiceHeader = req.headers[SERVICE_KEY_HEADER];
  if (typeof rawServiceHeader === "string" && rawServiceHeader.trim().length > 0) {
    const servicePrincipal = authenticateServiceKey(rawServiceHeader);
    if (servicePrincipal) {
      return {
        tier: "webhook",
        callerId: `svc:${sanitizeIdentifier(servicePrincipal.name)}`,
      };
    }
  }

  if (
    typeof webhookIdHeader === "string" &&
    webhookIdHeader.trim().length > 0 &&
    (routeGroup === "webhooks" || Boolean(webhookSignatureHeader))
  ) {
    return {
      tier: "webhook",
      callerId: `wh:${sanitizeIdentifier(webhookIdHeader.trim())}`,
    };
  }

  if (
    typeof webhookSignatureHeader === "string" &&
    webhookSignatureHeader.trim().length > 0
  ) {
    return {
      tier: "webhook",
      callerId: `wh-ip:${clientIp}`,
    };
  }

  // 2. Check authenticated player (either pre-populated req.user or valid Bearer JWT)
  if (req.user?.id) {
    return {
      tier: "authenticated",
      callerId: `usr:${sanitizeIdentifier(req.user.id)}`,
    };
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.trim().length > 0) {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      try {
        const payload = verifyAccessToken(parts[1]);
        if (payload && typeof payload.userId === "string" && payload.userId.length > 0) {
          return {
            tier: "authenticated",
            callerId: `usr:${sanitizeIdentifier(payload.userId)}`,
          };
        }
      } catch {
        // Invalid or expired JWT falls back to anonymous IP-based limiting
      }
    }
  }

  // 3. Default to anonymous visitor keyed by IP
  return {
    tier: "anonymous",
    callerId: `ip:${clientIp}`,
  };
}

/**
 * In-memory sliding-window log store used when Redis is unreachable or disabled
 * in conservative fallback mode.
 */
export class InMemorySlidingWindowStore {
  private readonly windows = new Map<string, number[]>();

  public evaluate(
    key: string,
    nowMs: number,
    windowMs: number,
    limit: number
  ): {
    allowed: boolean;
    currentCount: number;
    remaining: number;
    retryAfterMs: number;
    resetAtMs: number;
  } {
    const windowStart = nowMs - windowMs;
    const existing = this.windows.get(key) || [];
    const active = existing.filter((ts) => ts > windowStart);

    if (active.length < limit) {
      active.push(nowMs);
      this.windows.set(key, active);
      const oldestScore = active[0] ?? nowMs;
      return {
        allowed: true,
        currentCount: active.length,
        remaining: Math.max(0, limit - active.length),
        retryAfterMs: 0,
        resetAtMs: oldestScore + windowMs,
      };
    }

    this.windows.set(key, active);
    const oldestScore = active[0] ?? nowMs;
    const retryAfterMs = Math.max(1, oldestScore + windowMs - nowMs);
    return {
      allowed: false,
      currentCount: active.length,
      remaining: 0,
      retryAfterMs,
      resetAtMs: oldestScore + windowMs,
    };
  }

  public clear(): void {
    this.windows.clear();
  }
}

export interface SlidingWindowGatewayOptions {
  config?: Partial<RateLimitGatewayConfig>;
  redisClient?: ISlidingWindowRedisClient | null | (() => ISlidingWindowRedisClient | null);
  clock?: () => number;
  fallbackStore?: InMemorySlidingWindowStore;
  routeGroupOverride?: RouteGroupName;
}

/**
 * Core Sliding-Window Rate Limiter Engine executing Redis Lua scripts with
 * resilient fallback when Redis is unavailable.
 */
export class SlidingWindowRateLimiter {
  private readonly config: RateLimitGatewayConfig;
  private readonly getRedis: () => ISlidingWindowRedisClient | null;
  private readonly clock: () => number;
  private readonly fallbackStore: InMemorySlidingWindowStore;
  private sequenceCounter = 0;

  constructor(options: SlidingWindowGatewayOptions = {}) {
    this.config = loadRateLimitGatewayConfig(options.config);
    this.clock = options.clock || (() => Date.now());
    this.fallbackStore = options.fallbackStore || new InMemorySlidingWindowStore();

    if (typeof options.redisClient === "function") {
      this.getRedis = options.redisClient;
    } else if (options.redisClient !== undefined) {
      const provided = options.redisClient;
      this.getRedis = () => provided;
    } else {
      this.getRedis = () => getRedisClient() as unknown as ISlidingWindowRedisClient | null;
    }
  }

  public getConfig(): RateLimitGatewayConfig {
    return this.config;
  }

  public getGroupConfig(group: RouteGroupName): RouteGroupRateLimitConfig {
    return this.config.routeGroups[group] || this.config.routeGroups.default;
  }

  public async evaluateRequest(
    req: Request,
    routeGroupOverride?: RouteGroupName
  ): Promise<SlidingWindowEvaluation> {
    const fullPath = `${req.baseUrl || ""}${req.path || req.url || ""}`;
    const routeGroup = routeGroupOverride || resolveRouteGroup(fullPath);
    const groupConfig = this.getGroupConfig(routeGroup);
    const identity = resolveCallerIdentity(req, routeGroup);
    const baseLimit = groupConfig.limits[identity.tier];
    const windowMs = groupConfig.windowMs;
    const nowMs = this.clock();

    const redisKey = `${this.config.keyPrefix}:${routeGroup}:${identity.tier}:${identity.callerId}`;
    this.sequenceCounter = (this.sequenceCounter + 1) % 1_000_000_000;
    const memberId = `${nowMs}:${this.sequenceCounter}`;

    const redis = this.getRedis();
    if (redis) {
      try {
        const rawResult = await redis.eval(
          SLIDING_WINDOW_LUA_SCRIPT,
          1,
          redisKey,
          nowMs,
          windowMs,
          baseLimit,
          memberId
        );

        if (Array.isArray(rawResult) && rawResult.length >= 5) {
          const allowed = Number(rawResult[0]) === 1;
          const currentCount = Number(rawResult[1]);
          const remaining = Math.max(0, Number(rawResult[2]));
          const retryAfterMs = Math.max(0, Number(rawResult[3]));
          const resetAtMs = Number(rawResult[4]) || nowMs + windowMs;
          const retryAfterSeconds = allowed
            ? 0
            : Math.max(1, Math.ceil(retryAfterMs / 1000));

          return {
            allowed,
            limit: baseLimit,
            currentCount,
            remaining,
            retryAfterSeconds,
            retryAfterMs,
            resetAtEpochSeconds: Math.ceil(resetAtMs / 1000),
            tier: identity.tier,
            routeGroup,
            callerKey: redisKey,
            usedFallback: false,
          };
        }
      } catch {
        // Redis unreachable or timed out -> proceed to configured fallback
      }
    }

    // Fallback path when Redis is unreachable or disabled
    if (this.config.fallbackBehavior === "fail-open") {
      return {
        allowed: true,
        limit: baseLimit,
        currentCount: 0,
        remaining: baseLimit,
        retryAfterSeconds: 0,
        retryAfterMs: 0,
        resetAtEpochSeconds: Math.ceil((nowMs + windowMs) / 1000),
        tier: identity.tier,
        routeGroup,
        callerKey: redisKey,
        usedFallback: true,
        fallbackMode: "fail-open",
      };
    }

    // Conservative fallback mode: apply conservative ratio in local sliding window
    const conservativeLimit = Math.max(
      1,
      Math.floor(baseLimit * this.config.conservativeFallbackRatio)
    );
    const localEval = this.fallbackStore.evaluate(
      redisKey,
      nowMs,
      windowMs,
      conservativeLimit
    );
    const retryAfterSeconds = localEval.allowed
      ? 0
      : Math.max(1, Math.ceil(localEval.retryAfterMs / 1000));

    return {
      allowed: localEval.allowed,
      limit: conservativeLimit,
      currentCount: localEval.currentCount,
      remaining: localEval.remaining,
      retryAfterSeconds,
      retryAfterMs: localEval.retryAfterMs,
      resetAtEpochSeconds: Math.ceil(localEval.resetAtMs / 1000),
      tier: identity.tier,
      routeGroup,
      callerKey: redisKey,
      usedFallback: true,
      fallbackMode: "conservative",
    };
  }
}

/**
 * Creates an Express middleware enforcing Redis Lua sliding-window rate limits
 * with tiered thresholds and standard HTTP rate-limit headers.
 */
export function createSlidingWindowRateLimiter(
  options: SlidingWindowGatewayOptions = {}
): RequestHandler {
  const engine = new SlidingWindowRateLimiter(options);

  return async function slidingWindowRateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (!engine.getConfig().enabled) {
      next();
      return;
    }

    const evaluation = await engine.evaluateRequest(req, options.routeGroupOverride);
    const groupConfig = engine.getGroupConfig(evaluation.routeGroup);
    const windowSeconds = Math.max(1, Math.ceil(groupConfig.windowMs / 1000));

    // Attach standard rate-limit headers
    res.setHeader("X-RateLimit-Limit", String(evaluation.limit));
    res.setHeader("X-RateLimit-Remaining", String(evaluation.remaining));
    res.setHeader("X-RateLimit-Reset", String(evaluation.resetAtEpochSeconds));
    res.setHeader("X-RateLimit-Tier", evaluation.tier);
    res.setHeader(
      "X-RateLimit-Policy",
      `${evaluation.limit};w=${windowSeconds};tier=${evaluation.tier};group=${evaluation.routeGroup}`
    );

    if (evaluation.usedFallback && evaluation.fallbackMode) {
      res.setHeader("X-RateLimit-Fallback", evaluation.fallbackMode);
    }

    if (!evaluation.allowed) {
      res.setHeader("Retry-After", String(evaluation.retryAfterSeconds));
      res.status(429).json({
        success: false,
        message:
          groupConfig.message ||
          "Too many API requests from this client. Please try again later.",
        tier: evaluation.tier,
        routeGroup: evaluation.routeGroup,
        limit: evaluation.limit,
        remaining: 0,
        retryAfter: evaluation.retryAfterSeconds,
      });
      return;
    }

    next();
  };
}
