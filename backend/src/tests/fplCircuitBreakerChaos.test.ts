import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
} from "../services/fpl/circuitBreaker.js";
import { FplClient } from "../services/fpl/fplClient.js";
import type { FplSnapshot, FplSnapshotStore } from "../services/fpl/fplSnapshotStore.js";
import { createFplDataFreshness } from "../middleware/fplDataFreshness.js";
import { errorHandler } from "../middleware/error.middleware.js";
import type { IRedisCacheClient } from "../config/redis.js";

/**
 * Chaos tests for FPL upstream outages (issue #275): continuous 503s and
 * Cloudflare challenges must open the circuit within its threshold, every
 * request must then be answered from the 3-tier fallback (memory -> Redis ->
 * PostgreSQL snapshot) without touching the upstream, and the circuit must
 * recover on its own through jittered HALF_OPEN probes.
 */

class MockRedis implements IRedisCacheClient {
  public store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string) {
    const entry = this.store.get(key);
    return entry && Date.now() < entry.expiresAt ? entry.value : null;
  }
  async set(key: string, value: string, _mode?: unknown, ttl?: unknown) {
    this.store.set(key, { value, expiresAt: Date.now() + (typeof ttl === "number" ? ttl : 600) * 1000 });
    return "OK";
  }
  async del(...keys: string[]) {
    return keys.filter((key) => this.store.delete(key)).length;
  }
  async keys(pattern: string) {
    const prefix = pattern.replaceAll("*", "");
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}

class MemorySnapshotStore implements FplSnapshotStore {
  public rows = new Map<string, FplSnapshot>();
  async save(endpoint: string, payload: unknown) {
    this.rows.set(endpoint, { payload, fetchedAt: new Date() });
  }
  async load(endpoint: string) {
    return this.rows.get(endpoint) ?? null;
  }
}

const FIXTURES = [{ id: 1, event: 1, team_h: 1, team_a: 2, finished: false }];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A client whose retry loop makes a single attempt, so chaos runs without real backoff sleeps. */
function chaosClient(options: ConstructorParameters<typeof FplClient>[0]) {
  const client = new FplClient(options);
  client.fetchWithRetry = (url: string) => FplClient.prototype.fetchWithRetry.call(client, url, 1, 1);
  return client;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("FPL circuit breaker chaos: continuous upstream failure (#275)", () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls: number;

  beforeEach(() => {
    upstreamCalls = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("opens on continuous 503s and serves the PostgreSQL snapshot after a cold restart", async () => {
    const snapshots = new MemorySnapshotStore();
    globalThis.fetch = async () => json(FIXTURES);
    const warm = chaosClient({ redis: new MockRedis(), snapshotStore: snapshots });
    await warm.getFixtures();
    await waitFor(() => snapshots.rows.has("/fixtures/"));

    // Cold restart during an outage: empty memory and Redis, only L3 survives
    globalThis.fetch = async () => {
      upstreamCalls++;
      return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
    };
    const client = chaosClient({
      redis: new MockRedis(),
      snapshotStore: snapshots,
      circuitBreakerOptions: { failureThreshold: 3, cooldownPeriodMs: 60_000 },
    });

    const first = await client.getWithMetadata<typeof FIXTURES>("/fixtures/", 60);
    assert.equal(first.isStale, true);
    assert.equal(first.staleSource, "postgres");
    assert.deepEqual(first.data, FIXTURES);

    for (let i = 0; i < 2; i++) {
      const next = await client.getWithMetadata<typeof FIXTURES>("/fixtures/", 60);
      assert.equal(next.staleSource, "memory", "L3 hit backfills the in-memory stale copy");
    }
    assert.equal(client.circuitBreaker.getState(), CircuitState.OPEN, "3 failures reach the threshold");
    assert.equal(upstreamCalls, 3);

    // OPEN: answered from the fallback without touching the upstream
    for (let i = 0; i < 5; i++) {
      assert.deepEqual((await client.getWithMetadata("/fixtures/", 60)).data, FIXTURES);
    }
    assert.equal(upstreamCalls, 3, "no upstream traffic while the circuit is OPEN");

    const telemetry = client.getTelemetry();
    assert.equal(telemetry.cache.staleServed.postgres, 1);
    assert.equal(telemetry.cache.staleServed.memory, 7);
    assert.equal(telemetry.circuit.totals.shortCircuited, 5);
    assert.equal(telemetry.circuit.state, CircuitState.OPEN);
    assert.equal(client.isDegraded(), true);
  });

  it("keeps the Redis stale copy through clearCache() so a forced sync during an outage still succeeds", async () => {
    const redis = new MockRedis();
    globalThis.fetch = async () => json(FIXTURES);
    await chaosClient({ redis, snapshotStore: null }).getFixtures();

    globalThis.fetch = async () => new Response("down", { status: 502 });
    const restarted = chaosClient({ redis, snapshotStore: null });
    // executeFplSyncTask() clears the cache before every queued sync
    await restarted.clearCache();
    assert.equal(await redis.get("fpl:cache:/fixtures/"), null, "fresh tier is cleared");

    const result = await restarted.getWithMetadata("/fixtures/");
    assert.equal(result.isStale, true);
    assert.equal(result.staleSource, "redis");
    assert.deepEqual(result.data, FIXTURES);
  });

  it("treats Cloudflare challenge pages as upstream failures", async () => {
    globalThis.fetch = async () => {
      upstreamCalls++;
      return new Response("<html>Just a moment...</html>", {
        status: 403,
        headers: { "Content-Type": "text/html", "cf-mitigated": "challenge" },
      });
    };
    const client = chaosClient({
      redis: null,
      snapshotStore: null,
      circuitBreakerOptions: { failureThreshold: 2, cooldownPeriodMs: 60_000 },
    });

    await assert.rejects(() => client.getFixtures());
    await assert.rejects(() => client.getFixtures());
    assert.equal(client.circuitBreaker.getState(), CircuitState.OPEN);
    await assert.rejects(() => client.getFixtures(), CircuitBreakerOpenError);
    assert.equal(upstreamCalls, 2);
  });

  it("serves stale data with X-Data-Stale through the API, and 503 (not 500) when nothing is cached", async () => {
    const snapshots = new MemorySnapshotStore();
    await snapshots.save("/fixtures/", FIXTURES);
    globalThis.fetch = async () => new Response("down", { status: 503 });
    const client = chaosClient({
      redis: null,
      snapshotStore: snapshots,
      circuitBreakerOptions: { failureThreshold: 1, cooldownPeriodMs: 60_000 },
    });

    const app = express();
    app.use(createFplDataFreshness(client));
    app.get("/fixtures", async (_req, res, next) => {
      try {
        res.json({ success: true, data: await client.getFixtures() });
      } catch (error) {
        next(error);
      }
    });
    app.get("/live", async (_req, res, next) => {
      try {
        res.json({ success: true, data: await client.getGameweekLive(9) });
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const fixtures = await originalFetch(`${base}/fixtures`);
      assert.equal(fixtures.status, 200);
      assert.deepEqual((await fixtures.json()).data, FIXTURES);

      const again = await originalFetch(`${base}/fixtures`);
      assert.equal(again.headers.get("x-data-stale"), "true", "circuit is OPEN after the first failure");

      const live = await originalFetch(`${base}/live`);
      assert.equal(live.status, 503, "no fallback at any tier: Service Unavailable, not a 500");
      assert.equal(live.headers.get("x-data-stale"), "true");
    } finally {
      server.close();
    }
  });
});

describe("Circuit breaker HALF_OPEN health probing (#275)", () => {
  it("probes automatically with jittered backoff and closes when the upstream recovers", async () => {
    let probes = 0;
    const transitions: string[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriodMs: 20,
      maxCooldownMs: 200,
      // Upstream still down for the first probe, recovered for the second
      probe: async () => {
        probes++;
        if (probes === 1) throw new Error("503");
      },
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });

    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error("503"))));
    assert.equal(breaker.getState(), CircuitState.OPEN);

    await waitFor(() => transitions.includes("HALF_OPEN->OPEN"));
    const cooldown = breaker.getStats().currentCooldownMs;
    assert.ok(cooldown >= 20 && cooldown <= 200, `jittered cooldown ${cooldown} within [base, max]`);

    // No traffic at all: the scheduled probe alone closes the circuit
    await waitFor(() => breaker.getState() === CircuitState.CLOSED);
    assert.equal(probes, 2);
    assert.deepEqual(transitions, [
      "CLOSED->OPEN",
      "OPEN->HALF_OPEN",
      "HALF_OPEN->OPEN",
      "OPEN->HALF_OPEN",
      "HALF_OPEN->CLOSED",
    ]);
    assert.equal(breaker.getStats().currentCooldownMs, 20, "cooldown resets once CLOSED");
  });

  it("admits a single probe while HALF_OPEN and short-circuits concurrent calls", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownPeriodMs: 10 });
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error("503"))));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(breaker.getState(), CircuitState.HALF_OPEN);

    let release!: () => void;
    const probe = breaker.execute(() => new Promise<string>((resolve) => (release = () => resolve("ok"))));
    let concurrentCalled = false;
    await assert.rejects(
      () => breaker.execute(async () => (concurrentCalled = true)),
      CircuitBreakerOpenError
    );
    assert.equal(concurrentCalled, false);

    release();
    assert.equal(await probe, "ok");
    assert.equal(breaker.getState(), CircuitState.CLOSED);
  });

  it("reports a 503 status for an open circuit", () => {
    assert.equal(new CircuitBreakerOpenError("open", 1000).statusCode, 503);
  });
});

describe("X-Data-Stale middleware (#275)", () => {
  const run = (degraded: boolean) => {
    const headers: Record<string, string> = {};
    let nextCalled = false;
    createFplDataFreshness({ isDegraded: () => degraded })(
      {} as express.Request,
      { setHeader: (name: string, value: string) => (headers[name] = value) } as unknown as express.Response,
      () => (nextCalled = true)
    );
    return { headers, nextCalled };
  };

  it("flags responses only while the FPL circuit is not CLOSED", () => {
    assert.deepEqual(run(true), { headers: { "X-Data-Stale": "true" }, nextCalled: true });
    assert.deepEqual(run(false), { headers: {}, nextCalled: true });
  });
});
