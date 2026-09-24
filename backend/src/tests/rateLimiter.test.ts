import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Server } from "node:http";
import {
  authRateLimiter,
  financialRateLimiter,
  syncRateLimiter,
  squadRateLimiter,
  apiRateLimiter,
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
});
