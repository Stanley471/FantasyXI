import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerOpenError,
  calculateDecorrelatedJitter,
} from "../services/fpl/circuitBreaker.js";
import { FplClient } from "../services/fpl/fplClient.js";
import { IRedisCacheClient } from "../config/redis.js";

/**
 * Mock Redis client for testing stale fallback and caching interactions
 */
class MockRedisClient implements IRedisCacheClient {
  public store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, mode?: any, duration?: any): Promise<string> {
    const ttlSeconds = mode === "EX" && typeof duration === "number" ? duration : 600;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replaceAll("*", "");
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }
}

describe("FPL Circuit Breaker & Adaptive Backoff (#208)", () => {
  it("opens when failures exceed half of the rolling 30-second sample", async () => {
    const cb = new CircuitBreaker({ failureRateThreshold: 0.5, rollingWindowMs: 30_000, minimumSamples: 4 });
    await assert.rejects(() => cb.execute(async () => { throw new Error("503"); }));
    await cb.execute(async () => "ok");
    await assert.rejects(() => cb.execute(async () => { throw new Error("503"); }));
    await assert.rejects(() => cb.execute(async () => { throw new Error("503"); }));
    assert.equal(cb.getState(), CircuitState.OPEN);
  });

  describe("State Transitions & Cooldown", () => {
    it("starts in CLOSED state and remains CLOSED on success", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, cooldownPeriodMs: 1000 });
      assert.equal(cb.getState(), CircuitState.CLOSED);

      const result = await cb.execute(async () => "ok");
      assert.equal(result, "ok");
      assert.equal(cb.getState(), CircuitState.CLOSED);
      assert.equal(cb.getConsecutiveFailures(), 0);
    });

    it("trips from CLOSED to OPEN after failureThreshold consecutive failures", async () => {
      const stateChanges: Array<{ from: CircuitState; to: CircuitState }> = [];
      const cb = new CircuitBreaker({
        failureThreshold: 3,
        cooldownPeriodMs: 2000,
        onStateChange: (from, to) => stateChanges.push({ from, to }),
      });

      for (let i = 0; i < 2; i++) {
        await assert.rejects(async () => {
          await cb.execute(async () => {
            throw new Error("HTTP 500 Internal Server Error");
          });
        });
        assert.equal(cb.getState(), CircuitState.CLOSED);
      }

      // 3rd failure trips the breaker
      await assert.rejects(async () => {
        await cb.execute(async () => {
          throw new Error("HTTP 429 Too Many Requests");
        });
      });

      assert.equal(cb.getState(), CircuitState.OPEN);
      assert.equal(cb.isOpen(), true);
      assert.equal(stateChanges.length, 1);
      assert.deepEqual(stateChanges[0], { from: CircuitState.CLOSED, to: CircuitState.OPEN });
    });

    it("rejects calls immediately when OPEN without executing action", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownPeriodMs: 5000 });
      await assert.rejects(async () => {
        await cb.execute(async () => {
          throw new Error("Downstream failed");
        });
      });
      assert.equal(cb.getState(), CircuitState.OPEN);

      let actionCalled = false;
      await assert.rejects(
        async () => {
          await cb.execute(async () => {
            actionCalled = true;
            return "unexpected";
          });
        },
        (err: any) => {
          assert.equal(err instanceof CircuitBreakerOpenError, true);
          assert.ok(err.remainingCooldownMs > 0);
          return true;
        }
      );

      assert.equal(actionCalled, false, "Action must not be called when circuit breaker is OPEN");
    });

    it("transitions from OPEN to HALF_OPEN after cooldown period and closes on probe success", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, cooldownPeriodMs: 50 });
      // Trip to OPEN
      await assert.rejects(() => cb.execute(() => Promise.reject(new Error("err 1"))));
      await assert.rejects(() => cb.execute(() => Promise.reject(new Error("err 2"))));
      assert.equal(cb.getState(), CircuitState.OPEN);

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 60));

      // Cooldown elapsed -> state becomes HALF_OPEN
      assert.equal(cb.getState(), CircuitState.HALF_OPEN);

      // Probe succeeds -> transitions to CLOSED
      const probeResult = await cb.execute(async () => "probe-success");
      assert.equal(probeResult, "probe-success");
      assert.equal(cb.getState(), CircuitState.CLOSED);
      assert.equal(cb.getConsecutiveFailures(), 0);
    });

    it("transitions from HALF_OPEN back to OPEN if probe fails", async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, cooldownPeriodMs: 50 });
      await assert.rejects(() => cb.execute(() => Promise.reject(new Error("err 1"))));
      await assert.rejects(() => cb.execute(() => Promise.reject(new Error("err 2"))));
      assert.equal(cb.getState(), CircuitState.OPEN);

      await new Promise((r) => setTimeout(r, 60));
      assert.equal(cb.getState(), CircuitState.HALF_OPEN);

      // Probe fails
      await assert.rejects(() => cb.execute(() => Promise.reject(new Error("probe-failed"))));
      assert.equal(cb.getState(), CircuitState.OPEN);
    });
  });

  describe("Decorrelated Jitter Backoff", () => {
    it("calculates jittered delays within base and max bounds", () => {
      const base = 1000;
      const max = 30000;
      let delay = base;

      for (let i = 0; i < 20; i++) {
        delay = calculateDecorrelatedJitter(delay, base, max);
        assert.ok(delay >= base, `Delay ${delay} must be >= base ${base}`);
        assert.ok(delay <= max, `Delay ${delay} must be <= max ${max}`);
      }
    });

    it("generates varied jittered delays across multiple calculations", () => {
      const delays = new Set<number>();
      for (let i = 0; i < 20; i++) {
        delays.add(calculateDecorrelatedJitter(1000, 500, 10000));
      }
      assert.ok(delays.size > 1, "Decorrelated jitter should produce variable delays");
    });
  });

  describe("FplClient Integration & Stale Cache Fallback", () => {
    const originalFetch = globalThis.fetch;
    let mockRedis: MockRedisClient;
    let client: FplClient;

    beforeEach(() => {
      mockRedis = new MockRedisClient();
      client = new FplClient(
        {
          baseUrl: "https://fantasy.premierleague.com/api",
          redis: mockRedis,
          circuitBreakerOptions: {
            failureThreshold: 2,
            cooldownPeriodMs: 100,
          },
        },
        mockRedis
      );
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("serves stale cached data when upstream fails with 5xx/429", async () => {
      const sampleData = { teams: [{ id: 1, name: "Arsenal" }] };

      // 1. Initial successful fetch populates fresh cache and stale cache
      globalThis.fetch = async () =>
        new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const initial = await client.getWithMetadata<typeof sampleData>("/bootstrap-static/", 1);
      assert.equal(initial.isStale, false);
      assert.deepEqual(initial.data, sampleData);

      // 2. Clear fresh redis and memory TTL to simulate expired cache
      await mockRedis.del("fpl:cache:/bootstrap-static/");
      (client as any).cache.clear();

      // 3. Upstream starts throwing 503
      globalThis.fetch = async () =>
        new Response("Service Unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        });

      // Client should fall back to STALE cache instead of crashing
      const fallback = await client.getWithMetadata<typeof sampleData>("/bootstrap-static/", 1);
      assert.equal(fallback.isStale, true);
      assert.deepEqual(fallback.data, sampleData);
    });

    it("serves stale cached data when circuit breaker trips OPEN", async () => {
      const sampleData = { fixtures: [{ id: 1, team_h: 1, team_a: 2 }] };

      // Successful fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      await client.get("/fixtures/", 1);

      // Clear fresh redis and memory cache so only stale cache remains
      await mockRedis.del("fpl:cache:/fixtures/");
      (client as any).cache.clear();

      // Force trip circuit breaker
      client.circuitBreaker.trip();
      assert.equal(client.circuitBreaker.isOpen(), true);

      // Fetch with circuit breaker open: returns stale data seamlessly
      const result = await client.getWithMetadata<typeof sampleData>("/fixtures/", 1);
      assert.equal(result.isStale, true);
      assert.deepEqual(result.data, sampleData);
    });

    it("throws CircuitBreakerOpenError when circuit is OPEN and no stale cache exists", async () => {
      client.circuitBreaker.trip();
      assert.equal(client.circuitBreaker.isOpen(), true);

      await assert.rejects(
        async () => {
          await client.get("/uncached-endpoint/");
        },
        (err: any) => {
          assert.equal(err instanceof CircuitBreakerOpenError, true);
          return true;
        }
      );
    });
  });
});
