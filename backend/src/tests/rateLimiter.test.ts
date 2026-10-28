import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Redis } from "ioredis";
import { getRateLimitTier } from "../config/rateLimit.js";
import { UserRole } from "../types/index.js";
import {
  authRateLimiter,
  apiRateLimiter,
  createSlidingWindowRateLimiter,
  MemorySlidingWindowStore,
  RedisSlidingWindowStore,
import { Server } from "node:http";
import {
  authRateLimiter,
  financialRateLimiter,
  syncRateLimiter,
  squadRateLimiter,
  apiRateLimiter,
  authenticatedRateLimiter,
} from "../middleware/rateLimiter.js";

async function makeRequest(server: Server, path: string, headers: Record<string, string> = {}) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server not running");
  const url = `http://127.0.0.1:${address.port}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body, headers: res.headers };
}

describe("Rate-Limiting & Abuse Prevention Middleware Suite", () => {
  it("should block auth requests exceeding limit with 429 Too Many Requests and Retry-After header", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/v1/auth", authRateLimiter, (_req, res) => {
      res.status(200).json({ success: true, message: "OK" });
    });

    const server = app.listen(0);
    try {
      // Send 5 successful requests
      for (let i = 0; i < 5; i++) {
        const res = await makeRequest(server, "/api/v1/auth/login", { "X-Forwarded-For": "203.0.113.195" });
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
      }

      // 6th request must be blocked by rate limit
      const blockedRes = await makeRequest(server, "/api/v1/auth/login", { "X-Forwarded-For": "203.0.113.195" });
      assert.equal(blockedRes.status, 429);
      assert.equal(blockedRes.body.success, false);
      assert.ok(blockedRes.body.message.includes("Too many authentication requests"));
    } finally {
      server.close();
    }
  });

  it("should differentiate client IPs using X-Forwarded-For header", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/v1/auth", authRateLimiter, (_req, res) => {
      res.status(200).json({ success: true, message: "OK" });
    });

    const server = app.listen(0);
    try {
      // Exhaust quota for IP A
      for (let i = 0; i < 5; i++) {
        await makeRequest(server, "/api/v1/auth/login", { "X-Forwarded-For": "198.51.100.10" });
      }

      const blockedResA = await makeRequest(server, "/api/v1/auth/login", { "X-Forwarded-For": "198.51.100.10" });
      assert.equal(blockedResA.status, 429);

      // Unrelated IP B should still be accepted
      const allowedResB = await makeRequest(server, "/api/v1/auth/login", { "X-Forwarded-For": "198.51.100.20" });
      assert.equal(allowedResB.status, 200);
      assert.equal(allowedResB.body.success, true);
    } finally {
      server.close();
    }
  });

  it("should enforce financial rate limiting on payment/settlement routes", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/v1/financial", financialRateLimiter, (_req, res) => {
      res.status(200).json({ success: true, message: "Transaction processed" });
    });

    const server = app.listen(0);
    try {
      for (let i = 0; i < 20; i++) {
        const res = await makeRequest(server, "/api/v1/financial/submit", { "X-Forwarded-For": "192.0.2.55" });
        assert.equal(res.status, 200);
      }

      const blockedRes = await makeRequest(server, "/api/v1/financial/submit", { "X-Forwarded-For": "192.0.2.55" });
      assert.equal(blockedRes.status, 429);
      assert.equal(blockedRes.body.success, false);
      assert.ok(blockedRes.body.message.includes("financial requests"));
    } finally {
      server.close();
    }
  });

  it("should enforce sync rate limiting on admin ingestion endpoints", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/v1/sync", syncRateLimiter, (_req, res) => {
      res.status(200).json({ success: true, message: "Sync triggered" });
    });

    const server = app.listen(0);
    try {
      for (let i = 0; i < 10; i++) {
        const res = await makeRequest(server, "/api/v1/sync/bootstrap", { "X-Forwarded-For": "192.0.2.77" });
        assert.equal(res.status, 200);
      }

      const blockedRes = await makeRequest(server, "/api/v1/sync/bootstrap", { "X-Forwarded-For": "192.0.2.77" });
      assert.equal(blockedRes.status, 429);
      assert.equal(blockedRes.body.success, false);
      assert.ok(blockedRes.body.message.includes("sync requests"));
    } finally {
      server.close();
    }
  });

  it("should enforce squad rate limiting on team creation and modification", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/v1/squads", squadRateLimiter, (_req, res) => {
      res.status(200).json({ success: true, message: "Squad saved" });
    });

    const server = app.listen(0);
    try {
      for (let i = 0; i < 30; i++) {
        const res = await makeRequest(server, "/api/v1/squads", { "X-Forwarded-For": "192.0.2.99" });
        assert.equal(res.status, 200);
      }

      const blockedRes = await makeRequest(server, "/api/v1/squads", { "X-Forwarded-For": "192.0.2.99" });
      assert.equal(blockedRes.status, 429);
      assert.equal(blockedRes.body.success, false);
      assert.ok(blockedRes.body.message.includes("squad modification requests"));
    } finally {
      server.close();
    }
  });

  it("should enforce general api rate limiter on public routes", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api", apiRateLimiter, (_req, res) => {
      res.status(200).json({ success: true, message: "General API" });
    });

    const server = app.listen(0);
    try {
      for (let i = 0; i < 100; i++) {
        const res = await makeRequest(server, "/api/public", { "X-Forwarded-For": "192.0.2.101" });
        assert.equal(res.status, 200);
      }

      const blockedRes = await makeRequest(server, "/api/public", { "X-Forwarded-For": "192.0.2.101" });
      assert.equal(blockedRes.status, 429);
      assert.equal(blockedRes.body.success, false);
      assert.ok(blockedRes.body.message.includes("API requests"));
    } finally {
      server.close();
    }
  });

  it("should apply a separate limit to authenticated endpoints", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.get("/api/private", authenticatedRateLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      let lastStatus = 200;
      for (let i = 0; i < 61; i++) {
        const res = await fetch(`${baseUrl}/api/private`, {
          headers: { "X-Forwarded-For": "203.0.113.196" },
        });
        lastStatus = res.status;
      }

      assert.strictEqual(lastStatus, 429);
    } finally {
      server.close();
    }
  });

  it("expires requests at the sliding-window boundary and reports retry timing", async () => {
    let now = 1_000;
    const store = new MemorySlidingWindowStore(() => now);
    const bucket = [{ key: "one-client", limit: 2 }];

    assert.equal((await store.consume(bucket, 1_000)).allowed, true);
    now = 1_500;
    assert.equal((await store.consume(bucket, 1_000)).allowed, true);
    now = 1_999;
    const blocked = await store.consume(bucket, 1_000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.resetAfterMs, 1);

    now = 2_000;
    assert.equal((await store.consume(bucket, 1_000)).allowed, true);
  });

  it("enforces concurrent requests atomically in the in-memory fallback", async () => {
    const store = new MemorySlidingWindowStore(() => 10_000);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        store.consume([{ key: "burst", limit: 10 }], 60_000)
      )
    );
    assert.equal(results.filter((result) => result.allowed).length, 10);
  });

  it("uses one Redis Lua evaluation for all identity buckets in a request", async () => {
    const calls: unknown[][] = [];
    const redis = {
      eval: async (...args: unknown[]) => {
        calls.push(args);
        return [1, 4, 30_000, 5];
      },
    };
    const store = new RedisSlidingWindowStore(redis as unknown as Redis);
    const result = await store.consume(
      [
        { key: "user-key", limit: 5 },
        { key: "ip-key", limit: 10 },
      ],
      60_000
    );

    assert.equal(calls.length, 1);
    assert.equal(result.allowed, true);
    assert.equal(result.limit, 5);
    assert.equal(result.remaining, 4);
    assert.equal(result.resetAfterMs, 30_000);
    assert.deepEqual(calls[0].slice(1, 3), [2, "user-key"]);
  });

  it("returns 429 with the configured headers when a route group limit is exceeded", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.get(
      "/api/custom",
      createSlidingWindowRateLimiter({
        store: new MemorySlidingWindowStore(),
        routeGroups: [
          {
            name: "custom",
            prefixes: ["/api/custom"],
            tiers: {
              anonymous: { limit: 1, windowMs: 60_000 },
              authenticated: { limit: 5, windowMs: 60_000 },
              webhook: { limit: 10, windowMs: 60_000 },
            },
          },
        ],
      }),
      (_req, res) => res.status(200).end()
    );
    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.24" },
      });
      const blocked = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.24" },
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("x-ratelimit-limit"), "1");
      assert.equal(blocked.headers.get("x-ratelimit-remaining"), "0");
      assert.equal(blocked.headers.get("retry-after"), "60");
    } finally {
      server.close();
    }
  });

  it("applies both per-user and shared per-IP limits to authenticated requests", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user");
      if (userId) {
        req.user = {
          id: userId,
          email: `${userId}@example.test`,
          username: userId,
          role: UserRole.USER,
        };
      }
      next();
    });
    app.get(
      "/api/custom",
      createSlidingWindowRateLimiter({
        store: new MemorySlidingWindowStore(),
        routeGroups: [
          {
            name: "custom",
            prefixes: ["/api/custom"],
            tiers: {
              anonymous: { limit: 2, windowMs: 60_000 },
              authenticated: { limit: 5, ipLimit: 2, windowMs: 60_000 },
              webhook: { limit: 10, windowMs: 60_000 },
            },
          },
        ],
      }),
      (_req, res) => res.status(200).end()
    );
    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const first = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.25", "X-Test-User": "user-one" },
      });
      const second = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.25", "X-Test-User": "user-two" },
      });
      const third = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.25", "X-Test-User": "user-two" },
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(third.status, 429);
    } finally {
      server.close();
    }
  });

  it("assigns webhook thresholds only to verified callers on webhook routes", () => {
    assert.equal(getRateLimitTier("/api/webhooks/stellar", false), "anonymous");
    assert.equal(getRateLimitTier("/api/webhooks/stellar", false, true), "webhook");
    assert.equal(getRateLimitTier("/api/players", false, true), "anonymous");
    assert.equal(getRateLimitTier("/api/players", true), "authenticated");
  });
});
