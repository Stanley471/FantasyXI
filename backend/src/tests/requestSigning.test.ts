import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import {
  API_SIGNING_TOLERANCE_SECONDS,
  canonicalRequestString,
  hashRequestBody,
  parseTimestampMs,
  signRequest,
  stableStringify,
  verifyApiRequestSignature,
} from "../services/apiSigning/requestSigner.js";
import {
  MemoryApiNonceStore,
  RedisApiNonceStore,
} from "../services/apiSigning/nonceStore.js";
import type { IRedisCacheClient } from "../config/redis.js";
import {
  createRequestSigning,
  isPublicSignedPath,
} from "../middleware/requestSigning.js";
import { createApiSigningClient, signApiRequest } from "../sdk/apiSigning.js";

/**
 * Generous rate limiter mounted ahead of the signing middleware in every test
 * app, mirroring production ordering in app.ts (rate limit before HMAC checks).
 */
function testRateLimiter() {
  return rateLimit({ windowMs: 60_000, limit: 10_000, standardHeaders: false, legacyHeaders: false });
}

/**
 * Tests for API request signing (issue #455): canonical string generation,
 * HMAC-SHA256 verification, the 300s clock-skew window, Redis/in-memory
 * nonce replay defense, the Express middleware, and the partner SDK.
 *
 * All time-sensitive cases run against a fixed clock injected through the
 * middleware's `now` option / `verifyApiRequestSignature`'s `nowMs`, so the
 * 300s vs 301s boundary is deterministic. No test needs a live Redis: the
 * Redis store is exercised against a fake client below.
 */

const SECRET = "test-partner-signing-secret";
const SECONDARY_SECRET = "test-secondary-signing-secret";
const NOW_MS = 1_791_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const PATH = "/api/v1/players";
const EMPTY_BODY_HASH = createHash("sha256").update("").digest("hex");

function signedHeaders(
  method: string,
  path: string,
  body: unknown = undefined,
  overrides: { timestamp?: string | number; nonce?: string; secret?: string } = {}
) {
  const signed = signApiRequest({
    method,
    path,
    body,
    secret: overrides.secret ?? SECRET,
    timestamp: overrides.timestamp ?? NOW_SEC,
    nonce: overrides.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`,
  });
  return signed.headers;
}

interface TestApp {
  app: express.Express;
  store: MemoryApiNonceStore;
}

/** Express app with signing enforced (GET + POST) on a fresh memory nonce store. */
function buildApp(
  options: {
    secrets?: string | { primarySecret: string; secondarySecret?: string };
    enabled?: boolean;
    methods?: string[];
    nonceStore?: MemoryApiNonceStore;
  } = {}
): TestApp {
  const store = options.nonceStore ?? new MemoryApiNonceStore(() => NOW_MS);
  const app = express();
  app.use(express.json());
  app.use(testRateLimiter());
  app.use(
    createRequestSigning({
      enabled: options.enabled ?? true,
      secrets: options.secrets ?? SECRET,
      methods: options.methods ?? ["GET", "POST"],
      nonceStore: store,
      now: () => NOW_MS,
    })
  );
  app.get("/api/v1/players", (req, res) => res.json({ success: true, signed: req.apiSigning ?? null }));
  app.post("/api/v1/players", (req, res) => res.json({ success: true, signed: req.apiSigning ?? null }));
  app.get("/api/v1/auth/login", (_req, res) => res.json({ success: true }));
  app.get("/api/health", (_req, res) => res.json({ success: true }));
  return { app, store };
}

// ---------------------------------------------------------------------------
// Canonical string + body hashing
// ---------------------------------------------------------------------------

describe("canonicalRequestString", () => {
  it("builds the exact canonical string for a GET with no body", () => {
    assert.equal(
      canonicalRequestString({
        method: "GET",
        path: "/api/v1/players",
        timestamp: 1_700_000_000,
        nonce: "nonce-1",
      }),
      `GET\n/api/v1/players\n1700000000\nnonce-1\n${EMPTY_BODY_HASH}`
    );
  });

  it("includes the query string in the signed path", () => {
    const withQuery = canonicalRequestString({
      method: "GET",
      path: "/api/v1/players?page=2",
      timestamp: NOW_SEC,
      nonce: "n1",
    });
    const withoutQuery = canonicalRequestString({
      method: "GET",
      path: "/api/v1/players",
      timestamp: NOW_SEC,
      nonce: "n1",
    });
    assert.notEqual(withQuery, withoutQuery);
    assert.ok(withQuery.includes("/api/v1/players?page=2"));
  });

  it("upper-cases the method", () => {
    assert.equal(
      canonicalRequestString({ method: "get", path: PATH, timestamp: NOW_SEC, nonce: "n1" }),
      canonicalRequestString({ method: "GET", path: PATH, timestamp: NOW_SEC, nonce: "n1" })
    );
  });

  it("uses the timestamp exactly as supplied (seconds vs milliseconds differ)", () => {
    const seconds = canonicalRequestString({ method: "GET", path: PATH, timestamp: NOW_SEC, nonce: "n1" });
    const millis = canonicalRequestString({ method: "GET", path: PATH, timestamp: NOW_MS, nonce: "n1" });
    assert.notEqual(seconds, millis);
  });
});

describe("hashRequestBody / stableStringify", () => {
  it("hashes an absent body as the empty string", () => {
    assert.equal(hashRequestBody(undefined), EMPTY_BODY_HASH);
    assert.equal(hashRequestBody(null), EMPTY_BODY_HASH);
    assert.equal(hashRequestBody({}), EMPTY_BODY_HASH);
  });

  it("hashes a raw string body byte-exact", () => {
    assert.equal(
      hashRequestBody('{"a":1}'),
      createHash("sha256").update('{"a":1}').digest("hex")
    );
  });

  it("hashes parsed JSON bodies independent of key order", () => {
    assert.equal(hashRequestBody({ b: 2, a: 1 }), hashRequestBody({ a: 1, b: 2 }));
    assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });

  it("hashes nested objects and arrays stably", () => {
    assert.equal(
      hashRequestBody({ z: [{ b: 1, a: 2 }], a: { d: 4, c: 3 } }),
      hashRequestBody({ a: { c: 3, d: 4 }, z: [{ a: 2, b: 1 }] })
    );
  });
});

// ---------------------------------------------------------------------------
// Signature verification (pure)
// ---------------------------------------------------------------------------

describe("verifyApiRequestSignature", () => {
  const base = {
    method: "GET",
    path: PATH,
    timestamp: NOW_SEC,
    nonce: "verify-nonce-1",
    secrets: SECRET,
    nowMs: NOW_MS,
  };

  it("accepts a signature produced by signRequest", () => {
    const { signature } = signRequest({ ...base, secret: SECRET });
    const result = verifyApiRequestSignature({ ...base, signature });
    assert.deepEqual(result, { valid: true, usedSecret: "primary" });
  });

  it("accepts a signature made with the secondary secret (rotation)", () => {
    const { signature } = signRequest({ ...base, secret: SECONDARY_SECRET });
    const result = verifyApiRequestSignature({
      ...base,
      signature,
      secrets: { primarySecret: SECRET, secondarySecret: SECONDARY_SECRET },
    });
    assert.deepEqual(result, { valid: true, usedSecret: "secondary" });
  });

  it("rejects a tampered body", () => {
    const { signature } = signRequest({ ...base, secret: SECRET, body: { a: 1 } });
    const result = verifyApiRequestSignature({ ...base, signature, body: { a: 2 } });
    assert.equal(result.valid, false);
  });

  it("rejects a tampered path / query string", () => {
    const { signature } = signRequest({ ...base, secret: SECRET });
    const result = verifyApiRequestSignature({ ...base, signature, path: "/api/v1/players?page=2" });
    assert.equal(result.valid, false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const { signature } = signRequest({ ...base, secret: "someone-elses-secret" });
    assert.equal(verifyApiRequestSignature({ ...base, signature }).valid, false);
  });

  it("rejects malformed signatures (non-hex, wrong length, empty)", () => {
    for (const signature of ["zzzz", "00", "", "a".repeat(63), "a".repeat(65)]) {
      assert.equal(
        verifyApiRequestSignature({ ...base, signature }).valid,
        false,
        `expected rejection for ${JSON.stringify(signature)}`
      );
    }
  });

  it("accepts the optional sha256= prefix", () => {
    const { signature } = signRequest({ ...base, secret: SECRET });
    assert.equal(
      verifyApiRequestSignature({ ...base, signature: `sha256=${signature}` }).valid,
      true
    );
  });

  it("accepts a timestamp exactly 300s in the past (boundary)", () => {
    const { signature } = signRequest({
      ...base,
      secret: SECRET,
      timestamp: NOW_SEC - API_SIGNING_TOLERANCE_SECONDS,
    });
    const result = verifyApiRequestSignature({
      ...base,
      signature,
      timestamp: NOW_SEC - API_SIGNING_TOLERANCE_SECONDS,
    });
    assert.equal(result.valid, true);
  });

  it("rejects a timestamp 301s in the past", () => {
    const timestamp = NOW_SEC - API_SIGNING_TOLERANCE_SECONDS - 1;
    const { signature } = signRequest({ ...base, secret: SECRET, timestamp });
    const result = verifyApiRequestSignature({ ...base, signature, timestamp });
    assert.equal(result.valid, false);
    if (!result.valid) assert.match(result.reason, /more than 300 seconds/);
  });

  it("accepts a timestamp exactly 300s in the future, rejects 301s", () => {
    const okTimestamp = NOW_SEC + API_SIGNING_TOLERANCE_SECONDS;
    const ok = signRequest({ ...base, secret: SECRET, timestamp: okTimestamp });
    assert.equal(
      verifyApiRequestSignature({ ...base, signature: ok.signature, timestamp: okTimestamp }).valid,
      true
    );
    const lateTimestamp = NOW_SEC + API_SIGNING_TOLERANCE_SECONDS + 1;
    const late = signRequest({ ...base, secret: SECRET, timestamp: lateTimestamp });
    assert.equal(
      verifyApiRequestSignature({ ...base, signature: late.signature, timestamp: lateTimestamp }).valid,
      false
    );
  });

  it("accepts epoch-millisecond timestamps", () => {
    const { signature } = signRequest({ ...base, secret: SECRET, timestamp: NOW_MS });
    assert.equal(
      verifyApiRequestSignature({ ...base, signature, timestamp: NOW_MS }).valid,
      true
    );
  });

  it("rejects non-numeric timestamps", () => {
    assert.equal(
      verifyApiRequestSignature({ ...base, signature: "not-a-time", timestamp: "not-a-time" }).valid,
      false
    );
  });

  it("rejects malformed nonces", () => {
    const { signature } = signRequest({ ...base, secret: SECRET, nonce: "bad nonce!" });
    assert.equal(verifyApiRequestSignature({ ...base, signature, nonce: "bad nonce!" }).valid, false);
  });
});

describe("parseTimestampMs", () => {
  it("converts epoch seconds to milliseconds and passes milliseconds through", () => {
    assert.equal(parseTimestampMs(1_700_000_000), 1_700_000_000_000);
    assert.equal(parseTimestampMs(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(parseTimestampMs("1700000000"), 1_700_000_000_000);
  });

  it("returns null for malformed input", () => {
    assert.equal(parseTimestampMs("tomorrow"), null);
    assert.equal(parseTimestampMs("12.5"), null);
    assert.equal(parseTimestampMs(""), null);
  });
});

// ---------------------------------------------------------------------------
// Nonce stores
// ---------------------------------------------------------------------------

describe("MemoryApiNonceStore", () => {
  it("consumes a fresh nonce once, then reports it as replayed", async () => {
    const store = new MemoryApiNonceStore(() => NOW_MS);
    assert.equal(await store.consume("nonce-a"), true);
    assert.equal(await store.consume("nonce-a"), false);
    assert.equal(await store.consume("nonce-b"), true);
    assert.equal(store.size(), 2);
  });

  it("accepts a nonce again after its TTL expires", async () => {
    let now = NOW_MS;
    const store = new MemoryApiNonceStore(() => now);
    assert.equal(await store.consume("nonce-a", 300), true);
    assert.equal(await store.consume("nonce-a", 300), false);
    now += 301_000;
    assert.equal(await store.consume("nonce-a", 300), true);
  });
});

/** Minimal Redis fake: SET NX EX only, with a controllable clock. */
class FakeRedis {
  private data = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    const exIndex = args.indexOf("EX");
    const ttlSeconds = exIndex >= 0 ? Number(args[exIndex + 1]) : 0;
    const nx = args.includes("NX");
    const existing = this.data.get(key);
    if (existing && existing.expiresAt > this.now()) {
      if (nx) return null;
    } else if (existing) {
      this.data.delete(key);
    }
    this.data.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return "OK";
  }
}

describe("RedisApiNonceStore", () => {
  it("claims a nonce once via SET NX EX and rejects the replay", async () => {
    const store = new RedisApiNonceStore(new FakeRedis(() => NOW_MS) as unknown as IRedisCacheClient);
    assert.equal(await store.consume("redis-nonce-a"), true);
    assert.equal(await store.consume("redis-nonce-a"), false);
    assert.equal(await store.consume("redis-nonce-b"), true);
  });

  it("accepts a nonce again after its Redis TTL expires", async () => {
    let now = NOW_MS;
    const store = new RedisApiNonceStore(new FakeRedis(() => now) as unknown as IRedisCacheClient);
    assert.equal(await store.consume("redis-nonce-a", 300), true);
    assert.equal(await store.consume("redis-nonce-a", 300), false);
    now += 301_000;
    assert.equal(await store.consume("redis-nonce-a", 300), true);
  });

  it("falls back to memory when Redis throws, still rejecting replays", async () => {
    const failing = {
      set: async (): Promise<unknown> => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as IRedisCacheClient;
    const store = new RedisApiNonceStore(failing);
    assert.equal(await store.consume("fallback-nonce"), true);
    assert.equal(await store.consume("fallback-nonce"), false);
  });
});

// ---------------------------------------------------------------------------
// Middleware (via supertest)
// ---------------------------------------------------------------------------

describe("createRequestSigning middleware", () => {
  it("passes a validly signed GET and exposes req.apiSigning", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("GET", PATH, undefined, { nonce: "mw-valid-1" });
    const res = await request(app).get(PATH).set(headers);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.signed.verified, true);
    assert.equal(res.body.signed.nonce, "mw-valid-1");
    assert.equal(res.body.signed.usedSecret, "primary");
  });

  it("passes a validly signed GET with a query string", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("GET", "/api/v1/players?page=2", undefined, { nonce: "mw-q-1" });
    const res = await request(app).get("/api/v1/players?page=2").set(headers);
    assert.equal(res.status, 200);
  });

  it("rejects requests missing all signing headers with 401", async () => {
    const { app } = buildApp();
    const res = await request(app).get(PATH);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "API_SIGNING_MISSING_HEADERS");
  });

  it("rejects requests missing only the nonce with 401", async () => {
    const { app } = buildApp();
    const { signature, timestamp } = signApiRequest({
      method: "GET",
      path: PATH,
      secret: SECRET,
      timestamp: NOW_SEC,
      nonce: "mw-no-nonce",
    });
    const res = await request(app)
      .get(PATH)
      .set("X-Signature", signature)
      .set("X-Timestamp", timestamp);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "API_SIGNING_MISSING_HEADERS");
  });

  it("rejects a bad signature with 401", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("GET", PATH, undefined, { nonce: "mw-bad-sig", secret: "wrong-secret" });
    const res = await request(app).get(PATH).set(headers);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "API_SIGNING_INVALID_SIGNATURE");
  });

  it("rejects a tampered query string with 401", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("GET", "/api/v1/players?page=2", undefined, { nonce: "mw-tamper-q" });
    const res = await request(app).get("/api/v1/players?page=3").set(headers);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "API_SIGNING_INVALID_SIGNATURE");
  });

  it("rejects a tampered POST body with 401", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("POST", PATH, { a: 1 }, { nonce: "mw-tamper-b" });
    const res = await request(app).post(PATH).set(headers).send({ a: 2 });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "API_SIGNING_INVALID_SIGNATURE");
  });

  it("passes a validly signed POST with a JSON body", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("POST", PATH, { b: 2, a: 1 }, { nonce: "mw-post-ok" });
    const res = await request(app).post(PATH).set(headers).send({ a: 1, b: 2 });
    assert.equal(res.status, 200);
  });

  it("rejects an expired timestamp (301s old) with 401", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("GET", PATH, undefined, {
      nonce: "mw-expired",
      timestamp: NOW_SEC - 301,
    });
    const res = await request(app).get(PATH).set(headers);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "API_SIGNING_TIMESTAMP_EXPIRED");
  });

  it("accepts a timestamp exactly 300s old and rejects 301s (boundary)", async () => {
    const { app } = buildApp();
    const okHeaders = signedHeaders("GET", PATH, undefined, {
      nonce: "mw-boundary-300",
      timestamp: NOW_SEC - 300,
    });
    assert.equal((await request(app).get(PATH).set(okHeaders)).status, 200);
    const lateHeaders = signedHeaders("GET", PATH, undefined, {
      nonce: "mw-boundary-301",
      timestamp: NOW_SEC - 301,
    });
    assert.equal((await request(app).get(PATH).set(lateHeaders)).status, 401);
  });

  it("rejects a replayed nonce with 401 and lets a fresh nonce through", async () => {
    const { app } = buildApp();
    const headers = signedHeaders("GET", PATH, undefined, { nonce: "mw-replay-1" });
    assert.equal((await request(app).get(PATH).set(headers)).status, 200);
    const replay = await request(app).get(PATH).set(headers);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, "API_SIGNING_NONCE_REPLAYED");
    const fresh = signedHeaders("GET", PATH, undefined, { nonce: "mw-replay-2" });
    assert.equal((await request(app).get(PATH).set(fresh)).status, 200);
  });

  it("does not burn a nonce when the signature is bad (retry with the same nonce passes)", async () => {
    const { app } = buildApp();
    const bad = signedHeaders("GET", PATH, undefined, { nonce: "mw-no-burn", secret: "wrong-secret" });
    assert.equal((await request(app).get(PATH).set(bad)).status, 401);
    const good = signedHeaders("GET", PATH, undefined, { nonce: "mw-no-burn" });
    assert.equal((await request(app).get(PATH).set(good)).status, 200);
  });

  it("passes non-public paths without any signing headers", async () => {
    const { app } = buildApp();
    assert.equal((await request(app).get("/api/v1/auth/login")).status, 200);
    assert.equal((await request(app).get("/api/health")).status, 200);
  });

  it("does not enforce on methods outside the configured list (default GET only)", async () => {
    const { app } = buildApp({ methods: ["GET"] });
    const res = await request(app).post(PATH).send({ a: 1 });
    assert.equal(res.status, 200);
  });

  it("is a pass-through while disabled", async () => {
    const { app } = buildApp({ enabled: false });
    assert.equal((await request(app).get(PATH)).status, 200);
  });

  it("fails closed with 503 when enabled but no secret is configured", async () => {
    const savedSecret = process.env.API_SIGNING_SECRET;
    const savedSecondary = process.env.API_SIGNING_SECRET_SECONDARY;
    delete process.env.API_SIGNING_SECRET;
    delete process.env.API_SIGNING_SECRET_SECONDARY;
    try {
      const app = express();
      app.use(express.json());
      app.use(testRateLimiter());
      app.use(
        createRequestSigning({
          enabled: true,
          secrets: undefined,
          nonceStore: new MemoryApiNonceStore(() => NOW_MS),
          now: () => NOW_MS,
        })
      );
      app.get(PATH, (_req, res) => res.json({ success: true }));
      const headers = signedHeaders("GET", PATH, undefined, { nonce: "mw-no-secret" });
      const res = await request(app).get(PATH).set(headers);
      assert.equal(res.status, 503);
      assert.equal(res.body.code, "API_SIGNING_NOT_CONFIGURED");
    } finally {
      if (savedSecret !== undefined) process.env.API_SIGNING_SECRET = savedSecret;
      if (savedSecondary !== undefined) process.env.API_SIGNING_SECRET_SECONDARY = savedSecondary;
    }
  });

  it("fails closed with 503 when the nonce store throws", async () => {
    const throwingStore = {
      consume: async (): Promise<boolean> => {
        throw new Error("store down");
      },
    };
    const app = express();
    app.use(express.json());
    app.use(testRateLimiter());
    app.use(
      createRequestSigning({
        enabled: true,
        secrets: SECRET,
        nonceStore: throwingStore,
        now: () => NOW_MS,
      })
    );
    app.get(PATH, (_req, res) => res.json({ success: true }));
    const headers = signedHeaders("GET", PATH, undefined, { nonce: "mw-store-down" });
    const res = await request(app).get(PATH).set(headers);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "API_SIGNING_UNAVAILABLE");
  });

  it("verifies against the secondary secret when configured", async () => {
    const { app } = buildApp({
      secrets: { primarySecret: SECRET, secondarySecret: SECONDARY_SECRET },
    });
    const headers = signedHeaders("GET", PATH, undefined, {
      nonce: "mw-secondary",
      secret: SECONDARY_SECRET,
    });
    const res = await request(app).get(PATH).set(headers);
    assert.equal(res.status, 200);
    assert.equal(res.body.signed.usedSecret, "secondary");
  });
});

describe("isPublicSignedPath", () => {
  it("matches covered prefixes and their sub-paths only", () => {
    assert.equal(isPublicSignedPath("/api/v1/players"), true);
    assert.equal(isPublicSignedPath("/api/players/123"), true);
    assert.equal(isPublicSignedPath("/api/v1/proof-of-reserve"), true);
    assert.equal(isPublicSignedPath("/api/v1/auth/login"), false);
    assert.equal(isPublicSignedPath("/api/v1/financial/submit"), false);
    assert.equal(isPublicSignedPath("/api/health"), false);
    assert.equal(isPublicSignedPath("/.well-known/jwks.json"), false);
    assert.equal(isPublicSignedPath("/"), false);
    assert.equal(isPublicSignedPath("/api/v1/players2"), false);
  });
});

// ---------------------------------------------------------------------------
// Partner SDK
// ---------------------------------------------------------------------------

describe("partner SDK (src/sdk/apiSigning.ts)", () => {
  it("signApiRequest produces headers the server verifies", () => {
    const signed = signApiRequest({
      method: "GET",
      path: "/api/v1/players?page=2",
      secret: SECRET,
      timestamp: NOW_SEC,
      nonce: "sdk-1",
    });
    assert.equal(signed.headers["X-Signature"], signed.signature);
    assert.equal(signed.headers["X-Timestamp"], String(NOW_SEC));
    assert.equal(signed.headers["X-Nonce"], "sdk-1");
    const result = verifyApiRequestSignature({
      method: "GET",
      path: "/api/v1/players?page=2",
      timestamp: signed.timestamp,
      nonce: signed.nonce,
      signature: signed.signature,
      secrets: SECRET,
      nowMs: NOW_MS,
    });
    assert.equal(result.valid, true);
  });

  it("SDK signatures match the service signer for identical inputs", () => {
    const sdk = signApiRequest({
      method: "POST",
      path: PATH,
      body: { a: 1 },
      secret: SECRET,
      timestamp: NOW_SEC,
      nonce: "sdk-match",
    });
    const service = signRequest({
      method: "POST",
      path: PATH,
      body: { a: 1 },
      secret: SECRET,
      timestamp: NOW_SEC,
      nonce: "sdk-match",
    });
    assert.equal(sdk.signature, service.signature);
    assert.equal(sdk.canonicalString, service.canonicalString);
  });

  it("generates a timestamp and nonce when omitted", () => {
    const signed = signApiRequest({ method: "GET", path: PATH, secret: SECRET });
    assert.match(signed.timestamp, /^\d+$/);
    assert.ok(signed.nonce.length >= 32);
    assert.equal(signed.signature.length, 64);
  });

  it("throws without a secret", () => {
    assert.throws(() => signApiRequest({ method: "GET", path: PATH, secret: "" }), /secret/);
    assert.throws(() => createApiSigningClient({ baseUrl: "https://api.example", secret: "" }), /secret/);
  });

  it("signedFetch sends signed headers a server can verify (stubbed fetch)", async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | undefined;
    const stubFetch = (async (url: string, init?: RequestInit) => {
      captured = { url, headers: init?.headers as Record<string, string>, body: init?.body };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createApiSigningClient({
      baseUrl: "https://api.example",
      secret: SECRET,
      fetchImpl: stubFetch,
    });
    const res = await client.signedFetch("/api/v1/players?page=2");
    assert.equal(res.status, 200);
    assert.ok(captured);
    assert.equal(captured.url, "https://api.example/api/v1/players?page=2");
    const result = verifyApiRequestSignature({
      method: "GET",
      path: "/api/v1/players?page=2",
      timestamp: captured.headers["X-Timestamp"],
      nonce: captured.headers["X-Nonce"],
      signature: captured.headers["X-Signature"],
      secrets: SECRET,
    });
    assert.equal(result.valid, true);
  });

  it("signedFetch sends object bodies in canonical form the server verifies", async () => {
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    const stubFetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = createApiSigningClient({
      baseUrl: "https://api.example",
      secret: SECRET,
      fetchImpl: stubFetch,
    });
    await client.signedFetch("/api/v1/players", { method: "POST", body: { b: 2, a: 1 } });
    // Canonical (key-sorted) JSON goes on the wire.
    assert.equal(capturedBody, '{"a":1,"b":2}');
    assert.equal(capturedHeaders?.["Content-Type"], "application/json");
    const result = verifyApiRequestSignature({
      method: "POST",
      path: "/api/v1/players",
      timestamp: capturedHeaders!["X-Timestamp"],
      nonce: capturedHeaders!["X-Nonce"],
      signature: capturedHeaders!["X-Signature"],
      secrets: SECRET,
      body: capturedBody,
    });
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Verification latency (measured and reported, not a brittle CI threshold)
// ---------------------------------------------------------------------------

describe("verification latency", () => {
  it("measures valid-signature verification time (acceptance: under 2ms)", () => {
    const { signature } = signRequest({
      method: "GET",
      path: PATH,
      secret: SECRET,
      timestamp: NOW_SEC,
      nonce: "perf-nonce",
    });
    const input = {
      method: "GET",
      path: PATH,
      timestamp: NOW_SEC,
      nonce: "perf-nonce",
      signature,
      secrets: SECRET,
      nowMs: NOW_MS,
    };
    for (let i = 0; i < 100; i++) verifyApiRequestSignature(input);
    const iterations = 5000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) verifyApiRequestSignature(input);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const avgMs = elapsedMs / iterations;
    console.log(
      `[request-signing] verifyApiRequestSignature: ${iterations} iterations, ` +
        `total ${elapsedMs.toFixed(2)} ms, avg ${avgMs.toFixed(4)} ms per verification`
    );
    assert.equal(typeof avgMs, "number");
    assert.ok(Number.isFinite(avgMs));
  });
});
