import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
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
  legacyHeaders: false,
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

// ============================================================================
// Wallet-Aware & Compound-Key Deposit Verification Rate Limiter (Issue #233)
// ============================================================================

import type { NextFunction } from "express";
import type { IRedisCacheClient } from "../config/redis.js";

export interface WalletDepositRateLimiterOptions {
  /** Rate limit window in ms (default: 60,000ms = 1 minute) */
  windowMs?: number;
  /** Max deposit verification attempts per wallet address per window (default: 5) */
  maxWalletRequestsPerWindow?: number;
  /** Max deposit verification attempts per compound key (ip + wallet + userId) per window (default: 5) */
  maxCompoundRequestsPerWindow?: number;
  /** Consecutive non-existent txHash threshold before temporary lockout (default: 3) */
  maxConsecutiveNonExistentTx?: number;
  /** Lockout duration in ms when threshold is reached (default: 15 minutes) */
  lockoutDurationMs?: number;
  /** Optional Redis cache client for distributed state */
  redisClient?: IRedisCacheClient | null;
  /** Optional clock provider for deterministic tests */
  nowFn?: () => number;
}

interface WalletRateLimitEntry {
  count: number;
  resetAt: number;
}

interface LockoutState {
  consecutiveNotFound: number;
  lockedUntil: number;
}

/**
 * Extracts client IP address safely when behind proxies (X-Forwarded-For / req.ip).
 */
export function extractClientIp(req: Request): string {
  const forwardedFor = req.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Extracts Stellar wallet address from request body, query, or header.
 */
export function extractWalletAddress(req: Request): string | null {
  const candidates = [
    req.body?.stellarAddress,
    req.body?.walletAddress,
    req.headers?.["x-stellar-address"],
    req.query?.stellarAddress,
    req.query?.walletAddress,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Builds a compound rate-limiting key combining IP, wallet address, and authenticated userId.
 */
export function buildCompoundDepositKey(params: {
  ip: string;
  walletAddress?: string | null;
  userId?: string | null;
}): string {
  const ipPart = params.ip || "unknown-ip";
  const walletPart = params.walletAddress || "no-wallet";
  const userPart = params.userId || "anon-user";
  return `deposit:compound:${ipPart}:${walletPart}:${userPart}`;
}

export class WalletDepositRateLimiter {
  private readonly windowMs: number;
  private readonly maxWalletRequests: number;
  private readonly maxCompoundRequests: number;
  private readonly maxConsecutiveNonExistentTx: number;
  private readonly lockoutDurationMs: number;
  private readonly redisClient: IRedisCacheClient | null;
  private readonly nowFn: () => number;

  private readonly walletCounters = new Map<string, WalletRateLimitEntry>();
  private readonly compoundCounters = new Map<string, WalletRateLimitEntry>();
  private readonly lockoutStore = new Map<string, LockoutState>();

  constructor(options: WalletDepositRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60 * 1000; // 1 minute
    this.maxWalletRequests = options.maxWalletRequestsPerWindow ?? 5;
    this.maxCompoundRequests = options.maxCompoundRequestsPerWindow ?? 5;
    this.maxConsecutiveNonExistentTx = options.maxConsecutiveNonExistentTx ?? 3;
    this.lockoutDurationMs = options.lockoutDurationMs ?? 15 * 60 * 1000; // 15 minutes
    this.redisClient = options.redisClient ?? null;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public reset(): void {
    this.walletCounters.clear();
    this.compoundCounters.clear();
    this.lockoutStore.clear();
  }

  private getActorLockoutKeys(walletAddress?: string | null, userId?: string | null): string[] {
    const keys: string[] = [];
    if (walletAddress && walletAddress.trim().length > 0) {
      keys.push(`wallet:${walletAddress.trim()}`);
    }
    if (userId && userId.trim().length > 0) {
      keys.push(`user:${userId.trim()}`);
    }
    return keys;
  }

  /**
   * Checks whether a wallet address (or userId) is currently locked out due to
   * repeated non-existent transaction hash submissions.
   */
  public getLockoutRemainingSeconds(
    walletAddress?: string | null,
    userId?: string | null
  ): number {
    const now = this.nowFn();
    const keys = this.getActorLockoutKeys(walletAddress, userId);

    for (const key of keys) {
      const state = this.lockoutStore.get(key);
      if (state && state.lockedUntil > now) {
        return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
      }
    }
    return 0;
  }

  /**
   * Records the outcome of a Horizon/Soroban transaction lookup for a deposit verification attempt.
   * Locks out the wallet address after 3 consecutive non-existent transaction hashes.
   */
  public async recordTransactionLookupOutcome(params: {
    walletAddress?: string | null;
    userId?: string | null;
    txExists: boolean;
  }): Promise<{ lockedOut: boolean; consecutiveFailures: number; retryAfterSeconds: number }> {
    const now = this.nowFn();
    const keys = this.getActorLockoutKeys(params.walletAddress, params.userId);
    let maxFailures = 0;
    let lockedOut = false;
    let retryAfterSeconds = 0;

    for (const key of keys) {
      const existing = this.lockoutStore.get(key) ?? {
        consecutiveNotFound: 0,
        lockedUntil: 0,
      };

      if (params.txExists) {
        existing.consecutiveNotFound = 0;
        existing.lockedUntil = 0;
        this.lockoutStore.set(key, existing);
      } else {
        existing.consecutiveNotFound += 1;
        if (existing.consecutiveNotFound >= this.maxConsecutiveNonExistentTx) {
          existing.lockedUntil = now + this.lockoutDurationMs;
          lockedOut = true;
          retryAfterSeconds = Math.max(1, Math.ceil(this.lockoutDurationMs / 1000));
        }
        this.lockoutStore.set(key, existing);
      }

      if (existing.consecutiveNotFound > maxFailures) {
        maxFailures = existing.consecutiveNotFound;
      }

      if (this.redisClient) {
        try {
          await this.redisClient.set(
            `deposit:lockout:${key}`,
            JSON.stringify(existing),
            "EX",
            Math.ceil(this.lockoutDurationMs / 1000)
          );
        } catch {
          // Graceful fallback to in-memory lockout map
        }
      }
    }

    return {
      lockedOut,
      consecutiveFailures: maxFailures,
      retryAfterSeconds,
    };
  }

  private incrementCounter(
    map: Map<string, WalletRateLimitEntry>,
    key: string,
    now: number
  ): WalletRateLimitEntry {
    let entry = map.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      map.set(key, entry);
    } else {
      entry.count += 1;
    }
    return entry;
  }

  /**
   * Express middleware enforcing:
   * 1. Temporary lockout check if wallet submitted 3 consecutive non-existent tx hashes
   * 2. Per-wallet sliding/fixed window limit (5 attempts / minute across any IPs)
   * 3. Compound key (IP + wallet + userId) limit (5 attempts / minute)
   */
  public middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const now = this.nowFn();
      const ip = extractClientIp(req);
      const walletAddress = extractWalletAddress(req);
      const userId = req.user?.id ?? null;

      // 1. Check anti-scanning lockout status
      const lockoutSeconds = this.getLockoutRemainingSeconds(walletAddress, userId);
      if (lockoutSeconds > 0) {
        res.setHeader?.("Retry-After", String(lockoutSeconds));
        res.setHeader?.("RateLimit-Limit", String(this.maxWalletRequests));
        res.setHeader?.("RateLimit-Remaining", "0");
        res.setHeader?.("RateLimit-Reset", String(lockoutSeconds));
        res.status(429).json({
          success: false,
          error: "Too Many Requests",
          code: "WALLET_LOCKED_NON_EXISTENT_TX",
          message:
            "Wallet address is temporarily locked due to repeated submissions of non-existent transaction hashes.",
          retryAfter: lockoutSeconds,
        });
        return;
      }

      // 2. Enforce per-wallet limit across all IP addresses
      if (walletAddress) {
        const walletKey = `deposit:wallet:${walletAddress}`;
        const walletEntry = this.incrementCounter(this.walletCounters, walletKey, now);
        const walletRemaining = Math.max(0, this.maxWalletRequests - walletEntry.count);
        const walletResetSeconds = Math.max(1, Math.ceil((walletEntry.resetAt - now) / 1000));

        res.setHeader?.("RateLimit-Limit", String(this.maxWalletRequests));
        res.setHeader?.("RateLimit-Remaining", String(walletRemaining));
        res.setHeader?.("RateLimit-Reset", String(walletResetSeconds));

        if (walletEntry.count > this.maxWalletRequests) {
          res.setHeader?.("Retry-After", String(walletResetSeconds));
          res.status(429).json({
            success: false,
            error: "Too Many Requests",
            code: "WALLET_RATE_LIMIT_EXCEEDED",
            message: `Rate limit exceeded for wallet ${walletAddress}. Maximum ${this.maxWalletRequests} deposit verification attempts per minute allowed.`,
            retryAfter: walletResetSeconds,
          });
          return;
        }
      }

      // 3. Enforce compound key (IP + wallet + userId) limit
      const compoundKey = buildCompoundDepositKey({ ip, walletAddress, userId });
      const compoundEntry = this.incrementCounter(this.compoundCounters, compoundKey, now);
      const compoundRemaining = Math.max(0, this.maxCompoundRequests - compoundEntry.count);
      const compoundResetSeconds = Math.max(1, Math.ceil((compoundEntry.resetAt - now) / 1000));

      if (!walletAddress) {
        res.setHeader?.("RateLimit-Limit", String(this.maxCompoundRequests));
        res.setHeader?.("RateLimit-Remaining", String(compoundRemaining));
        res.setHeader?.("RateLimit-Reset", String(compoundResetSeconds));
      }

      if (compoundEntry.count > this.maxCompoundRequests) {
        res.setHeader?.("Retry-After", String(compoundResetSeconds));
        res.status(429).json({
          success: false,
          error: "Too Many Requests",
          code: "COMPOUND_RATE_LIMIT_EXCEEDED",
          message: `Maximum ${this.maxCompoundRequests} deposit verification attempts per minute exceeded.`,
          retryAfter: compoundResetSeconds,
        });
        return;
      }

      next();
    };
  }
}

export const defaultWalletDepositLimiter = new WalletDepositRateLimiter();

export const walletDepositRateLimiter = defaultWalletDepositLimiter.middleware();

export function resetAllRateLimiters(): void {
  defaultWalletDepositLimiter.reset();
}

export async function recordDepositTxLookupOutcome(params: {
  walletAddress?: string | null;
  userId?: string | null;
  txExists: boolean;
}) {
  return defaultWalletDepositLimiter.recordTransactionLookupOutcome(params);
}
