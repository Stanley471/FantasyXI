import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { apiRateLimiter } from "../middleware/rateLimiter.js";

/**
 * Integration test for issue #139: every public-facing route sits behind a
 * global rate limiter (mounted the same way as `app.use(apiRateLimiter)` in
 * server.ts) that returns HTTP 429 once an IP exceeds the configured budget.
 */
describe("Global API rate limiting (#139)", () => {
  it("returns HTTP 429 once a single IP exceeds the per-minute request budget", async () => {
    const app = express();
    app.set("trust proxy", true);
    // Mirrors server.ts: the limiter is mounted globally, ahead of all routes.
    app.use(apiRateLimiter);
    app.get("/api/v1/players", (_req, res) => res.status(200).json({ success: true, data: [] }));
    app.get("/api/v1/fixtures", (_req, res) => res.status(200).json({ success: true, data: [] }));

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const clientIp = "203.0.113.42";

    try {
      const limit = parseInt(process.env.API_RATE_LIMIT_MAX || "100", 10);
      let lastStatus = 200;
      let sawRetryAfterHeader = false;
      let body: any = null;

      // Exceed the budget across two different (still public) routes - the
      // limiter keys on client IP, not on route, so both are covered.
      for (let i = 0; i < limit + 5; i++) {
        const res = await fetch(`${i % 2 === 0 ? baseUrl + "/api/v1/players" : baseUrl + "/api/v1/fixtures"}`, {
          headers: { "X-Forwarded-For": clientIp },
        });
        lastStatus = res.status;
        if (res.status === 429) {
          sawRetryAfterHeader = res.headers.has("ratelimit-limit") || res.headers.has("x-ratelimit-limit");
          body = await res.json();
        }
      }

      assert.equal(lastStatus, 429, "requests beyond the budget must be rejected with 429");
      assert.equal(body?.success, false);
      assert.match(body?.message ?? "", /too many/i);
      assert.ok(sawRetryAfterHeader, "standard rate-limit headers should be present on the 429 response");
    } finally {
      server.close();
    }
  });

  it("does not rate-limit a second, distinct client IP once the first is blocked", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use(apiRateLimiter);
    app.get("/api/v1/players", (_req, res) => res.status(200).json({ success: true }));

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const limit = parseInt(process.env.API_RATE_LIMIT_MAX || "100", 10);

    try {
      for (let i = 0; i < limit + 5; i++) {
        await fetch(`${baseUrl}/api/v1/players`, { headers: { "X-Forwarded-For": "198.51.100.9" } });
      }

      const freshClientRes = await fetch(`${baseUrl}/api/v1/players`, {
        headers: { "X-Forwarded-For": "198.51.100.10" },
      });

      assert.equal(freshClientRes.status, 200, "a different client IP must not be blocked");
    } finally {
      server.close();
    }
  });
});
