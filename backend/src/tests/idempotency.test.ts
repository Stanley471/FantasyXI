import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import {
  createIdempotencyMiddleware,
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  stableStringify,
} from "../middleware/idempotency.js";
import {
  IDEMPOTENCY_CAS_SCRIPT,
  IdempotencyRedisClient,
  IdempotencyStore,
  MemoryIdempotencyStore,
  RedisIdempotencyStore,
} from "../services/idempotency/idempotencyStore.js";
import financialRoutes from "../routes/financial.routes.js";
import squadRoutes from "../routes/squad.routes.js";
import { signAccessToken } from "../config/jwt.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Minimal Redis fake: SET NX PX, GET and the store's compare-and-set script.
 * Every command yields to the event loop first so concurrent requests interleave
 * the way they would against a real server.
 */
class FakeRedis implements IdempotencyRedisClient {
  private data = new Map<string, { value: string; expiresAt: number }>();
  public commands = 0;

  private live(key: string) {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, value: string, _px: "PX", ttlMs: number, _nx: "NX"): Promise<unknown> {
    await tick();
    this.commands++;
    if (this.live(key)) return null;
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    await tick();
    this.commands++;
    return this.live(key)?.value ?? null;
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    await tick();
    this.commands++;
    assert.equal(script, IDEMPOTENCY_CAS_SCRIPT);
    const [key, token, replacement, ttl] = args.map(String);
    const entry = this.live(key);
    if (!entry) return 0;
    if (JSON.parse(entry.value).token !== token) return 0;
    if (replacement === "") this.data.delete(key);
    else this.data.set(key, { value: replacement, expiresAt: Date.now() + Number(ttl) });
    return 1;
  }
}

interface AppOptions {
  store: IdempotencyStore;
  handlerDelayMs?: number;
  lockTtlMs?: number;
  required?: boolean;
}

function buildApp(options: AppOptions) {
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth: the user id comes from a test header
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.get("x-test-user");
    if (userId) req.user = { id: userId, email: "", username: userId, role: "USER" } as Request["user"];
    next();
  });
  app.use(
    createIdempotencyMiddleware({ store: options.store, lockTtlMs: options.lockTtlMs, required: options.required })
  );

  const state = { executions: 0, failNext: 0, throwNext: 0 };

  app.post("/payments", async (req: Request, res: Response, next: NextFunction) => {
    state.executions++;
    const execution = state.executions;
    if (options.handlerDelayMs) await sleep(options.handlerDelayMs);
    if (state.throwNext > 0) {
      state.throwNext--;
      return next(new Error("database connection reset"));
    }
    if (state.failNext > 0) {
      state.failNext--;
      res.status(503).json({ success: false, message: "upstream unavailable" });
      return;
    }
    if (req.body?.amount === undefined) {
      res.status(400).json({ success: false, message: "amount is required", execution });
      return;
    }
    res.status(201).json({ success: true, paymentId: `pay_${execution}`, amount: req.body.amount });
  });
  app.get("/payments", (_req, res) => {
    state.executions++;
    res.json({ success: true });
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ success: false, message: err.message });
  });

  return { app, state };
}

const post = (app: express.Express, key: string | undefined, body: unknown, user = "user-1") => {
  const req = request(app).post("/payments").set("x-test-user", user);
  if (key !== undefined) req.set(IDEMPOTENCY_HEADER, key);
  return req.send(body as object);
};

for (const [label, makeStore] of [
  ["memory store", () => new MemoryIdempotencyStore()],
  ["redis store", () => new RedisIdempotencyStore(new FakeRedis())],
] as const) {
  describe(`Idempotency middleware (${label})`, () => {
    let store: IdempotencyStore;
    beforeEach(() => {
      store = makeStore();
    });

    it("passes requests without an Idempotency-Key straight through", async () => {
      const { app, state } = buildApp({ store });
      await post(app, undefined, { amount: 10 }).expect(201);
      await post(app, undefined, { amount: 10 }).expect(201);
      assert.equal(state.executions, 2);
    });

    it("replays the exact original status code and body without re-executing", async () => {
      const { app, state } = buildApp({ store });
      const first = await post(app, "key-replay-1", { amount: 25 }).expect(201);
      const second = await post(app, "key-replay-1", { amount: 25 }).expect(201);

      assert.equal(state.executions, 1);
      assert.equal(second.text, first.text);
      assert.equal(second.headers["content-type"], first.headers["content-type"]);
      assert.equal(second.headers[IDEMPOTENT_REPLAY_HEADER.toLowerCase()], "true");
      assert.equal(first.headers[IDEMPOTENT_REPLAY_HEADER.toLowerCase()], undefined);
    });

    it("treats bodies with reordered keys as the same request", async () => {
      const { app, state } = buildApp({ store });
      await post(app, "key-order", { amount: 5, memo: "a" }).expect(201);
      await post(app, "key-order", { memo: "a", amount: 5 }).expect(201);
      assert.equal(state.executions, 1);
    });

    it("rejects reuse of a key for a different request body with 422", async () => {
      const { app, state } = buildApp({ store });
      await post(app, "key-reuse", { amount: 10 }).expect(201);
      const res = await post(app, "key-reuse", { amount: 9999 }).expect(422);
      assert.equal(res.body.code, "IDEMPOTENCY_KEY_REUSED");
      assert.equal(state.executions, 1);
    });

    it("locks concurrent requests with the same key so the handler runs once", async () => {
      const { app, state } = buildApp({ store, handlerDelayMs: 80 });
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => post(app, "key-concurrent", { amount: 1 }))
      );
      assert.equal(state.executions, 1);
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
      const conflict = responses.find((r) => r.status === 409)!;
      assert.equal(conflict.body.code, "IDEMPOTENCY_REQUEST_IN_PROGRESS");
      assert.equal(conflict.headers["retry-after"], "1");
    });

    it("survives 100 concurrent identical requests with exactly one execution", async () => {
      const { app, state } = buildApp({ store, handlerDelayMs: 30 });
      const responses = await Promise.all(
        Array.from({ length: 100 }, () => post(app, "key-stress-100", { amount: 42 }))
      );

      assert.equal(state.executions, 1, "handler must execute exactly once");
      const originals = responses.filter((r) => r.status === 201);
      const conflicts = responses.filter((r) => r.status === 409);
      assert.equal(originals.length + conflicts.length, 100, "only 201 or 409 responses are allowed");
      assert.ok(originals.length >= 1);
      // Every 201 (original or replay) carries the same body
      assert.equal(new Set(originals.map((r) => r.text)).size, 1);

      // Once settled, every retry is a replay of the original
      const replay = await post(app, "key-stress-100", { amount: 42 }).expect(201);
      assert.equal(replay.text, originals[0].text);
      assert.equal(state.executions, 1);
    });

    it("runs 100 concurrent requests with distinct keys independently", async () => {
      const { app, state } = buildApp({ store, handlerDelayMs: 5 });
      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, i) => post(app, `key-distinct-${i}`, { amount: i }))
      );
      assert.ok(responses.every((r) => r.status === 201));
      assert.equal(state.executions, 100);
    });

    it("releases the lock after a transient 5xx so the retry executes", async () => {
      const { app, state } = buildApp({ store });
      state.failNext = 1;
      await post(app, "key-transient", { amount: 3 }).expect(503);
      const retry = await post(app, "key-transient", { amount: 3 }).expect(201);
      assert.equal(state.executions, 2);
      assert.equal(retry.headers[IDEMPOTENT_REPLAY_HEADER.toLowerCase()], undefined);
    });

    it("releases the lock when the handler throws", async () => {
      const { app, state } = buildApp({ store });
      state.throwNext = 1;
      await post(app, "key-throw", { amount: 3 }).expect(500);
      await post(app, "key-throw", { amount: 3 }).expect(201);
      assert.equal(state.executions, 2);
    });

    it("caches deterministic client errors (FAILED) and replays them", async () => {
      const { app, state } = buildApp({ store });
      const first = await post(app, "key-400", {}).expect(400);
      const second = await post(app, "key-400", {}).expect(400);
      assert.equal(state.executions, 1);
      assert.equal(second.text, first.text);
      assert.equal(second.headers[IDEMPOTENT_REPLAY_HEADER.toLowerCase()], "true");
    });

    it("scopes keys per authenticated user", async () => {
      const { app, state } = buildApp({ store });
      const a = await post(app, "shared-key", { amount: 1 }, "user-a").expect(201);
      const b = await post(app, "shared-key", { amount: 1 }, "user-b").expect(201);
      assert.equal(state.executions, 2);
      assert.notEqual(a.body.paymentId, b.body.paymentId);
    });

    it("keeps the lock alive while a slow handler outlives the lock TTL", async () => {
      const { app, state } = buildApp({ store, handlerDelayMs: 450, lockTtlMs: 150 });
      // supertest is lazy: .then() sends the first request now
      const first = post(app, "key-slow", { amount: 7 }).then((res) => res);
      await sleep(300); // past the original lock TTL
      const duplicate = await post(app, "key-slow", { amount: 7 });
      const original = await first;
      assert.equal(duplicate.status, 409);
      assert.equal(original.status, 201);
      assert.equal(state.executions, 1);
    });
  });
}

describe("Idempotency middleware (validation and failure modes)", () => {
  it("ignores read-only GET requests", async () => {
    const { app, state } = buildApp({ store: new MemoryIdempotencyStore() });
    await request(app).get("/payments").set(IDEMPOTENCY_HEADER, "get-key").expect(200);
    await request(app).get("/payments").set(IDEMPOTENCY_HEADER, "get-key").expect(200);
    assert.equal(state.executions, 2);
  });

  it("rejects malformed keys", async () => {
    const { app, state } = buildApp({ store: new MemoryIdempotencyStore() });
    const res = await post(app, "has spaces!", { amount: 1 }).expect(400);
    assert.equal(res.body.code, "IDEMPOTENCY_KEY_INVALID");
    await post(app, "x".repeat(256), { amount: 1 }).expect(400);
    assert.equal(state.executions, 0);
  });

  it("requires a key when configured", async () => {
    const { app, state } = buildApp({ store: new MemoryIdempotencyStore(), required: true });
    const res = await post(app, undefined, { amount: 1 }).expect(400);
    assert.equal(res.body.code, "IDEMPOTENCY_KEY_REQUIRED");
    assert.equal(state.executions, 0);
  });

  it("fails closed with 503 when the store is unreachable", async () => {
    const broken: IdempotencyStore = {
      begin: async () => {
        throw new Error("ECONNREFUSED");
      },
      markInProgress: async () => false,
      complete: async () => false,
      release: async () => false,
    };
    const { app, state } = buildApp({ store: broken });
    const res = await post(app, "key-down", { amount: 1 }).expect(503);
    assert.equal(res.body.code, "IDEMPOTENCY_UNAVAILABLE");
    assert.equal(state.executions, 0);
  });

  it("produces a stable fingerprint input regardless of key order", () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    assert.equal(stableStringify(undefined), "");
  });
});

describe("Idempotency stores (fencing tokens)", () => {
  for (const [label, makeStore] of [
    ["memory", () => new MemoryIdempotencyStore()],
    ["redis", () => new RedisIdempotencyStore(new FakeRedis())],
  ] as const) {
    it(`${label}: only the owning token can advance, complete or release a record`, async () => {
      const store = makeStore();
      const claim = await store.begin("k", "fp", 1_000);
      assert.equal(claim.acquired, true);
      const token = (claim as { token: string }).token;

      const second = await store.begin("k", "fp", 1_000);
      assert.equal(second.acquired, false);
      assert.equal((second as { record: { state: string } }).record.state, "PENDING");

      assert.equal(await store.markInProgress("k", "not-the-owner", 1_000), false);
      assert.equal(await store.markInProgress("k", token, 1_000), true);
      assert.equal(await store.release("k", "not-the-owner"), false);
      assert.equal(
        await store.complete("k", "not-the-owner", "COMPLETED", { statusCode: 200, headers: {}, body: "x" }, 60),
        false
      );
      assert.equal(
        await store.complete("k", token, "COMPLETED", { statusCode: 200, headers: {}, body: "ok" }, 60),
        true
      );

      const replay = await store.begin("k", "fp", 1_000);
      assert.equal(replay.acquired, false);
      const record = (replay as { record: { state: string; response?: { body: string } } }).record;
      assert.equal(record.state, "COMPLETED");
      assert.equal(record.response?.body, "ok");
    });

    it(`${label}: an expired lock can be reclaimed and the stale owner cannot overwrite it`, async () => {
      const store = makeStore();
      const stale = (await store.begin("k2", "fp", 30)) as { acquired: true; token: string };
      await sleep(60);
      const fresh = await store.begin("k2", "fp", 1_000);
      assert.equal(fresh.acquired, true);
      assert.equal(
        await store.complete("k2", stale.token, "COMPLETED", { statusCode: 201, headers: {}, body: "stale" }, 60),
        false
      );
    });
  }
});

describe("Idempotency middleware is mounted on mutation routes", () => {
  const token = signAccessToken({ userId: "user-routes", email: "routes@example.com", username: "routes" });

  it("guards financial mutations", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/leagues/:leagueId/financial", financialRoutes);
    const res = await request(app)
      .post("/api/v1/leagues/11111111-1111-1111-1111-111111111111/financial/submit")
      .set("Authorization", `Bearer ${token}`)
      .set(IDEMPOTENCY_HEADER, "not a valid key")
      .send({})
      .expect(400);
    assert.equal(res.body.code, "IDEMPOTENCY_KEY_INVALID");
  });

  it("guards squad mutations", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/squads", squadRoutes);
    const res = await request(app)
      .put("/api/v1/squads/some-squad")
      .set("Authorization", `Bearer ${token}`)
      .set(IDEMPOTENCY_HEADER, "not a valid key")
      .send({})
      .expect(400);
    assert.equal(res.body.code, "IDEMPOTENCY_KEY_INVALID");
  });
});
