/**
 * Currency Converter — Multi-Asset Exchange Rate Management
 *
 * Manages conversion between USDC, ZEC, and XLM using current market rates.
 * Caches rates with configurable TTL for consistency across a settlement batch.
 * All conversions use integer arithmetic with explicit rounding modes.
 */

export type Currency = "USDC" | "ZEC" | "XLM";

export interface ExchangeRate {
  from: Currency;
  to: Currency;
  rate: number; // 1 unit of 'from' = 'rate' units of 'to'
  timestamp: Date;
  ttlSeconds: number;
}

export interface ConversionResult {
  originalAmount: number;
  originalCurrency: Currency;
  convertedAmount: number;
  targetCurrency: Currency;
  rate: ExchangeRate;
  slippageInCents: number; // rounding loss in cents
}

export interface RateSnapshot {
  rates: Map<string, number>; // key: "FROM_TO", value: rate
  timestamp: Date;
  ttlSeconds: number;
}

/**
 * Currency converter with in-memory rate caching and explicit rounding.
 */
export class CurrencyConverter {
  private rateCache: Map<string, ExchangeRate> = new Map();
  private currentSnapshot: RateSnapshot | null = null;
  private rateProvider: IExchangeRateProvider;

  constructor(rateProvider: IExchangeRateProvider) {
    this.rateProvider = rateProvider;
  }

  /**
   * Fetch and cache exchange rates for a settlement batch.
   * Rates remain constant throughout the batch.
   *
   * @param currencies - Asset types to fetch rates for
   * @param ttlSeconds - How long to cache rates
   */
  async captureRateSnapshot(
    currencies: Currency[],
    ttlSeconds: number = 60
  ): Promise<RateSnapshot> {
    const snapshot: RateSnapshot = {
      rates: new Map(),
      timestamp: new Date(),
      ttlSeconds,
    };

    // Fetch all pairwise rates
    for (const from of currencies) {
      for (const to of currencies) {
        if (from === to) {
          snapshot.rates.set(`${from}_${to}`, 1);
        } else {
          const rate = await this.rateProvider.getRate(from, to);
          snapshot.rates.set(`${from}_${to}`, rate);

          // Cache for later use
          const cacheKey = `${from}_${to}`;
          this.rateCache.set(cacheKey, {
            from,
            to,
            rate,
            timestamp: snapshot.timestamp,
            ttlSeconds,
          });
        }
      }
    }

    this.currentSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Convert an amount between two currencies using current/cached rates.
   *
   * @param amount - Amount in source currency (base units)
   * @param from - Source currency
   * @param to - Target currency
   * @param roundingMode - "floor" | "ceil" | "round"
   * @returns Conversion result with rounding loss tracking
   */
  convert(
    amount: number,
    from: Currency,
    to: Currency,
    roundingMode: "floor" | "ceil" | "round" = "round"
  ): ConversionResult {
    if (amount < 0) {
      throw new Error("Amount must be non-negative");
    }

    if (from === to) {
      return {
        originalAmount: amount,
        originalCurrency: from,
        convertedAmount: amount,
        targetCurrency: to,
        rate: {
          from,
          to,
          rate: 1,
          timestamp: new Date(),
          ttlSeconds: 0,
        },
        slippageInCents: 0,
      };
    }

    // Use current snapshot or fetch on-demand
    const rate = this.getRate(from, to);

    // Convert: multiply amount by rate
    // Keep high precision during calculation
    const precisionFactor = 1_000_000; // use 6 decimal places
    const scaledAmount = amount * precisionFactor;
    const scaledResult = scaledAmount * rate;

    // Apply rounding mode
    let convertedAmount: number;
    switch (roundingMode) {
      case "floor":
        convertedAmount = Math.floor(scaledResult) / precisionFactor;
        break;
      case "ceil":
        convertedAmount = Math.ceil(scaledResult) / precisionFactor;
        break;
      case "round":
      default:
        convertedAmount = Math.round(scaledResult) / precisionFactor;
        break;
    }

    // Calculate slippage in cents (1/100th of base unit)
    // We need to track how much precision was lost
    const exactCents = (scaledResult * 100) / precisionFactor;
    const roundedCents = Math.round(exactCents);
    const slippageInCents = Math.abs(roundedCents - exactCents);

    return {
      originalAmount: amount,
      originalCurrency: from,
      convertedAmount,
      targetCurrency: to,
      rate: {
        from,
        to,
        rate,
        timestamp: new Date(),
        ttlSeconds: 0,
      },
      slippageInCents,
    };
  }

  /**
   * Batch convert multiple amounts to a target currency.
   * Useful for consolidating multi-currency settlements.
   */
  batchConvert(
    amounts: Array<{
      amount: number;
      currency: Currency;
    }>,
    targetCurrency: Currency,
    roundingMode: "floor" | "ceil" | "round" = "round"
  ): {
    total: number;
    conversions: ConversionResult[];
    totalSlippageInCents: number;
  } {
    const conversions = amounts.map((item) =>
      this.convert(item.amount, item.currency, targetCurrency, roundingMode)
    );

    const total = conversions.reduce((sum, c) => sum + c.convertedAmount, 0);
    const totalSlippageInCents = conversions.reduce(
      (sum, c) => sum + c.slippageInCents,
      0
    );

    return {
      total,
      conversions,
      totalSlippageInCents,
    };
  }

  /**
   * Check if current rate snapshot is still valid.
   */
  isSnapshotValid(): boolean {
    if (!this.currentSnapshot) return false;

    const ageSeconds =
      (new Date().getTime() - this.currentSnapshot.timestamp.getTime()) / 1000;
    return ageSeconds < this.currentSnapshot.ttlSeconds;
  }

  /**
   * Get a specific exchange rate (from cache or snapshot).
   */
  private getRate(from: Currency, to: Currency): number {
    const cacheKey = `${from}_${to}`;

    // Check cache first
    const cached = this.rateCache.get(cacheKey);
    if (cached) {
      const ageSeconds = (new Date().getTime() - cached.timestamp.getTime()) / 1000;
      if (ageSeconds < cached.ttlSeconds) {
        return cached.rate;
      }
    }

    // Check current snapshot
    if (this.currentSnapshot) {
      const snapshotRate = this.currentSnapshot.rates.get(cacheKey);
      if (snapshotRate !== undefined) {
        return snapshotRate;
      }
    }

    throw new Error(
      `No exchange rate available for ${from} -> ${to}. Call captureRateSnapshot() first.`
    );
  }

  /**
   * Clear all cached rates.
   */
  clearCache(): void {
    this.rateCache.clear();
    this.currentSnapshot = null;
  }
}

/**
 * Interface for pluggable exchange rate providers.
 * Implement this to connect to a real oracle (Stellar DEX, Coinbase, etc.)
 */
export interface IExchangeRateProvider {
  /**
   * Get the exchange rate from one currency to another.
   * Should return rate such that 1 unit of 'from' = rate units of 'to'.
   */
  getRate(from: Currency, to: Currency): Promise<number>;
}

/**
 * Mock rate provider for testing.
 */
export class MockRateProvider implements IExchangeRateProvider {
  private rates: Map<string, number> = new Map();

  constructor(rates?: Record<string, number>) {
    this.rates = new Map(Object.entries(rates || {}));

    // Set defaults if not provided
    if (!this.rates.has("USDC_ZEC")) this.rates.set("USDC_ZEC", 0.015); // 1 USDC = 0.015 ZEC
    if (!this.rates.has("USDC_XLM")) this.rates.set("USDC_XLM", 4.5); // 1 USDC = 4.5 XLM
    if (!this.rates.has("ZEC_USDC")) this.rates.set("ZEC_USDC", 67.0); // 1 ZEC = 67 USDC
    if (!this.rates.has("ZEC_XLM")) this.rates.set("ZEC_XLM", 300.0); // 1 ZEC = 300 XLM
    if (!this.rates.has("XLM_USDC")) this.rates.set("XLM_USDC", 0.22); // 1 XLM = 0.22 USDC
    if (!this.rates.has("XLM_ZEC")) this.rates.set("XLM_ZEC", 0.0033); // 1 XLM = 0.0033 ZEC
  }

  async getRate(from: string, to: string): Promise<number> {
    const key = `${from}_${to}`;
    const rate = this.rates.get(key);
    if (!rate) {
      throw new Error(`No rate defined for ${key}`);
    }
    return rate;
  }

  setRate(from: string, to: string, rate: number): void {
    this.rates.set(`${from}_${to}`, rate);
  }
}
