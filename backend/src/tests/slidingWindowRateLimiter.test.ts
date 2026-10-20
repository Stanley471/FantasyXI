import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Server } from "node:http";
import { signAccessToken } from "../config/jwt.js";
import {
  SLIDING_WINDOW_LUA_SCRIPT,
  createSlidingWindowRateLimiter,
  ISlidingWindowRedisClient,
  loadRateLimitGatewayConfig,
  resolveRouteGroup,
} from "../middleware/rateLimiter.js";

/**
 * Deterministic Redis Sorted-Set simulator that executes the exact semantics of
 * `SLIDING_WINDOW_LUA_SCRIPT` atomically in-process for testing and benchmarking.
 */
class SimulatedRedisLuaClient implements ISlidingWindowRedisClient {
  private readonly zsets = new Map<string, Array<{ score: number; member: string }>>();
  public evalCallCount = 0;
  public lastScript = "";
  public shouldFail = false;

  public async eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    this.evalCallCount += 1;
    this.lastScript = script;

    if (this.shouldFail) {
      throw new Error("ECONNREFUSED: Redis connection unreachable");
    }

    assert.equal(numkeys, 1);
    const key = String(args[0]);
    const now = Number(args[1]);
    const windowMs = Number(args[2]);
    const limit = Number(args[3]);
    const member = String(args[4]);
    const windowStart = now - windowMs;

    const entries = (this.zsets.get(key) || []).filter((e) => e.score > windowStart);
    entries.sort((a, b) => a.score - b.score);

    const count = entries.length;
    if (count < limit) {
      entries.push({ score: now, member });
      entries.sort((a, b) => a.score - b.score);
      this.zsets.set(key, entries);
      const newCount = entries.length;
      const remaining = limit - newCount;
      const oldestScore = entries[0]?.score ?? now;
      const resetMs = oldestScore + windowMs;
      return [1, newCount, remaining, 0, resetMs];
    }

    this.zsets.set(key, entries);
    const oldestScore = entries[0]?.score ?? now;
    const retryAfterMs = Math.max(1, oldestScore + windowMs - now);
    const resetMs = oldestScore + windowMs;
    return [0, count, 0, retryAfterMs, resetMs];
  }
}

async function sendHttpRequest(
  server: Server,
  path: string,
  headers: Record<string, string> = {},
  method = "GET"
) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server not listening");
  }
  const url = `http://127.0.0.1:${address.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, headers: res.headers, body };
}

describe("Dynamic Sliding-Window Rate-Limiting Gateway (#346)", () => {
  it("contains atomic Redis Lua commands for sliding-window sorted set evaluation", () => {
    assert.ok(SLIDING_WINDOW_LUA_SCRIPT.includes("ZREMRANGEBYSCORE"));
    assert.ok(SLIDING_WINDOW_LUA_SCRIPT.includes("ZCARD"));
    assert.ok(SLIDING_WINDOW_LUA_SCRIPT.includes("ZADD"));
    assert.ok(SLIDING_WINDOW_LUA_SCRIPT.includes("PEXPIRE"));
    assert.ok(SLIDING_WINDOW_LUA_SCRIPT.includes("ZRANGE"));
  });

  it("enforces limits and returns HTTP 429 with standard rate-limit headers", async () => {
    const redis = new SimulatedRedisLuaClient();
    const now = 1_700_000_000_000;
    const limiter = createSlidingWindowRateLimiter({
      redisClient: redis,
      clock: () => now,
      config: {
        routeGroups: {
          ...loadRateLimitGatewayConfig().routeGroups,
          players: {
            group: "players",
            windowMs: 60_000,
            limits: { anonymous: 3, authenticated: 10, webhook: 20 },
            message: "Too many player stats requests.",
          },
        },
      },
    });

    const app = express();
    app.set("trust proxy", 1);
    app.get("/api/v1/players", limiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    try {
      for (let i = 0; i < 3; i++) {
        const res = await sendHttpRequest(server, "/api/v1/players", {
          "X-Forwarded-For": "203.0.113.10",
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-ratelimit-limit"), "3");
        assert.equal(res.headers.get("x-ratelimit-remaining"), String(2 - i));
        assert.equal(res.headers.get("x-ratelimit-tier"), "anonymous");
        assert.ok(res.headers.get("x-ratelimit-reset"));
      }

      const blocked = await sendHttpRequest(server, "/api/v1/players", {
        "X-Forwarded-For": "203.0.113.10",
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("x-ratelimit-limit"), "3");
      assert.equal(blocked.headers.get("x-ratelimit-remaining"), "0");
      assert.equal(blocked.headers.get("retry-after"), "60");
      assert.equal(blocked.body.success, false);
      assert.equal(blocked.body.tier, "anonymous");
      assert.equal(blocked.body.routeGroup, "players");
      assert.equal(redis.evalCallCount, 4);
    } finally {
      server.close();
    }
  });

  it("prevents boundary burst attacks across fixed-window edges using true sliding window", async () => {
    const redis = new SimulatedRedisLuaClient();
    let currentTimeMs = 59_000; // 1 second before a 60s fixed window boundary

    const limiter = createSlidingWindowRateLimiter({
      redisClient: redis,
      clock: () => currentTimeMs,
      config: {
        routeGroups: {
          ...loadRateLimitGatewayConfig().routeGroups,
          fixtures: {
            group: "fixtures",
            windowMs: 60_000,
            limits: { anonymous: 4, authenticated: 12, webhook: 24 },
          },
        },
      },
    });

    const app = express();
    app.set("trust proxy", 1);
    app.get("/api/v1/fixtures", limiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    try {
      // Send 2 requests at t = 59,000ms and 2 requests at t = 59,800ms (total 4 in window)
      for (let i = 0; i < 2; i++) {
        const res = await sendHttpRequest(server, "/api/v1/fixtures", {
          "X-Forwarded-For": "198.51.100.44",
        });
        assert.equal(res.status, 200);
      }

      currentTimeMs = 59_800;
      for (let i = 0; i < 2; i++) {
        const res = await sendHttpRequest(server, "/api/v1/fixtures", {
          "X-Forwarded-For": "198.51.100.44",
        });
        assert.equal(res.status, 200);
      }

      // Cross the 60,000ms minute boundary to t = 60,200ms.
      // A fixed-window counter would reset and allow 4 more requests here (8 reqs in 1.2s!).
      // Our sliding-window log looks back [200ms, 60,200ms] and MUST reject the burst!
      currentTimeMs = 60_200;
      const boundaryBurst = await sendHttpRequest(server, "/api/v1/fixtures", {
        "X-Forwarded-For": "198.51.100.44",
      });
      assert.equal(boundaryBurst.status, 429);
      assert.equal(boundaryBurst.headers.get("retry-after"), "59");

      // Advance clock to t = 119,100ms: the two requests from t = 59,000ms have expired,
      // while the two from t = 59,800ms are still inside the [59,100ms, 119,100ms] window.
      currentTimeMs = 119_100;
      const allowedAfterSlide1 = await sendHttpRequest(server, "/api/v1/fixtures", {
        "X-Forwarded-For": "198.51.100.44",
      });
      assert.equal(allowedAfterSlide1.status, 200);
      assert.equal(allowedAfterSlide1.headers.get("x-ratelimit-remaining"), "1");

      const allowedAfterSlide2 = await sendHttpRequest(server, "/api/v1/fixtures", {
        "X-Forwarded-For": "198.51.100.44",
      });
      assert.equal(allowedAfterSlide2.status, 200);
      assert.equal(allowedAfterSlide2.headers.get("x-ratelimit-remaining"), "0");

      // A 3rd request at t = 119,100ms is blocked because the 2 requests at 59,800ms haven't expired yet
      const blockedBeforeFullSlide = await sendHttpRequest(server, "/api/v1/fixtures", {
        "X-Forwarded-For": "198.51.100.44",
      });
      assert.equal(blockedBeforeFullSlide.status, 429);
    } finally {
      server.close();
    }
  });

  it("distinguishes tiered limits for anonymous visitors, authenticated players, and webhook callers", async () => {
    const redis = new SimulatedRedisLuaClient();
    const limiter = createSlidingWindowRateLimiter({
      redisClient: redis,
      config: {
        routeGroups: {
          ...loadRateLimitGatewayConfig().routeGroups,
          leagues: {
            group: "leagues",
            windowMs: 60_000,
            limits: { anonymous: 2, authenticated: 5, webhook: 8 },
          },
        },
      },
    });

    const app = express();
    app.set("trust proxy", 1);
    app.get("/api/v1/leagues", limiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const playerToken = signAccessToken({
      userId: "player-uuid-101",
      email: "player101@fantasyxi.io",
      username: "player101",
    });

    const server = app.listen(0);
    try {
      const sharedIp = "203.0.113.77";

      // 1. Anonymous visitor hits limit at 2 requests
      for (let i = 0; i < 2; i++) {
        const res = await sendHttpRequest(server, "/api/v1/leagues", {
          "X-Forwarded-For": sharedIp,
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-ratelimit-tier"), "anonymous");
      }
      const anonBlocked = await sendHttpRequest(server, "/api/v1/leagues", {
        "X-Forwarded-For": sharedIp,
      });
      assert.equal(anonBlocked.status, 429);

      // 2. Authenticated player on the SAME IP gets their dedicated tier (limit = 5)
      for (let i = 0; i < 5; i++) {
        const res = await sendHttpRequest(server, "/api/v1/leagues", {
          "X-Forwarded-For": sharedIp,
          Authorization: `Bearer ${playerToken}`,
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-ratelimit-tier"), "authenticated");
        assert.equal(res.headers.get("x-ratelimit-limit"), "5");
      }
      const authBlocked = await sendHttpRequest(server, "/api/v1/leagues", {
        "X-Forwarded-For": sharedIp,
        Authorization: `Bearer ${playerToken}`,
      });
      assert.equal(authBlocked.status, 429);

      // 3. Webhook caller on the SAME IP gets webhook tier (limit = 8)
      for (let i = 0; i < 8; i++) {
        const res = await sendHttpRequest(server, "/api/v1/leagues", {
          "X-Forwarded-For": sharedIp,
          "X-Webhook-Id": "wh-endpoint-1",
          "X-Webhook-Signature": "sha256=abcdef123456",
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-ratelimit-tier"), "webhook");
        assert.equal(res.headers.get("x-ratelimit-limit"), "8");
      }
      const webhookBlocked = await sendHttpRequest(server, "/api/v1/leagues", {
        "X-Forwarded-For": sharedIp,
        "X-Webhook-Id": "wh-endpoint-1",
        "X-Webhook-Signature": "sha256=abcdef123456",
      });
      assert.equal(webhookBlocked.status, 429);
    } finally {
      server.close();
    }
  });

  it("supports configurable thresholds per route group and resolves route groups accurately", () => {
    assert.equal(resolveRouteGroup("/api/v1/players/123"), "players");
    assert.equal(resolveRouteGroup("/api/fixtures?gw=5"), "fixtures");
    assert.equal(resolveRouteGroup("/api/v1/leagues/standings"), "leagues");
    assert.equal(resolveRouteGroup("/api/v1/leaderboard"), "leaderboard");
    assert.equal(resolveRouteGroup("/api/v1/ webhooks".replace(" ", "")), "webhooks");
    assert.equal(resolveRouteGroup("/api/v1/unknown-route"), "default");
  });

  it("gracefully degrades to conservative in-memory limit or fail-open when Redis is unreachable", async () => {
    const failingRedis = new SimulatedRedisLuaClient();
    failingRedis.shouldFail = true;

    // 1. Conservative fallback mode (50% of 6 = 3 requests allowed)
    const conservativeLimiter = createSlidingWindowRateLimiter({
      redisClient: failingRedis,
      config: {
        fallbackBehavior: "conservative",
        conservativeFallbackRatio: 0.5,
        routeGroups: {
          ...loadRateLimitGatewayConfig().routeGroups,
          players: {
            group: "players",
            windowMs: 60_000,
            limits: { anonymous: 6, authenticated: 12, webhook: 24 },
          },
        },
      },
    });

    // 2. Fail-open fallback mode
    const failOpenLimiter = createSlidingWindowRateLimiter({
      redisClient: failingRedis,
      config: {
        fallbackBehavior: "fail-open",
        routeGroups: {
          ...loadRateLimitGatewayConfig().routeGroups,
          fixtures: {
            group: "fixtures",
            windowMs: 60_000,
            limits: { anonymous: 2, authenticated: 4, webhook: 8 },
          },
        },
      },
    });

    const app = express();
    app.set("trust proxy", 1);
    app.get("/api/v1/players", conservativeLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });
    app.get("/api/v1/fixtures", failOpenLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    try {
      for (let i = 0; i < 3; i++) {
        const res = await sendHttpRequest(server, "/api/v1/players", {
          "X-Forwarded-For": "192.0.2.88",
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-ratelimit-fallback"), "conservative");
        assert.equal(res.headers.get("x-ratelimit-limit"), "3");
      }

      const conservativeBlocked = await sendHttpRequest(server, "/api/v1/players", {
        "X-Forwarded-For": "192.0.2.88",
      });
      assert.equal(conservativeBlocked.status, 429);

      // Fail-open mode allows all requests even when base limit is 2
      for (let i = 0; i < 5; i++) {
        const res = await sendHttpRequest(server, "/api/v1/fixtures", {
          "X-Forwarded-For": "192.0.2.88",
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-ratelimit-fallback"), "fail-open");
      }
    } finally {
      server.close();
    }
  });

  it("benchmark load test: maintains exact sliding-window accuracy under 100 concurrent burst requests", async () => {
    const redis = new SimulatedRedisLuaClient();
    const configuredMax = 25;
    const totalConcurrentBurst = 100;

    const limiter = createSlidingWindowRateLimiter({
      redisClient: redis,
      config: {
        routeGroups: {
          ...loadRateLimitGatewayConfig().routeGroups,
          leaderboard: {
            group: "leaderboard",
            windowMs: 60_000,
            limits: { anonymous: configuredMax, authenticated: 100, webhook: 200 },
          },
        },
      },
    });

    const app = express();
    app.set("trust proxy", 1);
    app.get("/api/v1/leaderboard", limiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    try {
      const burstPromises = Array.from({ length: totalConcurrentBurst }, () =>
        sendHttpRequest(server, "/api/v1/leaderboard", {
          "X-Forwarded-For": "198.51.100.250",
        })
      );

      const responses = await Promise.all(burstPromises);
      const allowedCount = responses.filter((r) => r.status === 200).length;
      const rejectedCount = responses.filter((r) => r.status === 429).length;

      assert.equal(
        allowedCount,
        configuredMax,
        `Expected exactly ${configuredMax} allowed requests under concurrent burst`
      );
      assert.equal(
        rejectedCount,
        totalConcurrentBurst - configuredMax,
        `Expected ${totalConcurrentBurst - configuredMax} HTTP 429 responses`
      );
    } finally {
      server.close();
    }
  });
});
