import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FplClient } from "../services/fpl/fplClient.js";
import { CircuitState } from "../services/fpl/circuitBreaker.js";
import type { IRedisCacheClient } from "../config/redis.js";

function createMockRedis(): IRedisCacheClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK";
    },
    async del(...keys: string[]) {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, "");
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

describe("FplClient Circuit Breaker & 3-Tier Cache Degradation (#275)", () => {
  it("opens circuit after consecutive 503 failures and serves L1/L2/L3 stale fallback with X-Data-Stale headers", async () => {
    const redis = createMockRedis();
    let pgCalled = false;

    const client = new FplClient({
      baseUrl: "https://fpl.mock/api",
      redis,
      maxRetries: 1,
      retryBackoffMs: 1,
      circuitBreakerOptions: {
        failureThreshold: 3,
        cooldownPeriodMs: 60,
        successThreshold: 1,
      },
      postgresSnapshotProvider: async (endpoint: string) => {
        pgCalled = true;
        return { endpoint, source: "postgres-snapshot", elements: [{ id: 99, web_name: "Haaland" }] };
      },
    });

    // 1. Simulate 3 consecutive 503 Service Unavailable failures without L1/L2 cache -> degrades to L3 Postgres snapshot
    client.fetchWithRetry = async () => {
      throw new Error("FPL API failed: [503] Service Unavailable");
    };

    const res1 = await client.getWithMetadata<{ source: string }>("/bootstrap-static/", 10);
    assert.equal(res1.isStale, true);
    assert.equal(res1.source, "STALE_L3_POSTGRES");
    assert.equal(res1.headers["X-Data-Stale"], "true");
    assert.equal(pgCalled, true);

    // Clear L1 stale cache to force 2 more upstream failures so circuit trips to OPEN
    (client as unknown as { staleCache: Map<string, unknown> }).staleCache.clear();
    await client.getWithMetadata("/bootstrap-static/", 10);
    (client as unknown as { staleCache: Map<string, unknown> }).staleCache.clear();
    await client.getWithMetadata("/bootstrap-static/", 10);

    assert.equal(client.circuitBreaker.getState(), CircuitState.OPEN);
    assert.equal(client.getTelemetryHealth().status, "degraded");

    // 2. While OPEN, L1 stale cache is served immediately without calling fetchWithRetry
    let upstreamInvokedWhileOpen = false;
    client.fetchWithRetry = async () => {
      upstreamInvokedWhileOpen = true;
      throw new Error("Should not be called while circuit is OPEN");
    };

    const openRes = await client.getWithMetadata("/bootstrap-static/", 10);
    assert.equal(upstreamInvokedWhileOpen, false);
    assert.equal(openRes.isStale, true);
    assert.equal(openRes.source, "STALE_L1_MEMORY");
    assert.equal(openRes.headers["X-Data-Stale"], "true");

    // 3. Verify Tier 2 (STALE_L2_REDIS) fallback when L1 memory is empty
    (client as unknown as { staleCache: Map<string, unknown> }).staleCache.clear();
    await redis.set(
      "fpl:cache:stale:/fixtures/",
      JSON.stringify([{ id: 1, team_h: 1, team_a: 2 }])
    );
    const l2StaleRes = await client.getWithMetadata<Array<{ id: number }>>("/fixtures/", 10);
    assert.equal(l2StaleRes.isStale, true);
    assert.equal(l2StaleRes.source, "STALE_L2_REDIS");
    assert.equal(l2StaleRes.headers["X-Data-Stale"], "true");
    assert.equal(l2StaleRes.data[0].id, 1);

    // 4. Wait for cooldown (60ms) -> transitions to HALF_OPEN -> upstream recovers -> transitions to CLOSED
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(client.circuitBreaker.getState(), CircuitState.HALF_OPEN);

    client.fetchWithRetry = async () =>
      new Response(JSON.stringify({ events: [], teams: [], elements: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await client.clearCache("/bootstrap-static/");
    const recoveredRes = await client.getWithMetadata("/bootstrap-static/", 60);
    assert.equal(recoveredRes.isStale, false);
    assert.equal(recoveredRes.source, "UPSTREAM");
    assert.equal(recoveredRes.headers["X-Data-Stale"], "false");
    assert.equal(client.circuitBreaker.getState(), CircuitState.CLOSED);
    assert.equal(client.getTelemetryHealth().status, "healthy");
  });
});
