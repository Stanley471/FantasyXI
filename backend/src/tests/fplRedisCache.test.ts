import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FplClient, FPL_CACHE_TTL } from "../services/fpl/fplClient.js";
import { IRedisCacheClient } from "../config/redis.js";

/**
 * In-memory Mock Redis Client that simulates TTL expiration.
 */
class MockRedisClient implements IRedisCacheClient {
  public store = new Map<string, { value: string; expiresAt: number }>();
  public setCalls: Array<{ key: string; value: string; mode?: string; ttl?: number }> = [];
  public getCalls: string[] = [];
  public delCalls: string[][] = [];

  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, mode?: any, duration?: any): Promise<string> {
    this.setCalls.push({ key, value, mode, ttl: duration });
    const ttlSeconds = mode === "EX" && typeof duration === "number" ? duration : 600;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.delCalls.push(keys);
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace("*", "");
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }

  // Helper for test to manually expire a key
  expireKey(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() - 1000;
    }
  }

  // Helper to advance time for all keys
  advanceTime(seconds: number): void {
    for (const [, entry] of this.store) {
      entry.expiresAt -= seconds * 1000;
    }
  }
}

describe("FPL Redis Caching Layer (#42)", () => {
  let mockRedis: MockRedisClient;
  let originalFetch: typeof globalThis.fetch;
  let fetchCallCount: number;
  let mockResponses: Map<string, any>;

  beforeEach(() => {
    mockRedis = new MockRedisClient();
    fetchCallCount = 0;
    mockResponses = new Map();
    originalFetch = globalThis.fetch;

    // Default mock responses for endpoints
    mockResponses.set("https://fantasy.premierleague.com/api/bootstrap-static/", {
      events: [{ id: 1, name: "Gameweek 1", is_current: true, finished: false, deadline_time: "2026-08-15T10:00:00Z" }],
      teams: [{ id: 1, name: "Arsenal", short_name: "ARS" }],
      elements: [{ id: 101, web_name: "Saka", now_cost: 100, total_points: 50, team: 1, element_type: 3 }],
    });

    mockResponses.set("https://fantasy.premierleague.com/api/fixtures/", [
      { id: 1, event: 1, team_h: 1, team_a: 2, kickoff_time: "2026-08-15T11:30:00Z", started: false, finished: false, team_h_score: null, team_a_score: null, minutes: 0 },
    ]);

    mockResponses.set("https://fantasy.premierleague.com/api/event/1/live/", {
      elements: [
        { id: 101, stats: { minutes: 90, goals_scored: 1, assists: 1, clean_sheets: 0, yellow_cards: 0, red_cards: 0, saves: 0, bonus: 3, total_points: 12 } },
      ],
    });

    globalThis.fetch = async (urlInput: RequestInfo | URL) => {
      fetchCallCount++;
      const urlString = urlInput.toString();
      const data = mockResponses.get(urlString);

      if (!data) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404, statusText: "Not Found" });
      }

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("populates Redis cache on initial fetch with a 24-hour TTL for static player data", async () => {
    const client = new FplClient({ redis: mockRedis });

    const data = await client.getBootstrapStatic();

    assert.equal(fetchCallCount, 1, "External API should be called once on initial fetch");
    assert.equal(data.teams[0].name, "Arsenal");

    // Check Redis was populated
    const cachedEntry = await mockRedis.get("fpl:cache:/bootstrap-static/");
    assert.ok(cachedEntry, "Redis should contain the cached response");
    const parsed = JSON.parse(cachedEntry);
    assert.equal(parsed.teams[0].name, "Arsenal");

    // Verify TTL was set to 24 hours (86400 seconds) per issue #139
    const setCall = mockRedis.setCalls.find((c) => c.key === "fpl:cache:/bootstrap-static/");
    assert.ok(setCall, "Redis set should have been called");
    assert.equal(setCall.mode, "EX");
    assert.equal(setCall.ttl, 86400);
    assert.equal(setCall.ttl, FPL_CACHE_TTL.BOOTSTRAP_STATIC_SECONDS);
  });

  it("serves subsequent requests within TTL from Redis cache without hitting external API", async () => {
    const client = new FplClient({ redis: mockRedis });

    // First fetch
    await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 1);

    // Second fetch within TTL window
    const data2 = await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 1, "External API should NOT be hit on subsequent request within TTL");
    assert.equal(data2.teams[0].name, "Arsenal");

    // Third fetch
    const data3 = await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 1, "External API should still NOT be hit");
    assert.equal(data3.elements[0].web_name, "Saka");
  });

  it("expires cache after TTL and refetches from external API", async () => {
    const client = new FplClient({ redis: mockRedis });

    // 1. Initial fetch
    await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 1);

    // 2. Advance time past the 24-hour TTL and clear client in-memory cache to test Redis expiry
    mockRedis.advanceTime(86401);
    await client.clearCache(); // Clears memory cache, but redis keys will be tested for expiration

    // In mock redis, key has now expired
    const expiredData = await mockRedis.get("fpl:cache:/bootstrap-static/");
    assert.equal(expiredData, null, "Mock Redis key should report expired/null");

    // 3. Subsequent fetch should hit the external API again
    await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 2, "External API should be called again after TTL expiration");
  });

  it("caches fixtures with a 24-hour TTL and serves from cache", async () => {
    const client = new FplClient({ redis: mockRedis });

    const fixtures1 = await client.getFixtures();
    assert.equal(fetchCallCount, 1);
    assert.equal(fixtures1.length, 1);

    const fixtures2 = await client.getFixtures();
    assert.equal(fetchCallCount, 1, "Fixtures should be served from cache");
    assert.equal(fixtures2[0].id, 1);

    const setCall = mockRedis.setCalls.find((c) => c.key === "fpl:cache:/fixtures/");
    assert.ok(setCall);
    assert.equal(setCall.ttl, FPL_CACHE_TTL.FIXTURES_SECONDS);
  });

  it("caches gameweek live scores with a 60-second TTL per issue #139", async () => {
    const client = new FplClient({ redis: mockRedis });

    const live1 = await client.getGameweekLive(1);
    assert.equal(fetchCallCount, 1);
    assert.equal(live1.elements[0].stats.goals_scored, 1);

    const live2 = await client.getGameweekLive(1);
    assert.equal(fetchCallCount, 1, "Gameweek live should be served from cache");
    assert.equal(live2.elements[0].stats.total_points, 12);

    const setCall = mockRedis.setCalls.find((c) => c.key === "fpl:cache:/event/1/live/");
    assert.ok(setCall);
    assert.equal(setCall.ttl, 60);
    assert.equal(setCall.ttl, FPL_CACHE_TTL.GAMEWEEK_LIVE_SECONDS);
  });

  it("expires live scores after 60 seconds and refetches", async () => {
    const client = new FplClient({ redis: mockRedis });

    await client.getGameweekLive(1);
    assert.equal(fetchCallCount, 1);

    mockRedis.advanceTime(61);
    await client.clearCache();

    assert.equal(await mockRedis.get("fpl:cache:/event/1/live/"), null);

    await client.getGameweekLive(1);
    assert.equal(fetchCallCount, 2, "Live scores should refetch once the 60s TTL has elapsed");
  });

  it("clearCache() deletes Redis keys and in-memory cache", async () => {
    const client = new FplClient({ redis: mockRedis });

    await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 1);
    assert.ok(await mockRedis.get("fpl:cache:/bootstrap-static/"));

    // Explicit clearCache()
    await client.clearCache();

    // Redis key is deleted
    assert.equal(await mockRedis.get("fpl:cache:/bootstrap-static/"), null);

    // Next call fetches fresh upstream data
    await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 2, "External API should be fetched after cache was cleared");
  });

  it("gracefully falls back when Redis throws connection or read/write errors", async () => {
    const faultyRedis: IRedisCacheClient = {
      async get() {
        throw new Error("Redis connection ECONNREFUSED");
      },
      async set() {
        throw new Error("Redis connection ECONNREFUSED");
      },
      async del() {
        throw new Error("Redis connection ECONNREFUSED");
      },
      async keys() {
        throw new Error("Redis connection ECONNREFUSED");
      },
    };

    const client = new FplClient({ redis: faultyRedis });

    // Should not throw, should fetch from API and cache in local memory fallback
    const data1 = await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 1);
    assert.equal(data1.teams[0].name, "Arsenal");

    // Second call hits in-memory fallback cache
    const data2 = await client.getBootstrapStatic();
    assert.equal(fetchCallCount, 1, "Should use in-memory fallback cache even when Redis fails");
    assert.equal(data2.teams[0].name, "Arsenal");
  });
});
