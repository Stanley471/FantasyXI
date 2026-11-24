/**
 * Real-Time FX Rate Oracle Aggregator & Fiat-to-Crypto Volatility Guard (Issue #424)
 *
 * Computes real-time median conversion rates between fiat display currencies
 * and supported crypto assets (USDC, ZEC) with:
 * - Multiple independent public rate providers & priority fallback cascading
 * - Median filtering and outlier rejection (> 5% deviation from median)
 * - 5-minute sliding-window volatility circuit breaker with temporary checkout
 *   locks and user updated-rate acceptance tokens
 * - Redis caching with strict TTL, stale-while-revalidate (SWR) semantics,
 *   and 15-minute hard staleness invalidation
 */

import crypto from "crypto";
import {
  getRedisClient,
  isRedisCircuitOpen,
  recordRedisFailure,
  recordRedisSuccess,
  type IRedisCacheClient,
} from "../../config/redis.js";

export type SupportedCryptoAsset = "USDC" | "ZEC";

export const SUPPORTED_CRYPTO_ASSETS: readonly SupportedCryptoAsset[] = ["USDC", "ZEC"] as const;

export function isSupportedCryptoAsset(value: string): value is SupportedCryptoAsset {
  return value === "USDC" || value === "ZEC";
}

export interface FxRateProvider {
  readonly name: string;
  /** Lower number = higher priority (primary tier = 1, fallback tiers = 2+). */
  readonly priority: number;
  /** Returns fiat price per 1 unit of the given crypto asset (e.g. USD per 1 ZEC). */
  fetchRate(asset: SupportedCryptoAsset, fiat: string): Promise<number>;
}

export interface ProviderQuote {
  provider: string;
  rate: number;
  latencyMs: number;
}

export interface RejectedOutlier {
  provider: string;
  rate: number;
  deviationPct: number;
}

export type RateFreshness = "FRESH" | "STALE_REVALIDATING" | "INVALID";

export interface CachedFxRate {
  asset: SupportedCryptoAsset;
  fiat: string;
  rate: number;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  providersUsed: string[];
  rejectedOutliers: RejectedOutlier[];
}

export interface FxRateResult {
  asset: SupportedCryptoAsset;
  fiat: string;
  /** Fiat price per 1 unit of crypto asset. */
  rate: number;
  freshness: RateFreshness;
  fetchedAt: number;
  ageMs: number;
  providersUsed: string[];
  rejectedOutliers: RejectedOutlier[];
  volatility: VolatilityGuardState;
}

export interface VolatilityObservation {
  rate: number;
  timestamp: number;
}

export interface VolatilityGuardState {
  tripped: boolean;
  fluctuationPct: number;
  windowMs: number;
  windowMinRate?: number;
  windowMaxRate?: number;
  previousRate?: number;
  currentRate?: number;
  trippedAt?: number;
  lockExpiresAt?: number;
  acceptanceToken?: string;
}

export type CheckoutGuardResult =
  | {
      allowed: true;
      asset: SupportedCryptoAsset;
      fiat: string;
      rate: number;
      freshness: RateFreshness;
      rateAccepted: boolean;
      quoteId: string;
    }
  | {
      allowed: false;
      status: "VOLATILITY_LOCKED";
      requiresRateAcceptance: true;
      asset: SupportedCryptoAsset;
      fiat: string;
      updatedRate: number;
      previousRate: number;
      fluctuationPct: number;
      lockExpiresAt: number;
      acceptanceToken: string;
      message: string;
    }
  | {
      allowed: false;
      status: "STALE_INVALID";
      requiresRateAcceptance: false;
      asset: SupportedCryptoAsset;
      fiat: string;
      staleAgeMs: number;
      message: string;
    };

export interface FiatToCryptoConversion {
  fiatAmount: number;
  fiat: string;
  cryptoAmount: number;
  asset: SupportedCryptoAsset;
  rate: number;
  freshness: RateFreshness;
  rateAccepted: boolean;
  quoteId: string;
  timestamp: number;
}

export interface ProviderHealthStatus {
  name: string;
  priority: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export class StaleRateError extends Error {
  public readonly code = "FX_RATE_STALE_INVALID";
  constructor(
    public readonly asset: SupportedCryptoAsset,
    public readonly fiat: string,
    public readonly staleAgeMs: number,
    message?: string,
  ) {
    super(
      message ??
        `FX rate for ${asset}/${fiat} is invalid: all sources failed for more than ${Math.round(staleAgeMs / 60_000)} minutes`,
    );
    this.name = "StaleRateError";
  }
}

export class VolatilityLockError extends Error {
  public readonly code = "FX_VOLATILITY_LOCKED";
  constructor(
    public readonly details: Extract<CheckoutGuardResult, { status: "VOLATILITY_LOCKED" }>,
  ) {
    super(details.message);
    this.name = "VolatilityLockError";
  }
}

export interface FxRateOracleOptions {
  providers?: FxRateProvider[];
  redisClient?: IRedisCacheClient | null;
  /** Maximum allowed deviation from median before rejecting a provider quote (default: 0.05 = 5%). */
  maxOutlierDeviation?: number;
  /** Minimum number of valid provider quotes desired before stopping fallback cascade (default: 2). */
  minQuorum?: number;
  /** Per-provider fetch timeout in ms (default: 3000). */
  providerTimeoutMs?: number;
  /** Fresh cache TTL in ms (default: 30_000 = 30s). */
  freshTtlMs?: number;
  /** Maximum age in ms before a cached rate is marked INVALID (default: 15 * 60 * 1000 = 15m). */
  staleMaxAgeMs?: number;
  /** Sliding window in ms for volatility detection (default: 5 * 60 * 1000 = 5m). */
  volatilityWindowMs?: number;
  /** Relative fluctuation threshold within volatilityWindowMs that trips the breaker (default: 0.05 = 5%). */
  volatilityThreshold?: number;
  /** Per-asset volatility threshold overrides (e.g. tighter for stablecoins like USDC). */
  assetVolatilityThresholds?: Partial<Record<SupportedCryptoAsset, number>>;
  /** Duration in ms that checkouts remain temporarily locked after a volatility trip (default: 120_000 = 2m). */
  checkoutLockDurationMs?: number;
  /** Redis key prefix (default: "fxi:fx:rate:"). */
  redisKeyPrefix?: string;
  /** Clock function for deterministic testing. */
  now?: () => number;
}

export const FX_ORACLE_DEFAULTS = {
  maxOutlierDeviation: 0.05,
  minQuorum: 2,
  providerTimeoutMs: 3_000,
  freshTtlMs: 30_000,
  staleMaxAgeMs: 15 * 60 * 1000,
  volatilityWindowMs: 5 * 60 * 1000,
  volatilityThreshold: 0.05,
  checkoutLockDurationMs: 120_000,
  redisKeyPrefix: "fxi:fx:rate:",
} as const;

// ─── Pure Math Helpers ────────────────────────────────────────────────────────

/** Computes the statistical median of a non-empty array of finite numbers. */
export function computeMedian(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot compute median of empty array");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Filters out provider quotes whose deviation from the initial median exceeds
 * `maxDeviation` (default 5%), then recomputes the median from accepted quotes.
 */
export function filterOutliersAndComputeMedian(
  quotes: ProviderQuote[],
  maxDeviation: number = FX_ORACLE_DEFAULTS.maxOutlierDeviation,
): {
  median: number;
  accepted: ProviderQuote[];
  rejected: RejectedOutlier[];
} {
  const validQuotes = quotes.filter((q) => Number.isFinite(q.rate) && q.rate > 0);
  if (validQuotes.length === 0) {
    throw new Error("No valid positive quotes available for median calculation");
  }

  const initialMedian = computeMedian(validQuotes.map((q) => q.rate));
  const accepted: ProviderQuote[] = [];
  const rejected: RejectedOutlier[] = [];

  for (const quote of validQuotes) {
    const deviation = Math.abs(quote.rate - initialMedian) / initialMedian;
    if (deviation > maxDeviation) {
      rejected.push({
        provider: quote.provider,
        rate: quote.rate,
        deviationPct: Number((deviation * 100).toFixed(4)),
      });
    } else {
      accepted.push(quote);
    }
  }

  if (accepted.length === 0) {
    throw new Error("All provider quotes were rejected as outliers");
  }

  const finalMedian = computeMedian(accepted.map((q) => q.rate));
  return { median: finalMedian, accepted, rejected };
}

// ─── Built-in Independent Public Rate Providers ───────────────────────────────

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class CoinGeckoRateProvider implements FxRateProvider {
  public readonly name = "coingecko";
  public readonly priority = 1;
  private readonly assetMap: Record<SupportedCryptoAsset, string> = {
    USDC: "usd-coin",
    ZEC: "zcash",
  };

  constructor(private readonly timeoutMs: number = FX_ORACLE_DEFAULTS.providerTimeoutMs) {}

  async fetchRate(asset: SupportedCryptoAsset, fiat: string): Promise<number> {
    const id = this.assetMap[asset];
    const vs = fiat.toLowerCase();
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vs)}`;
    const data = await fetchJsonWithTimeout(url, this.timeoutMs);
    const rate = Number(data?.[id]?.[vs]);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid rate from CoinGecko for ${asset}/${fiat}`);
    }
    return rate;
  }
}

export class CoinbaseRateProvider implements FxRateProvider {
  public readonly name = "coinbase";
  public readonly priority = 1;

  constructor(private readonly timeoutMs: number = FX_ORACLE_DEFAULTS.providerTimeoutMs) {}

  async fetchRate(asset: SupportedCryptoAsset, fiat: string): Promise<number> {
    const url = `https://api.coinbase.com/v2/exchange-rates?currency=${encodeURIComponent(asset)}`;
    const data = await fetchJsonWithTimeout(url, this.timeoutMs);
    const rate = Number(data?.data?.rates?.[fiat.toUpperCase()]);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid rate from Coinbase for ${asset}/${fiat}`);
    }
    return rate;
  }
}

export class KrakenRateProvider implements FxRateProvider {
  public readonly name = "kraken";
  public readonly priority = 2;

  constructor(private readonly timeoutMs: number = FX_ORACLE_DEFAULTS.providerTimeoutMs) {}

  async fetchRate(asset: SupportedCryptoAsset, fiat: string): Promise<number> {
    const pair = `${asset}${fiat.toUpperCase()}`;
    const url = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`;
    const data = await fetchJsonWithTimeout(url, this.timeoutMs);
    const firstKey = data?.result ? Object.keys(data.result)[0] : undefined;
    const rate = firstKey ? Number(data.result[firstKey]?.c?.[0]) : NaN;
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid rate from Kraken for ${asset}/${fiat}`);
    }
    return rate;
  }
}

export class BinanceRateProvider implements FxRateProvider {
  public readonly name = "binance";
  public readonly priority = 3;

  constructor(private readonly timeoutMs: number = FX_ORACLE_DEFAULTS.providerTimeoutMs) {}

  async fetchRate(asset: SupportedCryptoAsset, fiat: string): Promise<number> {
    const quote = fiat.toUpperCase() === "USD" ? "USDT" : fiat.toUpperCase();
    const symbol = `${asset}${quote}`;
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
    const data = await fetchJsonWithTimeout(url, this.timeoutMs);
    const rate = Number(data?.price);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid rate from Binance for ${asset}/${fiat}`);
    }
    return rate;
  }
}

export function createDefaultFxProviders(
  timeoutMs: number = FX_ORACLE_DEFAULTS.providerTimeoutMs,
): FxRateProvider[] {
  return [
    new CoinGeckoRateProvider(timeoutMs),
    new CoinbaseRateProvider(timeoutMs),
    new KrakenRateProvider(timeoutMs),
    new BinanceRateProvider(timeoutMs),
  ];
}

// ─── FX Rate Oracle Aggregator ────────────────────────────────────────────────

interface PairVolatilityTracker {
  observations: VolatilityObservation[];
  tripped: boolean;
  fluctuationPct: number;
  previousRate?: number;
  currentRate?: number;
  trippedAt?: number;
  lockExpiresAt?: number;
  acceptanceToken?: string;
}

export class FxRateOracle {
  private readonly providers: FxRateProvider[];
  private readonly redisClient: IRedisCacheClient | null;
  private readonly maxOutlierDeviation: number;
  private readonly minQuorum: number;
  private readonly providerTimeoutMs: number;
  private readonly freshTtlMs: number;
  private readonly staleMaxAgeMs: number;
  private readonly volatilityWindowMs: number;
  private readonly volatilityThreshold: number;
  private readonly assetVolatilityThresholds: Partial<Record<SupportedCryptoAsset, number>>;
  private readonly checkoutLockDurationMs: number;
  private readonly redisKeyPrefix: string;
  private readonly now: () => number;

  private readonly memoryCache = new Map<string, CachedFxRate>();
  private readonly inFlightRefreshes = new Map<string, Promise<CachedFxRate>>();
  private readonly volatilityTrackers = new Map<string, PairVolatilityTracker>();
  private readonly providerHealth = new Map<string, ProviderHealthStatus>();

  constructor(options: FxRateOracleOptions = {}) {
    this.providerTimeoutMs = options.providerTimeoutMs ?? FX_ORACLE_DEFAULTS.providerTimeoutMs;
    this.providers = (options.providers ?? createDefaultFxProviders(this.providerTimeoutMs)).slice().sort(
      (a, b) => a.priority - b.priority,
    );
    this.redisClient = options.redisClient !== undefined ? options.redisClient : getRedisClient();
    this.maxOutlierDeviation = options.maxOutlierDeviation ?? FX_ORACLE_DEFAULTS.maxOutlierDeviation;
    this.minQuorum = options.minQuorum ?? FX_ORACLE_DEFAULTS.minQuorum;
    this.freshTtlMs = options.freshTtlMs ?? FX_ORACLE_DEFAULTS.freshTtlMs;
    this.staleMaxAgeMs = options.staleMaxAgeMs ?? FX_ORACLE_DEFAULTS.staleMaxAgeMs;
    this.volatilityWindowMs = options.volatilityWindowMs ?? FX_ORACLE_DEFAULTS.volatilityWindowMs;
    this.volatilityThreshold = options.volatilityThreshold ?? FX_ORACLE_DEFAULTS.volatilityThreshold;
    this.assetVolatilityThresholds = options.assetVolatilityThresholds ?? { USDC: 0.02, ZEC: 0.05 };
    this.checkoutLockDurationMs =
      options.checkoutLockDurationMs ?? FX_ORACLE_DEFAULTS.checkoutLockDurationMs;
    this.redisKeyPrefix = options.redisKeyPrefix ?? FX_ORACLE_DEFAULTS.redisKeyPrefix;
    this.now = options.now ?? Date.now;

    for (const provider of this.providers) {
      this.providerHealth.set(provider.name, {
        name: provider.name,
        priority: provider.priority,
        consecutiveFailures: 0,
      });
    }
  }

  private pairKey(asset: SupportedCryptoAsset, fiat: string): string {
    return `${asset}:${fiat.toUpperCase()}`;
  }

  private redisKey(asset: SupportedCryptoAsset, fiat: string): string {
    return `${this.redisKeyPrefix}${asset}:${fiat.toUpperCase()}`;
  }

  private getThresholdForAsset(asset: SupportedCryptoAsset): number {
    return this.assetVolatilityThresholds[asset] ?? this.volatilityThreshold;
  }

  // ─── Redis + In-Memory Cache Layer ──────────────────────────────────────────

  private async readCache(asset: SupportedCryptoAsset, fiat: string): Promise<CachedFxRate | null> {
    const key = this.pairKey(asset, fiat);
    const redisKey = this.redisKey(asset, fiat);

    if (this.redisClient && !isRedisCircuitOpen()) {
      try {
        const raw = await this.redisClient.get(redisKey);
        recordRedisSuccess();
        if (raw) {
          const parsed = JSON.parse(raw) as CachedFxRate;
          this.memoryCache.set(key, parsed);
          return parsed;
        }
      } catch {
        recordRedisFailure();
      }
    }

    return this.memoryCache.get(key) ?? null;
  }

  private async writeCache(entry: CachedFxRate): Promise<void> {
    const key = this.pairKey(entry.asset, entry.fiat);
    this.memoryCache.set(key, entry);

    if (this.redisClient && !isRedisCircuitOpen()) {
      try {
        // Store in Redis with strict TTL equal to staleMaxAgeMs so SWR entries remain
        // retrievable during the stale-while-revalidate window and auto-expire afterwards.
        const ttlSeconds = Math.max(1, Math.ceil(this.staleMaxAgeMs / 1000));
        await this.redisClient.set(
          this.redisKey(entry.asset, entry.fiat),
          JSON.stringify(entry),
          "EX",
          ttlSeconds,
        );
        recordRedisSuccess();
      } catch {
        recordRedisFailure();
      }
    }
  }

  // ─── Provider Cascading & Median Aggregation ────────────────────────────────

  private async queryProviderWithTimeout(
    provider: FxRateProvider,
    asset: SupportedCryptoAsset,
    fiat: string,
  ): Promise<ProviderQuote> {
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const rate = await Promise.race<number>([
        provider.fetchRate(asset, fiat),
        new Promise<number>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Provider ${provider.name} timed out after ${this.providerTimeoutMs}ms`)),
            this.providerTimeoutMs,
          );
        }),
      ]);

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Provider ${provider.name} returned non-positive rate: ${rate}`);
      }

      const health = this.providerHealth.get(provider.name);
      if (health) {
        health.consecutiveFailures = 0;
        health.lastSuccessAt = this.now();
        health.lastError = undefined;
      }

      return {
        provider: provider.name,
        rate,
        latencyMs: Math.max(0, this.now() - startedAt),
      };
    } catch (err) {
      const health = this.providerHealth.get(provider.name);
      if (health) {
        health.consecutiveFailures += 1;
        health.lastFailureAt = this.now();
        health.lastError = err instanceof Error ? err.message : String(err);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fetches quotes from providers in priority tiers (fallback cascading).
   * Queries each priority tier in parallel; if the accumulated valid quotes
   * have not reached `minQuorum`, cascades to the next priority tier.
   */
  public async fetchAggregatedRate(
    asset: SupportedCryptoAsset,
    fiat = "USD",
  ): Promise<CachedFxRate> {
    const normalizedFiat = fiat.toUpperCase();
    const tiers = new Map<number, FxRateProvider[]>();
    for (const provider of this.providers) {
      const list = tiers.get(provider.priority) ?? [];
      list.push(provider);
      tiers.set(provider.priority, list);
    }

    const sortedPriorities = [...tiers.keys()].sort((a, b) => a - b);
    const collectedQuotes: ProviderQuote[] = [];
    const errors: string[] = [];

    for (const priority of sortedPriorities) {
      const tierProviders = tiers.get(priority)!;
      const results = await Promise.allSettled(
        tierProviders.map((p) => this.queryProviderWithTimeout(p, asset, normalizedFiat)),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          collectedQuotes.push(result.value);
        } else {
          errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      }

      if (collectedQuotes.length >= this.minQuorum) {
        break;
      }
    }

    if (collectedQuotes.length === 0) {
      throw new Error(
        `All FX rate providers failed for ${asset}/${normalizedFiat}: ${errors.join("; ")}`,
      );
    }

    const { median, accepted, rejected } = filterOutliersAndComputeMedian(
      collectedQuotes,
      this.maxOutlierDeviation,
    );

    const fetchedAt = this.now();
    const entry: CachedFxRate = {
      asset,
      fiat: normalizedFiat,
      rate: median,
      fetchedAt,
      expiresAt: fetchedAt + this.freshTtlMs,
      staleUntil: fetchedAt + this.staleMaxAgeMs,
      providersUsed: accepted.map((q) => q.provider),
      rejectedOutliers: rejected,
    };

    this.recordVolatilityObservation(asset, normalizedFiat, median, fetchedAt);
    await this.writeCache(entry);
    return entry;
  }

  // ─── Volatility Circuit Breaker (5-Minute Sliding Window) ───────────────────

  private getOrCreateTracker(asset: SupportedCryptoAsset, fiat: string): PairVolatilityTracker {
    const key = this.pairKey(asset, fiat);
    let tracker = this.volatilityTrackers.get(key);
    if (!tracker) {
      tracker = {
        observations: [],
        tripped: false,
        fluctuationPct: 0,
      };
      this.volatilityTrackers.set(key, tracker);
    }
    return tracker;
  }

  private recordVolatilityObservation(
    asset: SupportedCryptoAsset,
    fiat: string,
    rate: number,
    timestamp: number,
  ): void {
    const tracker = this.getOrCreateTracker(asset, fiat);
    const windowStart = timestamp - this.volatilityWindowMs;

    // Prune observations older than the 5-minute sliding window
    tracker.observations = tracker.observations.filter((o) => o.timestamp >= windowStart);

    const previousRate =
      tracker.observations.length > 0
        ? tracker.observations[tracker.observations.length - 1].rate
        : rate;

    tracker.observations.push({ rate, timestamp });

    let minRate = rate;
    let maxRate = rate;
    for (const obs of tracker.observations) {
      if (obs.rate < minRate) minRate = obs.rate;
      if (obs.rate > maxRate) maxRate = obs.rate;
    }

    const fluctuation = minRate > 0 ? (maxRate - minRate) / minRate : 0;
    tracker.fluctuationPct = Number((fluctuation * 100).toFixed(4));
    tracker.currentRate = rate;

    const threshold = this.getThresholdForAsset(asset);
    if (fluctuation > threshold) {
      tracker.tripped = true;
      tracker.previousRate = previousRate;
      tracker.trippedAt = timestamp;
      tracker.lockExpiresAt = timestamp + this.checkoutLockDurationMs;
      tracker.acceptanceToken = crypto
        .createHash("sha256")
        .update(`${asset}:${fiat}:${rate}:${timestamp}:${crypto.randomBytes(8).toString("hex")}`)
        .digest("hex")
        .slice(0, 32);
    } else if (tracker.tripped && tracker.lockExpiresAt !== undefined && timestamp >= tracker.lockExpiresAt) {
      // Lock period elapsed and volatility has settled within the window
      tracker.tripped = false;
      tracker.acceptanceToken = undefined;
      tracker.lockExpiresAt = undefined;
    }
  }

  public getVolatilityState(asset: SupportedCryptoAsset, fiat = "USD"): VolatilityGuardState {
    const normalizedFiat = fiat.toUpperCase();
    const tracker = this.getOrCreateTracker(asset, normalizedFiat);
    const now = this.now();
    const windowStart = now - this.volatilityWindowMs;
    const recent = tracker.observations.filter((o) => o.timestamp >= windowStart);

    // Auto-clear expired lock if volatility is no longer above threshold
    let tripped = tracker.tripped;
    if (tripped && tracker.lockExpiresAt !== undefined && now >= tracker.lockExpiresAt) {
      tripped = false;
      tracker.tripped = false;
      tracker.acceptanceToken = undefined;
      tracker.lockExpiresAt = undefined;
    }

    let windowMinRate: number | undefined;
    let windowMaxRate: number | undefined;
    for (const obs of recent) {
      if (windowMinRate === undefined || obs.rate < windowMinRate) windowMinRate = obs.rate;
      if (windowMaxRate === undefined || obs.rate > windowMaxRate) windowMaxRate = obs.rate;
    }

    return {
      tripped,
      fluctuationPct: tracker.fluctuationPct,
      windowMs: this.volatilityWindowMs,
      windowMinRate,
      windowMaxRate,
      previousRate: tracker.previousRate,
      currentRate: tracker.currentRate,
      trippedAt: tracker.trippedAt,
      lockExpiresAt: tracker.lockExpiresAt,
      acceptanceToken: tripped ? tracker.acceptanceToken : undefined,
    };
  }

  // ─── Public Rate Retrieval (Strict TTL + Stale-While-Revalidate) ────────────

  private triggerBackgroundRefresh(asset: SupportedCryptoAsset, fiat: string): Promise<CachedFxRate> {
    const key = this.pairKey(asset, fiat);
    const existing = this.inFlightRefreshes.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.fetchAggregatedRate(asset, fiat).finally(() => {
      this.inFlightRefreshes.delete(key);
    });
    this.inFlightRefreshes.set(key, promise);
    // Prevent unhandled rejection when called fire-and-forget during SWR
    promise.catch(() => undefined);
    return promise;
  }

  /**
   * Returns the current FX rate for `asset`/`fiat` using Redis cache with
   * strict TTL and stale-while-revalidate semantics.
   *
   * - Within `freshTtlMs`: returns cached rate (`FRESH`).
   * - Past `freshTtlMs` but within `staleMaxAgeMs` (15m): returns cached rate
   *   immediately (`STALE_REVALIDATING`) and triggers async background refresh.
   * - Past `staleMaxAgeMs` (all sources failed > 15m): attempts synchronous
   *   refresh; if that fails, throws `StaleRateError` (rate is `INVALID`).
   */
  public async getRate(
    asset: SupportedCryptoAsset,
    fiat = "USD",
    options: { forceRefresh?: boolean } = {},
  ): Promise<FxRateResult> {
    const normalizedFiat = fiat.toUpperCase();
    const now = this.now();
    const cached = await this.readCache(asset, normalizedFiat);

    if (cached && !options.forceRefresh) {
      const ageMs = Math.max(0, now - cached.fetchedAt);

      // 1. Fresh cache hit
      if (now < cached.expiresAt) {
        return {
          asset,
          fiat: normalizedFiat,
          rate: cached.rate,
          freshness: "FRESH",
          fetchedAt: cached.fetchedAt,
          ageMs,
          providersUsed: cached.providersUsed,
          rejectedOutliers: cached.rejectedOutliers,
          volatility: this.getVolatilityState(asset, normalizedFiat),
        };
      }

      // 2. Stale-while-revalidate window (expired fresh TTL, but <= 15m old)
      if (ageMs <= this.staleMaxAgeMs) {
        this.triggerBackgroundRefresh(asset, normalizedFiat);
        return {
          asset,
          fiat: normalizedFiat,
          rate: cached.rate,
          freshness: "STALE_REVALIDATING",
          fetchedAt: cached.fetchedAt,
          ageMs,
          providersUsed: cached.providersUsed,
          rejectedOutliers: cached.rejectedOutliers,
          volatility: this.getVolatilityState(asset, normalizedFiat),
        };
      }
    }

    // 3. No cache, forceRefresh, or cache is older than 15m (stale-invalid) -> synchronous fetch
    try {
      const fresh = await this.triggerBackgroundRefresh(asset, normalizedFiat);
      return {
        asset,
        fiat: normalizedFiat,
        rate: fresh.rate,
        freshness: "FRESH",
        fetchedAt: fresh.fetchedAt,
        ageMs: Math.max(0, this.now() - fresh.fetchedAt),
        providersUsed: fresh.providersUsed,
        rejectedOutliers: fresh.rejectedOutliers,
        volatility: this.getVolatilityState(asset, normalizedFiat),
      };
    } catch {
      const staleAgeMs = cached ? Math.max(0, now - cached.fetchedAt) : this.staleMaxAgeMs + 1;
      if (cached && staleAgeMs <= this.staleMaxAgeMs) {
        // Still within 15m grace window even on forceRefresh failure
        return {
          asset,
          fiat: normalizedFiat,
          rate: cached.rate,
          freshness: "STALE_REVALIDATING",
          fetchedAt: cached.fetchedAt,
          ageMs: staleAgeMs,
          providersUsed: cached.providersUsed,
          rejectedOutliers: cached.rejectedOutliers,
          volatility: this.getVolatilityState(asset, normalizedFiat),
        };
      }
      throw new StaleRateError(asset, normalizedFiat, staleAgeMs);
    }
  }

  // ─── Checkout Volatility Guard & Conversion ─────────────────────────────────

  /**
   * Checks whether an entry fee checkout is allowed to proceed for `asset`/`fiat`.
   * - If all sources have failed for > 15 minutes -> `STALE_INVALID`.
   * - If the 5-minute volatility circuit breaker is tripped and no valid
   *   `acceptedRateToken` is supplied -> `VOLATILITY_LOCKED` with
   *   `requiresRateAcceptance: true` and an `acceptanceToken` for the user.
   * - If the user supplies the matching `acceptedRateToken` -> allowed.
   */
  public async evaluateCheckoutGuard(
    asset: SupportedCryptoAsset,
    fiat = "USD",
    acceptedRateToken?: string,
  ): Promise<CheckoutGuardResult> {
    const normalizedFiat = fiat.toUpperCase();
    let rateResult: FxRateResult;

    try {
      rateResult = await this.getRate(asset, normalizedFiat);
    } catch (err) {
      if (err instanceof StaleRateError) {
        return {
          allowed: false,
          status: "STALE_INVALID",
          requiresRateAcceptance: false,
          asset,
          fiat: normalizedFiat,
          staleAgeMs: err.staleAgeMs,
          message: err.message,
        };
      }
      throw err;
    }

    const volatility = rateResult.volatility;
    if (volatility.tripped) {
      const tokenMatches =
        Boolean(acceptedRateToken) &&
        Boolean(volatility.acceptanceToken) &&
        acceptedRateToken === volatility.acceptanceToken;

      if (!tokenMatches) {
        return {
          allowed: false,
          status: "VOLATILITY_LOCKED",
          requiresRateAcceptance: true,
          asset,
          fiat: normalizedFiat,
          updatedRate: rateResult.rate,
          previousRate: volatility.previousRate ?? rateResult.rate,
          fluctuationPct: volatility.fluctuationPct,
          lockExpiresAt: volatility.lockExpiresAt ?? this.now() + this.checkoutLockDurationMs,
          acceptanceToken: volatility.acceptanceToken!,
          message: `Rapid ${asset}/${normalizedFiat} price movement (${volatility.fluctuationPct.toFixed(2)}% in 5m). Please accept the updated rate to continue checkout.`,
        };
      }

      return {
        allowed: true,
        asset,
        fiat: normalizedFiat,
        rate: rateResult.rate,
        freshness: rateResult.freshness,
        rateAccepted: true,
        quoteId: crypto.randomUUID(),
      };
    }

    return {
      allowed: true,
      asset,
      fiat: normalizedFiat,
      rate: rateResult.rate,
      freshness: rateResult.freshness,
      rateAccepted: false,
      quoteId: crypto.randomUUID(),
    };
  }

  /**
   * Converts a fiat display entry fee amount into the equivalent crypto amount,
   * enforcing both stale-price invalidation and the volatility circuit breaker.
   */
  public async convertFiatToCrypto(
    fiatAmount: number,
    asset: SupportedCryptoAsset,
    fiat = "USD",
    options: { acceptedRateToken?: string } = {},
  ): Promise<FiatToCryptoConversion> {
    if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
      throw new Error(`Invalid fiat amount: ${fiatAmount}`);
    }

    const guard = await this.evaluateCheckoutGuard(asset, fiat, options.acceptedRateToken);
    if (!guard.allowed) {
      if (guard.status === "VOLATILITY_LOCKED") {
        throw new VolatilityLockError(guard);
      }
      throw new StaleRateError(guard.asset, guard.fiat, guard.staleAgeMs, guard.message);
    }

    const cryptoAmount = Number((fiatAmount / guard.rate).toFixed(8));
    return {
      fiatAmount,
      fiat: guard.fiat,
      cryptoAmount,
      asset: guard.asset,
      rate: guard.rate,
      freshness: guard.freshness,
      rateAccepted: guard.rateAccepted,
      quoteId: guard.quoteId,
      timestamp: this.now(),
    };
  }

  /** Returns health telemetry for all configured providers and active volatility guards. */
  public getStatus(): {
    providers: ProviderHealthStatus[];
    volatilityGuards: Record<string, VolatilityGuardState>;
  } {
    const volatilityGuards: Record<string, VolatilityGuardState> = {};
    for (const key of this.volatilityTrackers.keys()) {
      const [asset, fiat] = key.split(":") as [SupportedCryptoAsset, string];
      volatilityGuards[key] = this.getVolatilityState(asset, fiat);
    }
    return {
      providers: [...this.providerHealth.values()],
      volatilityGuards,
    };
  }
}

let singletonOracle: FxRateOracle | null = null;

export function getFxRateOracle(): FxRateOracle {
  if (!singletonOracle) {
    singletonOracle = new FxRateOracle();
  }
  return singletonOracle;
}
