import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import {
  WalletDepositRateLimiter,
  resetAllRateLimiters,
} from "../middleware/rateLimiter.js";

function createWalletMockReqRes(params: {
  ip?: string;
  walletAddress?: string;
  userId?: string;
}) {
  let statusCode = 200;
  let jsonBody: any = null;
  let nextCalled = false;
  const headers: Record<string, string> = {};

  const req = {
    ip: params.ip ?? "10.0.0.1",
    headers: params.ip ? { "x-forwarded-for": params.ip } : {},
    body: params.walletAddress ? { stellarAddress: params.walletAddress } : {},
    query: {},
    user: params.userId ? { id: params.userId, email: "u@test.com", username: "u" } : undefined,
    socket: { remoteAddress: params.ip ?? "10.0.0.1" },
  } as unknown as Request;

  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: any) => {
      jsonBody = payload;
      return res;
    },
  } as unknown as Response;

  const next: NextFunction = () => {
    nextCalled = true;
  };

  return {
    req,
    res,
    next,
    getStatusCode: () => statusCode,
    getJsonBody: () => jsonBody,
    wasNextCalled: () => nextCalled,
    getHeaders: () => headers,
  };
}

describe("WalletDepositRateLimiter (Issue #233)", () => {
  beforeEach(() => {
    resetAllRateLimiters();
  });

  it("enforces max 5 deposit verification attempts per wallet address per minute across rotating IP addresses", () => {
    const limiter = new WalletDepositRateLimiter({
      windowMs: 60_000,
      maxWalletRequestsPerWindow: 5,
    });
    const middleware = limiter.middleware();
    const targetWallet = "G" + "A".repeat(55);

    // Send 5 requests from 5 different IP addresses for the same wallet -> all 5 pass
    for (let i = 1; i <= 5; i++) {
      const ctx = createWalletMockReqRes({
        ip: `192.168.1.${i}`,
        walletAddress: targetWallet,
        userId: `user_${i}`,
      });
      middleware(ctx.req, ctx.res, ctx.next);
      assert.equal(ctx.wasNextCalled(), true);
      assert.equal(ctx.getStatusCode(), 200);
    }

    // 6th request from a brand new 6th IP address for the same wallet -> 429 Too Many Requests
    const blockedCtx = createWalletMockReqRes({
      ip: "203.0.113.99",
      walletAddress: targetWallet,
      userId: "user_6",
    });
    middleware(blockedCtx.req, blockedCtx.res, blockedCtx.next);
    assert.equal(blockedCtx.wasNextCalled(), false);
    assert.equal(blockedCtx.getStatusCode(), 429);
    assert.equal(blockedCtx.getJsonBody().error, "Too Many Requests");
    assert.equal(blockedCtx.getJsonBody().code, "WALLET_RATE_LIMIT_EXCEEDED");
    assert.ok(Number(blockedCtx.getHeaders()["Retry-After"]) > 0);
  });

  it("temporarily locks out a wallet address after 3 consecutive non-existent transaction hashes", async () => {
    const limiter = new WalletDepositRateLimiter({
      windowMs: 60_000,
      maxWalletRequestsPerWindow: 5,
      maxConsecutiveNonExistentTx: 3,
      lockoutDurationMs: 600_000, // 10 minutes
    });
    const middleware = limiter.middleware();
    const scannerWallet = "G" + "B".repeat(55);

    // Record 2 non-existent tx hashes -> not locked yet
    const attempt1 = await limiter.recordTransactionLookupOutcome({
      walletAddress: scannerWallet,
      txExists: false,
    });
    assert.equal(attempt1.lockedOut, false);
    assert.equal(attempt1.consecutiveFailures, 1);

    const attempt2 = await limiter.recordTransactionLookupOutcome({
      walletAddress: scannerWallet,
      txExists: false,
    });
    assert.equal(attempt2.lockedOut, false);
    assert.equal(attempt2.consecutiveFailures, 2);

    // 3rd consecutive non-existent tx hash -> triggers temporary lockout
    const attempt3 = await limiter.recordTransactionLookupOutcome({
      walletAddress: scannerWallet,
      txExists: false,
    });
    assert.equal(attempt3.lockedOut, true);
    assert.equal(attempt3.consecutiveFailures, 3);
    assert.equal(attempt3.retryAfterSeconds, 600);

    // Subsequent middleware call for the locked wallet immediately returns 429 with Retry-After
    const lockedReq = createWalletMockReqRes({
      ip: "172.16.0.50",
      walletAddress: scannerWallet,
      userId: "user_scanner",
    });
    middleware(lockedReq.req, lockedReq.res, lockedReq.next);
    assert.equal(lockedReq.wasNextCalled(), false);
    assert.equal(lockedReq.getStatusCode(), 429);
    assert.equal(lockedReq.getJsonBody().code, "WALLET_LOCKED_NON_EXISTENT_TX");
    assert.ok(Number(lockedReq.getHeaders()["Retry-After"]) > 0);
  });

  it("resets the consecutive non-existent counter when a valid transaction hash is verified", async () => {
    const limiter = new WalletDepositRateLimiter({
      maxConsecutiveNonExistentTx: 3,
    });
    const wallet = "G" + "C".repeat(55);

    await limiter.recordTransactionLookupOutcome({ walletAddress: wallet, txExists: false });
    await limiter.recordTransactionLookupOutcome({ walletAddress: wallet, txExists: false });
    // Valid transaction resets streak
    const resetResult = await limiter.recordTransactionLookupOutcome({
      walletAddress: wallet,
      txExists: true,
    });
    assert.equal(resetResult.lockedOut, false);
    assert.equal(resetResult.consecutiveFailures, 0);

    // Next single failure is count 1, not 3
    const nextFailure = await limiter.recordTransactionLookupOutcome({
      walletAddress: wallet,
      txExists: false,
    });
    assert.equal(nextFailure.lockedOut, false);
    assert.equal(nextFailure.consecutiveFailures, 1);
  });
});
