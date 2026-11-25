import assert from "node:assert/strict";
import { mock, test } from "node:test";
import express from "express";
import { ipKeyGenerator } from "express-rate-limit";
import request from "supertest";

test("financial audit routes throttle anonymous probes before authorization or audit work", async () => {
  const previousLimit = process.env.AUTHORIZATION_RATE_LIMIT_MAX;
  process.env.AUTHORIZATION_RATE_LIMIT_MAX = "2";
  const { default: router } = await import("../routes/financialMerkle.routes.js");
  const { authorizationRateLimiter } = await import("../middleware/rateLimiter.js");
  const { financialMerkleService } = await import("../services/audit/financialMerkleService.js");
  const verify = mock.method(financialMerkleService, "verify", async () => []);
  const proof = mock.method(financialMerkleService, "proof", async () => []);
  const key = ipKeyGenerator("::ffff:127.0.0.1");
  authorizationRateLimiter.resetKey(key);
  const app = express();
  app.use(express.json());
  app.use("/audit-integrity", router);

  try {
    assert.equal((await request(app).post("/audit-integrity/verify")).status, 401);
    assert.equal((await request(app).get("/audit-integrity/transactions/synthetic/proof")).status, 401);
    const blocked = await request(app).post("/audit-integrity/verify");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    assert.equal((await request(app).get("/audit-integrity/roots")).status, 429);
    assert.equal(verify.mock.callCount(), 0);
    assert.equal(proof.mock.callCount(), 0);
  } finally {
    verify.mock.restore();
    proof.mock.restore();
    authorizationRateLimiter.resetKey(key);
    if (previousLimit === undefined) delete process.env.AUTHORIZATION_RATE_LIMIT_MAX;
    else process.env.AUTHORIZATION_RATE_LIMIT_MAX = previousLimit;
  }
});
