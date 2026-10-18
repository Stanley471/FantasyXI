import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
} from "../services/fpl/circuitBreaker.js";
import { FplClient } from "../services/fpl/fplClient.js";
import { MemoryFplSnapshotStore, PrismaFplSnapshotStore } from "../services/fpl/fplSnapshotStore.js";
import { createFplDataFreshness } from "../middleware/fplDataFreshness.js";
import { createFplTelemetryHandler } from "../controllers/fplTelemetry.controller.js";
import { IRedisCacheClient } from "../config/redis.js";

/**
 * Chaos tests for the FPL client's resilience layer (issue #275): the
 * upstream is replaced with a fetch that fails continuously (503s, timeouts)
 * and the tests verify the breaker opens, fallback tiers keep serving data,
 * and the circuit recovers once the upstream does.
 */

class MockRedis implements IRedisCacheClient {
  public store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
    return "OK";
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async keys(pattern: string) {
    const prefix = pattern.replaceAll("*", "");
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

const ENDPOINT = "/bootstrap-static/";
const CACHE_KEY = `fpl:cache:${ENDPOINT}`;
const PLAYERS = { elements: [{ id: 1, web_name: "Saka" }] };

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

function upstreamOk(body: unknown = PLAYERS) {
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function upstream503() {
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
  };
}

function upstreamTimeout() {
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Drops the fresh L1/L2 entries so the next read must go upstream. */
async function expireFreshCache(client: FplClient, redis?: MockRedis) {
  (client as any).cache.clear();
  await redis?.del(CACHE_KEY);
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return new FplClient({
    redis: null,
    snapshotStore: null,
    retries: 1,
    circuitBreakerOptions: { failureThreshold: 3, cooldownPeriodMs: 40, maxCooldownMs: 400 },
    ...overrides,
  });
}

describe("FPL chaos resilience (#275)", () => {
  beforeEach(() => {
    fetchCalls = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("continuous 503s open the circuit at the threshold and keep serving cached data", async () => {
    const client = makeClient();
    upstreamOk();
    await client.get(ENDPOINT);
    await expireFreshCache(client);
    fetchCalls = 0;

    upstream503();
    for (let i = 0; i < 10; i++) {
      const result = await client.getWithMetadata<typeof PLAYERS>(ENDPOINT);
      assert.equal(result.isStale, true, `request ${i} must be served stale, not fail`);
      assert.deepEqual(result.data, PLAYERS);
    }

    assert.equal(client.circuitBreaker.getState(), CircuitState.OPEN);
    // Only the requests before the trip reached the upstream; the rest short-circuited
    assert.equal(fetchCalls, 3);
    assert.equal(client.circuitBreaker.getStats().totalShortCircuited, 7);
  });

  it("upstream timeouts count as failures and open the circuit", async () => {
    const client = makeClient();
    upstreamOk();
    await client.get(ENDPOINT);
    await expireFreshCache(client);

    upstreamTimeout();
    for (let i = 0; i < 3; i++) {
      const result = await client.getWithMetadata(ENDPOINT);
      assert.equal(result.isStale, true);
    }
    assert.equal(client.circuitBreaker.getState(), CircuitState.OPEN);
  });

  it("recovers through HALF_OPEN to CLOSED once the upstream is healthy", async () => {
    const client = makeClient();
    upstreamOk();
    await client.get(ENDPOINT);
    await expireFreshCache(client);

    upstream503();
    for (let i = 0; i < 3; i++) await client.get(ENDPOINT);
    assert.equal(client.circuitBreaker.getState(), CircuitState.OPEN);

    await sleep(60);
    assert.equal(client.circuitBreaker.getState(), CircuitState.HALF_OPEN);

    const fresh = { elements: [{ id: 1, web_name: "Saka" }, { id: 2, web_name: "Rice" }] };
    upstreamOk(fresh);
    fetchCalls = 0;
    const result = await client.getWithMetadata<typeof fresh>(ENDPOINT);
    assert.equal(result.isStale, false);
    assert.equal(result.source, "upstream");
    assert.deepEqual(result.data, fresh);
    assert.equal(fetchCalls, 1);
    assert.equal(client.circuitBreaker.getState(), CircuitState.CLOSED);
  });

  it("lets exactly one probe through while HALF_OPEN; concurrent callers get cached data", async () => {
    const client = makeClient();
    upstreamOk();
    await client.get(ENDPOINT);
    await expireFreshCache(client);
    upstream503();
    for (let i = 0; i < 3; i++) await client.get(ENDPOINT);
    await sleep(60);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      await gate;
      return new Response(JSON.stringify(PLAYERS), { status: 200 });
    };

    const probe = client.getWithMetadata(ENDPOINT);
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => client.getWithMetadata(ENDPOINT))
    );
    for (const result of concurrent) assert.equal(result.isStale, true);
    assert.equal(fetchCalls, 1, "only the probe may reach a recovering upstream");

    release();
    assert.equal((await probe).isStale, false);
    assert.equal(client.circuitBreaker.getState(), CircuitState.CLOSED);
  });

  it("a failed probe re-opens with a jittered cooldown that grows within bounds", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownPeriodMs: 20,
      maxCooldownMs: 200,
    });
    await assert.rejects(() => breaker.execute(() => Promise.reject(new Error("503"))));
    assert.equal(breaker.getStats().currentCooldownMs, 20);

    const cooldowns: number[] = [];
    for (let i = 0; i < 4; i++) {
      await sleep(breaker.getStats().currentCooldownMs + 5);
      assert.equal(breaker.getState(), CircuitState.HALF_OPEN);
      await assert.rejects(() => breaker.execute(() => Promise.reject(new Error("still down"))));
      assert.equal(breaker.getState(), CircuitState.OPEN);
      cooldowns.push(breaker.getStats().currentCooldownMs);
    }
    for (const cooldown of cooldowns) {
      assert.ok(cooldown >= 20 && cooldown <= 200, `cooldown ${cooldown} out of bounds`);
    }
    assert.equal(breaker.getStats().timesOpened, 5);
  });

  it("cooldown jitter ratio spreads the first probe time", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const breaker = new CircuitBreaker({ cooldownPeriodMs: 1000, cooldownJitterRatio: 0.5 });
      breaker.trip();
      const cooldown = breaker.getStats().currentCooldownMs;
      assert.ok(cooldown >= 1000 && cooldown <= 1500);
      seen.add(cooldown);
    }
    assert.ok(seen.size > 1, "jitter must vary the cooldown");
  });

  it("L2: a fresh process falls back to the shared Redis last-good copy", async () => {
    const redis = new MockRedis();
    const first = makeClient({ redis });
    upstreamOk();
    await first.get(ENDPOINT, 60);
    await flush();
    assert.ok(redis.store.has(`${CACHE_KEY}:stale`), "last-good copy must be written to Redis");

    // Another instance with a cold memory cache, after the fresh key expired
    await redis.del(CACHE_KEY);
    const second = makeClient({ redis });
    upstream503();
    const result = await second.getWithMetadata<typeof PLAYERS>(ENDPOINT);
    assert.equal(result.isStale, true);
    assert.equal(result.source, "stale-redis");
    assert.deepEqual(result.data, PLAYERS);
    assert.ok(result.staleSince instanceof Date);
  });

  it("L3: with memory and Redis cold, the PostgreSQL snapshot is served", async () => {
    const snapshotStore = new MemoryFplSnapshotStore();
    const capturedAt = new Date("2026-10-01T12:00:00Z");
    snapshotStore.snapshots.set(CACHE_KEY, { data: PLAYERS, capturedAt });

    const client = makeClient({ snapshotStore });
    client.circuitBreaker.trip();
    const result = await client.getWithMetadata<typeof PLAYERS>(ENDPOINT);
    assert.equal(result.isStale, true);
    assert.equal(result.source, "stale-snapshot");
    assert.deepEqual(result.data, PLAYERS);
    assert.deepEqual(result.staleSince, capturedAt);
    assert.equal(fetchCalls, 0);
  });

  it("L3: snapshot load failures do not mask the original upstream error", async () => {
    const client = makeClient({
      snapshotStore: {
        load: async () => {
          throw new Error("db down");
        },
        save: async () => {},
      },
    });
    client.circuitBreaker.trip();
    await assert.rejects(() => client.get(ENDPOINT), CircuitBreakerOpenError);
  });

  it("Prisma snapshot store upserts by cache key and maps rows back", async () => {
    const rows = new Map<string, { payload: unknown; capturedAt: Date }>();
    const store = new PrismaFplSnapshotStore({
      findUnique: async ({ where }) => rows.get(where.cacheKey) ?? null,
      upsert: async ({ where, update, create }) => {
        rows.set(where.cacheKey, rows.has(where.cacheKey) ? update : { payload: create.payload, capturedAt: create.capturedAt });
        return null;
      },
    });
    assert.equal(await store.load(CACHE_KEY), null);
    await store.save(CACHE_KEY, PLAYERS);
    await store.save(CACHE_KEY, { elements: [] });
    const loaded = await store.load<{ elements: unknown[] }>(CACHE_KEY);
    assert.deepEqual(loaded?.data, { elements: [] });
    assert.ok(loaded?.capturedAt instanceof Date);
  });

  it("snapshots are written after upstream success and throttled per endpoint", async () => {
    let saves = 0;
    const store = new MemoryFplSnapshotStore();
    const counting = {
      load: store.load.bind(store),
      save: async (key: string, data: unknown) => {
        saves++;
        await store.save(key, data);
      },
    };
    const client = makeClient({ snapshotStore: counting, snapshotMinIntervalMs: 60_000 });
    upstreamOk();
    await client.get(ENDPOINT);
    await expireFreshCache(client);
    await client.get(ENDPOINT);
    await flush();
    assert.equal(saves, 1);
    assert.deepEqual((await store.load(CACHE_KEY))?.data, PLAYERS);
  });

  it("X-Data-Stale headers are set only while the upstream is degraded", async () => {
    const client = makeClient({ degradedWindowMs: 50 });
    const middleware = createFplDataFreshness(client);
    const run = () => {
      const headers = new Map<string, string>();
      let nextCalled = false;
      middleware(
        {} as any,
        { setHeader: (k: string, v: string) => headers.set(k, v) } as any,
        () => {
          nextCalled = true;
        }
      );
      assert.equal(nextCalled, true);
      return headers;
    };

    assert.equal(run().size, 0, "healthy upstream must not mark responses stale");

    upstreamOk();
    await client.get(ENDPOINT);
    await expireFreshCache(client);
    upstream503();
    for (let i = 0; i < 3; i++) await client.get(ENDPOINT);

    const open = run();
    assert.equal(open.get("X-Data-Stale"), "true");
    assert.equal(open.get("X-Data-Stale-Reason"), "circuit-open");
    assert.ok(!Number.isNaN(Date.parse(open.get("X-Data-Stale-Since") ?? "")));

    client.circuitBreaker.reset();
    const recent = run();
    assert.equal(recent.get("X-Data-Stale-Reason"), "stale-memory", "recently served stale data");

    await sleep(60);
    assert.equal(run().size, 0, "headers clear after the degraded window");
  });

  it("admin telemetry reports breaker state and cache-tier counters", async () => {
    const client = makeClient();
    upstreamOk();
    await client.get(ENDPOINT);
    await client.get(ENDPOINT);
    await expireFreshCache(client);
    upstream503();
    for (let i = 0; i < 4; i++) await client.get(ENDPOINT);

    let body: any;
    createFplTelemetryHandler(client)({} as any, { json: (b: unknown) => (body = b) } as any);
    assert.equal(body.success, true);
    assert.equal(body.data.circuitBreaker.state, CircuitState.OPEN);
    assert.equal(body.data.circuitBreaker.timesOpened, 1);
    assert.equal(body.data.counters.upstreamFetches, 1);
    assert.equal(body.data.counters.memoryHits, 1);
    assert.equal(body.data.counters.staleMemory, 4);
    assert.equal(body.data.freshness.stale, true);
    assert.equal(body.data.snapshotFallbackEnabled, false);
  });
});
