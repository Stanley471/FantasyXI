import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { RequestHandler } from "express";
import { Server } from "node:http";
import type { Redis } from "ioredis";
import {
  createWalletRateLimiter,
  MemorySlidingWindowStore,
  MemoryWalletScanGuardStore,
  RedisWalletScanGuardStore,
  WalletRateLimiterOptions,
} from "../middleware/rateLimiter.js";
import { UserRole } from "../types/index.js";

const WALLET_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const WALLET_B = "GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB";

/**
 * Builds a small app: a fake auth layer (user from x-user-id), the wallet
 * limiter, and a handler that reports the outcome given in x-outcome.
 */
function buildApp(options: WalletRateLimiterOptions): Server {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  const fakeAuth: RequestHandler = (req, _res, next) => {
    const id = req.header("x-user-id");
    if (id) req.user = { id, email: `${id}@test.dev`, role: UserRole.USER } as any;
    next();
  };
  app.post("/verify", fakeAuth, createWalletRateLimiter(options), (req, res) => {
    const outcome = req.header("x-outcome");
    if (outcome) res.locals.depositVerificationOutcome = outcome;
    res.status(outcome === "not_found" ? 422 : 200).json({ success: outcome !== "not_found" });
  });
  return app.listen(0);
}

async function post(
  server: Server,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server not running");
  const res = await fetch(`http://127.0.0.1:${address.port}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

/** Lets the limiter's post-response hook settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("Wallet-keyed deposit verification rate limiter (#233)", () => {
  it("caps a wallet at 5 requests per minute even across different IPs and users", async () => {
    const server = buildApp({
      store: new MemorySlidingWindowStore(),
      scanGuard: new MemoryWalletScanGuardStore(),
      resolveWallet: () => undefined,
    });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await post(server, { stellarAddress: WALLET_A }, {
          "X-Forwarded-For": `198.51.100.${i + 1}`,
          "x-user-id": `user-${i}`,
        });
        assert.equal(res.status, 200, `request ${i + 1} should pass`);
      }

      const blocked = await post(server, { stellarAddress: WALLET_A }, {
        "X-Forwarded-For": "198.51.100.99",
        "x-user-id": "user-99",
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.success, false);
      const retryAfter = Number(blocked.headers.get("retry-after"));
      assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After was ${retryAfter}`);
      assert.equal(blocked.body.retryAfter, retryAfter);
    } finally {
      server.close();
    }
  });

  it("rejects concurrent requests for the same wallet beyond the quota", async () => {
    const server = buildApp({
      store: new MemorySlidingWindowStore(),
      scanGuard: new MemoryWalletScanGuardStore(),
      resolveWallet: () => undefined,
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          post(server, { stellarAddress: WALLET_A }, { "X-Forwarded-For": `203.0.113.${i + 1}` })
        )
      );
      assert.equal(results.filter((r) => r.status === 200).length, 5);
      assert.equal(results.filter((r) => r.status === 429).length, 15);
      for (const r of results.filter((x) => x.status === 429)) {
        assert.ok(r.headers.get("retry-after"));
      }
    } finally {
      server.close();
    }
  });

  it("does not block other wallets or normal usage", async () => {
    const server = buildApp({
      store: new MemorySlidingWindowStore(),
      scanGuard: new MemoryWalletScanGuardStore(),
      resolveWallet: () => undefined,
    });
    try {
      for (let i = 0; i < 5; i++) {
        await post(server, { stellarAddress: WALLET_A }, { "X-Forwarded-For": "192.0.2.1" });
      }
      const other = await post(server, { stellarAddress: WALLET_B }, {
        "X-Forwarded-For": "192.0.2.2",
        "x-outcome": "found",
      });
      assert.equal(other.status, 200);
      assert.equal(other.headers.get("x-ratelimit-limit"), "5");
      assert.equal(other.headers.get("x-ratelimit-remaining"), "4");
    } finally {
      server.close();
    }
  });

  it("uses the user's linked wallet when the body has no address", async () => {
    const server = buildApp({
      store: new MemorySlidingWindowStore(),
      scanGuard: new MemoryWalletScanGuardStore(),
      resolveWallet: (req) => (req.user?.id === "linked" ? WALLET_B : undefined),
      userLimit: 100,
    });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await post(server, { stellarTxHash: "a".repeat(64) }, {
          "x-user-id": "linked",
          "X-Forwarded-For": `10.0.0.${i + 1}`,
        });
        assert.equal(res.status, 200);
      }
      const blocked = await post(server, { stellarAddress: WALLET_B }, { "X-Forwarded-For": "10.0.1.1" });
      assert.equal(blocked.status, 429, "the linked wallet and body wallet share one bucket");
    } finally {
      server.close();
    }
  });

  it("enforces the per-user bucket when no wallet can be resolved", async () => {
    const server = buildApp({
      store: new MemorySlidingWindowStore(),
      scanGuard: new MemoryWalletScanGuardStore(),
      resolveWallet: () => undefined,
      userLimit: 3,
    });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await post(server, {}, { "x-user-id": "u1", "X-Forwarded-For": `10.1.0.${i}` });
        assert.equal(res.status, 200);
      }
      const blocked = await post(server, {}, { "x-user-id": "u1", "X-Forwarded-For": "10.1.0.9" });
      assert.equal(blocked.status, 429);
    } finally {
      server.close();
    }
  });

  it("locks out a wallet after 3 consecutive non-existent transaction hashes", async () => {
    const server = buildApp({
      store: new MemorySlidingWindowStore(),
      scanGuard: new MemoryWalletScanGuardStore(),
      resolveWallet: () => undefined,
      walletLimit: 100,
      lockoutMs: 10 * 60_000,
    });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await post(server, { stellarAddress: WALLET_A }, { "x-outcome": "not_found" });
        assert.equal(res.status, 422);
        await flush();
      }
      const locked = await post(server, { stellarAddress: WALLET_A }, { "x-outcome": "found" });
      assert.equal(locked.status, 429);
      assert.match(locked.body.message, /locked/);
      const retryAfter = Number(locked.headers.get("retry-after"));
      assert.ok(retryAfter > 590 && retryAfter <= 600, `Retry-After was ${retryAfter}`);

      const otherWallet = await post(server, { stellarAddress: WALLET_B }, { "x-outcome": "found" });
      assert.equal(otherWallet.status, 200);
    } finally {
      server.close();
    }
  });

  it("resets the miss streak when a real transaction is found", async () => {
    const server = buildApp({
      store: new MemorySlidingWindowStore(),
      scanGuard: new MemoryWalletScanGuardStore(),
      resolveWallet: () => undefined,
      walletLimit: 100,
    });
    try {
      for (const outcome of ["not_found", "not_found", "found", "not_found", "not_found"]) {
        await post(server, { stellarAddress: WALLET_A }, { "x-outcome": outcome });
        await flush();
      }
      const res = await post(server, { stellarAddress: WALLET_A }, { "x-outcome": "found" });
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });

  it("expires the lockout after the configured duration", async () => {
    let now = 1_000_000;
    const guard = new MemoryWalletScanGuardStore(() => now);
    for (let i = 0; i < 2; i++) {
      assert.equal(await guard.recordMiss(WALLET_A, 3, 5_000, 60_000), 0);
    }
    assert.equal(await guard.recordMiss(WALLET_A, 3, 5_000, 60_000), 5_000);
    assert.equal(await guard.lockRemainingMs(WALLET_A), 5_000);
    now += 4_999;
    assert.equal(await guard.lockRemainingMs(WALLET_A), 1);
    now += 1;
    assert.equal(await guard.lockRemainingMs(WALLET_A), 0);
  });

  it("forgets misses that are older than the miss window", async () => {
    let now = 0;
    const guard = new MemoryWalletScanGuardStore(() => now);
    await guard.recordMiss(WALLET_A, 3, 5_000, 1_000);
    await guard.recordMiss(WALLET_A, 3, 5_000, 1_000);
    now = 2_000;
    assert.equal(await guard.recordMiss(WALLET_A, 3, 5_000, 1_000), 0);
  });

  it("records Redis misses atomically in one Lua call with hashed keys", async () => {
    const calls: unknown[][] = [];
    const redis = {
      eval: async (...args: unknown[]) => {
        calls.push(args);
        return 900_000;
      },
      pttl: async () => -2,
      del: async () => 1,
    } as unknown as Redis;
    const guard = new RedisWalletScanGuardStore(redis);

    assert.equal(await guard.recordMiss(WALLET_A, 3, 900_000, 900_000), 900_000);
    assert.equal(await guard.lockRemainingMs(WALLET_A), 0);
    assert.equal(calls.length, 1);
    const [, keyCount, missKey, lockKey, threshold] = calls[0] as [string, number, string, string, string];
    assert.equal(keyCount, 2);
    assert.ok(!missKey.includes(WALLET_A), "wallet addresses are hashed in keys");
    assert.match(missKey, /^fantasyxi:scan:\{[0-9a-f]{64}\}:misses$/);
    assert.match(lockKey, /^fantasyxi:scan:\{[0-9a-f]{64}\}:lock$/);
    assert.equal(threshold, "3");
  });
});
