import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createSecurityCanary } from "../middleware/securityCanary.js";

test("canary locks out subsequent requests across app instances and notifies once per probe", async () => {
  const keys = new Map<string, string>(); let alerts = 0; let expiry = 0;
  const store = { get: async (key: string) => keys.get(key) ?? null, set: async (key: string, value: string, _mode: "EX", ttl: number) => { keys.set(key, value); expiry = ttl; } };
  const createApp = () => {
    const app = express();
    const canary = createSecurityCanary({ store: () => store, alert: async () => { alerts++; } });
    app.use(canary.guard); app.all("/admin/canary/:token", canary.trigger);
    app.get("/normal", (_req, res) => { res.json({ ok: true }); }); return app;
  };
  const a = createApp(), b = createApp();
  assert.equal((await request(a).get("/normal")).status, 200);
  assert.equal((await request(a).get("/admin/canary/decoy")).status, 403);
  assert.equal((await request(b).get("/normal")).status, 403);
  assert.equal(alerts, 1); assert.equal(expiry, 900);
  keys.clear(); assert.equal((await request(b).get("/normal")).status, 200);
});

test("canary refuses to claim lockout when shared storage is unavailable", async () => {
  const app = express();
  const canary = createSecurityCanary({ store: () => null, alert: async () => assert.fail("must not report a lockout") });
  app.get("/canary", canary.trigger);
  assert.equal((await request(app).get("/canary")).status, 503);
});
