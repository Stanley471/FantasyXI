import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  computeMedian,
  filterOutliersAndComputeMedian,
  FxRateOracle,
  StaleRateError,
  VolatilityLockError,
  type FxRateProvider,
  type SupportedCryptoAsset,
} from "../services/financial/fxRateOracle.js";
import { createFxOracleRouter } from "../routes/fxOracle.routes.js";
import type { IRedisCacheClient } from "../config/redis.js";

class MockRedisClient implements IRedisCacheClient {
  public store = new Map<string, { value: string; expiresAt?: number }>();
  public shouldThrow = false;
  public setCalls = 0;
  public getCalls = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.shouldThrow) throw new Error("Redis connection refused");
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt !== undefined && this.now() >= item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ...args: any[]): Promise<string> {
    this.setCalls += 1;
    if (this.shouldThrow) throw new Error("Redis write failed");
    let expiresAt: number | undefined;
    if (args[0] === "EX" && typeof args[1] === "number") {
      expiresAt = this.now() + args[1] * 1000;
    }
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count += 1;
    }
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, "");
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

function makeProvider(
  name: string,
  priority: number,
  handler: (asset: SupportedCryptoAsset, fiat: string) => Promise<number>,
): FxRateProvider {
  return { name, priority, fetchRate: handler };
}

describe("FxRateOracle - Median Filtering & Outlier Rejection", () => {
  it("computes median for odd and even arrays", () => {
    assert.equal(computeMedian([30, 10, 20]), 20);
    assert.equal(computeMedian([40, 10, 30, 20]), 25);
  });

  it("rejects individual provider outliers exceeding 5% deviation from median", () => {
    const { median, accepted, rejected } = filterOutliersAndComputeMedian(
      [
        { provider: "coingecko", rate: 40.0, latencyMs: 10 },
        { provider: "coinbase", rate: 40.4, latencyMs: 12 },
        { provider: "kraken", rate: 39.8, latencyMs: 15 },
        { provider: "manipulated-high", rate: 45.0, latencyMs: 8 }, // +12.5%
        { provider: "manipulated-low", rate: 35.0, latencyMs: 9 }, // -12.5%
      ],
      0.05,
    );

    assert.equal(accepted.length, 3);
    assert.equal(rejected.length, 2);
    assert.deepEqual(
      rejected.map((r) => r.provider).sort(),
      ["manipulated-high", "manipulated-low"],
    );
    assert.equal(median, 40.0);
  });

  it("keeps quotes within the 5% deviation band", () => {
    const { median, accepted, rejected } = filterOutliersAndComputeMedian(
      [
        { provider: "p1", rate: 1.0, latencyMs: 5 },
        { provider: "p2", rate: 1.04, latencyMs: 5 },
        { provider: "p3", rate: 0.96, latencyMs: 5 },
      ],
      0.05,
    );

    assert.equal(accepted.length, 3);
    assert.equal(rejected.length, 0);
    assert.equal(median, 1.0);
  });
});

describe("FxRateOracle - Provider Dropout & Fallback Cascading", () => {
  it("cascades to secondary providers when primary tier drops out", async () => {
    let nowMs = 1_700_000_000_000;
    const called: string[] = [];

    const oracle = new FxRateOracle({
      now: () => nowMs,
      redisClient: new MockRedisClient(() => nowMs),
      minQuorum: 2,
      providers: [
        makeProvider("primary-a", 1, async () => {
          called.push("primary-a");
          throw new Error("503 Service Unavailable");
        }),
        makeProvider("primary-b", 1, async () => {
          called.push("primary-b");
          return 42.0;
        }),
        makeProvider("fallback-c", 2, async () => {
          called.push("fallback-c");
          return 42.2;
        }),
        makeProvider("fallback-d", 3, async () => {
          called.push("fallback-d");
          return 42.4;
        }),
      ],
    });

    const result = await oracle.getRate("ZEC", "USD");
    assert.equal(result.rate, 42.1);
    assert.equal(result.freshness, "FRESH");
    assert.deepEqual(result.providersUsed.sort(), ["fallback-c", "primary-b"]);
    // Priority 3 should not be queried because quorum (2) was reached at priority 2
    assert.equal(called.includes("fallback-d"), false);

    const status = oracle.getStatus();
    const primaryA = status.providers.find((p) => p.name === "primary-a");
    assert.equal(primaryA?.consecutiveFailures, 1);
  });
});

describe("FxRateOracle - Flash Crash & Volatility Circuit Breaker", () => {
  it("triggers temporary checkout lock on rapid 5-minute price move and unlocks with updated rate acceptance", async () => {
    let nowMs = 1_700_000_000_000;
    let currentZecPrice = 40.0;

    const oracle = new FxRateOracle({
      now: () => nowMs,
      redisClient: new MockRedisClient(() => nowMs),
      freshTtlMs: 10_000,
      volatilityWindowMs: 5 * 60 * 1000,
      assetVolatilityThresholds: { ZEC: 0.05, USDC: 0.02 },
      checkoutLockDurationMs: 120_000,
      minQuorum: 2,
      providers: [
        makeProvider("p1", 1, async () => currentZecPrice),
        makeProvider("p2", 1, async () => currentZecPrice),
      ],
    });

    // Initial stable checkout succeeds
    const initialConversion = await oracle.convertFiatToCrypto(100, "ZEC", "USD");
    assert.equal(initialConversion.rate, 40.0);
    assert.equal(initialConversion.cryptoAmount, 2.5);
    assert.equal(initialConversion.rateAccepted, false);

    // 1 minute later: flash crash (-15% drop from $40 to $34)
    nowMs += 60_000;
    currentZecPrice = 34.0;
    await oracle.getRate("ZEC", "USD", { forceRefresh: true });

    // Checkout without rate acceptance must be locked
    const guardLocked = await oracle.evaluateCheckoutGuard("ZEC", "USD");
    assert.equal(guardLocked.allowed, false);
    if (guardLocked.allowed || guardLocked.status !== "VOLATILITY_LOCKED") {
      assert.fail("Expected VOLATILITY_LOCKED guard result");
    }
    assert.equal(guardLocked.requiresRateAcceptance, true);
    assert.equal(guardLocked.updatedRate, 34.0);
    assert.equal(guardLocked.previousRate, 40.0);
    assert.ok(guardLocked.fluctuationPct > 5);
    assert.ok(guardLocked.acceptanceToken.length > 0);

    // convertFiatToCrypto throws VolatilityLockError without token
    await assert.rejects(
      () => oracle.convertFiatToCrypto(100, "ZEC", "USD"),
      (err: unknown) => err instanceof VolatilityLockError,
    );

    // Wrong acceptance token still blocked
    const wrongTokenGuard = await oracle.evaluateCheckoutGuard("ZEC", "USD", "invalid-token");
    assert.equal(wrongTokenGuard.allowed, false);

    // Valid updated rate acceptance token allows checkout at the new rate
    const acceptedConversion = await oracle.convertFiatToCrypto(100, "ZEC", "USD", {
      acceptedRateToken: guardLocked.acceptanceToken,
    });
    assert.equal(acceptedConversion.rate, 34.0);
    assert.equal(acceptedConversion.rateAccepted, true);
    assert.equal(acceptedConversion.cryptoAmount, Number((100 / 34.0).toFixed(8)));

    // After lock expires and 5-minute window passes, normal checkouts resume
    nowMs += 6 * 60 * 1000;
    await oracle.getRate("ZEC", "USD", { forceRefresh: true });
    const resumedGuard = await oracle.evaluateCheckoutGuard("ZEC", "USD");
    assert.equal(resumedGuard.allowed, true);
  });
});

describe("FxRateOracle - Redis TTL, Stale-While-Revalidate & 15-Minute Invalid Detection", () => {
  it("serves fresh cache, triggers SWR when expired <= 15m, and invalidates after > 15m of total failure", async () => {
    let nowMs = 1_700_000_000_000;
    let providersOnline = true;
    let fetchCount = 0;
    const redis = new MockRedisClient(() => nowMs);

    const oracle = new FxRateOracle({
      now: () => nowMs,
      redisClient: redis,
      freshTtlMs: 30_000,
      staleMaxAgeMs: 15 * 60 * 1000,
      minQuorum: 1,
      providers: [
        makeProvider("p1", 1, async () => {
          fetchCount += 1;
          if (!providersOnline) throw new Error("Provider offline");
          return 1.0;
        }),
      ],
    });

    // 1. Initial fetch populates Redis
    const r1 = await oracle.getRate("USDC", "USD");
    assert.equal(r1.freshness, "FRESH");
    assert.equal(fetchCount, 1);
    assert.equal(redis.setCalls, 1);

    // 2. Within 30s TTL -> fresh cache hit, no provider call
    nowMs += 15_000;
    const r2 = await oracle.getRate("USDC", "USD");
    assert.equal(r2.freshness, "FRESH");
    assert.equal(fetchCount, 1);

    // 3. Past 30s TTL but within 15m, providers offline -> STALE_REVALIDATING
    providersOnline = false;
    nowMs += 60_000; // 75s old
    const r3 = await oracle.getRate("USDC", "USD");
    assert.equal(r3.freshness, "STALE_REVALIDATING");
    assert.equal(r3.rate, 1.0);
    // Wait a tick for fire-and-forget background revalidation attempt
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fetchCount, 2);

    // 4. Advance past 15 minutes with all providers still failing -> INVALID
    nowMs += 15 * 60 * 1000;
    await assert.rejects(
      () => oracle.getRate("USDC", "USD"),
      (err: unknown) => err instanceof StaleRateError && err.code === "FX_RATE_STALE_INVALID",
    );

    const guard = await oracle.evaluateCheckoutGuard("USDC", "USD");
    assert.equal(guard.allowed, false);
    if (guard.allowed) assert.fail("Expected checkout to be blocked when stale invalid");
    assert.equal(guard.status, "STALE_INVALID");
  });

  it("gracefully falls back to in-memory cache when Redis throws", async () => {
    let nowMs = 1_700_000_000_000;
    const redis = new MockRedisClient(() => nowMs);
    redis.shouldThrow = true;

    const oracle = new FxRateOracle({
      now: () => nowMs,
      redisClient: redis,
      minQuorum: 1,
      providers: [makeProvider("p1", 1, async () => 38.5)],
    });

    const result = await oracle.getRate("ZEC", "USD");
    assert.equal(result.rate, 38.5);
    assert.equal(result.freshness, "FRESH");
  });
});

describe("FX Oracle HTTP API Integration", () => {
  it("handles rate queries, volatility 409 prompts, acceptance token retry, and 503 stale invalid", async () => {
    let nowMs = 1_700_000_000_000;
    let price = 50.0;
    let online = true;

    const oracle = new FxRateOracle({
      now: () => nowMs,
      redisClient: new MockRedisClient(() => nowMs),
      freshTtlMs: 10_000,
      staleMaxAgeMs: 15 * 60 * 1000,
      minQuorum: 1,
      providers: [
        makeProvider("p1", 1, async () => {
          if (!online) throw new Error("down");
          return price;
        }),
      ],
    });

    const app = express();
    app.use(express.json());
    app.use("/api/v1/fx", createFxOracleRouter(() => oracle));

    // GET /rate
    const rateRes = await request(app).get("/api/v1/fx/rate?asset=ZEC&fiat=USD");
    assert.equal(rateRes.status, 200);
    assert.equal(rateRes.body.data.rate, 50.0);

    // Unsupported asset -> 400
    const badAsset = await request(app).get("/api/v1/fx/rate?asset=DOGE&fiat=USD");
    assert.equal(badAsset.status, 400);

    // Flash crash -> POST /convert returns 409 with acceptanceToken
    nowMs += 30_000;
    price = 40.0; // -20%
    await oracle.getRate("ZEC", "USD", { forceRefresh: true });

    const lockedRes = await request(app)
      .post("/api/v1/fx/convert")
      .send({ fiatAmount: 100, asset: "ZEC", fiat: "USD" });
    assert.equal(lockedRes.status, 409);
    assert.equal(lockedRes.body.code, "FX_VOLATILITY_LOCKED");
    assert.equal(lockedRes.body.data.requiresRateAcceptance, true);
    const token = lockedRes.body.data.acceptanceToken;
    assert.ok(token);

    // Retry with acceptedRateToken -> 200
    const unlockedRes = await request(app)
      .post("/api/v1/fx/convert")
      .send({ fiatAmount: 100, asset: "ZEC", fiat: "USD", acceptedRateToken: token });
    assert.equal(unlockedRes.status, 200);
    assert.equal(unlockedRes.body.data.rateAccepted, true);
    assert.equal(unlockedRes.body.data.cryptoAmount, 2.5);

    // Stale > 15m -> 503
    online = false;
    nowMs += 16 * 60 * 1000;
    const staleRes = await request(app).get("/api/v1/fx/rate?asset=ZEC&fiat=USD");
    assert.equal(staleRes.status, 503);
    assert.equal(staleRes.body.code, "FX_RATE_STALE_INVALID");

    // GET /status -> 200
    const statusRes = await request(app).get("/api/v1/fx/status");
    assert.equal(statusRes.status, 200);
    assert.ok(Array.isArray(statusRes.body.data.providers));
  });
});
