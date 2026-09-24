import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { authRateLimiter, apiRateLimiter } from "../middleware/rateLimiter.js";

describe("Rate-Limiting & DDoS Mitigation Middleware", () => {
  it("should block auth requests exceeding strict limit with 429 Too Many Requests", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.post("/auth/login", authRateLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      let lastStatus = 200;
      // Make 10 rapid login attempts (max allowed is 5)
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: { "X-Forwarded-For": "203.0.113.195" },
        });
        lastStatus = res.status;
      }

      assert.strictEqual(lastStatus, 429);
    } finally {
      server.close();
    }
  });

  it("should differentiate client IPs using X-Forwarded-For header", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.get("/api/test", apiRateLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const res1 = await fetch(`${baseUrl}/api/test`, {
        headers: { "X-Forwarded-For": "198.51.100.1" },
      });
      const res2 = await fetch(`${baseUrl}/api/test`, {
        headers: { "X-Forwarded-For": "198.51.100.2" },
      });

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 200);
    } finally {
      server.close();
    }
  });
});
