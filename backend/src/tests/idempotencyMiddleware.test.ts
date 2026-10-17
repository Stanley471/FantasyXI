import test from "node:test";
import assert from "node:assert/strict";
import { DistributedIdempotencyManager } from "../middleware/idempotency.middleware.js";

test("DistributedIdempotencyManager: executes handler exactly once under 100 simultaneous concurrent requests", async () => {
  const manager = new DistributedIdempotencyManager();
  let ledgerMutationExecutions = 0;

  const payload = {
    leagueId: "league-escrow-99",
    stellarTxHash: "0xdeadbeef1234567890",
    amountUsdc: 100,
  };

  // Fire 100 simultaneous concurrent requests at the exact same millisecond
  const concurrentCalls = Array.from({ length: 100 }, () =>
    manager.executeIdempotent({
      idempotencyKey: "idem-key-100-concurrent",
      userId: "user-wallet-1",
      method: "POST",
      path: "/api/v1/leagues/league-escrow-99/payment/submit",
      body: payload,
      handler: async () => {
        ledgerMutationExecutions += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          statusCode: 201,
          body: {
            success: true,
            receiptId: "rcpt-001",
            amountUsdc: 100,
          },
        };
      },
    })
  );

  const outcomes = await Promise.all(concurrentCalls);

  // Underlying ledger mutation MUST have executed strictly once!
  assert.equal(ledgerMutationExecutions, 1);

  const primarySuccesses = outcomes.filter(
    (o) => o.statusCode === 201 && !o.replayed
  );
  const inProgressConflicts = outcomes.filter((o) => o.statusCode === 409);
  assert.equal(primarySuccesses.length, 1);
  assert.equal(inProgressConflicts.length, 99);

  // Subsequent retry after completion replays the exact cached 201 response without re-executing handler
  const replay = await manager.executeIdempotent({
    idempotencyKey: "idem-key-100-concurrent",
    userId: "user-wallet-1",
    method: "POST",
    path: "/api/v1/leagues/league-escrow-99/payment/submit",
    body: payload,
    handler: async () => {
      ledgerMutationExecutions += 1;
      return { statusCode: 201, body: { success: true, receiptId: "rcpt-002", amountUsdc: 100 } };
    },
  });

  assert.equal(ledgerMutationExecutions, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.body, {
    success: true,
    receiptId: "rcpt-001",
    amountUsdc: 100,
  });
});

test("DistributedIdempotencyManager: rejects payload mismatch with 422 and releases lock on transient 5xx failure", async () => {
  const manager = new DistributedIdempotencyManager();
  let attemptCount = 0;

  // 1. First attempt fails with transient 503 Horizon timeout
  const failedAttempt = await manager.executeIdempotent({
    idempotencyKey: "idem-key-transient",
    userId: "user-2",
    method: "POST",
    path: "/api/v1/payouts/claim",
    body: { amount: 250, asset: "USDC" },
    handler: async () => {
      attemptCount += 1;
      return {
        statusCode: 503,
        body: { success: false, message: "Stellar Horizon temporarily unavailable" },
      };
    },
  });
  assert.equal(failedAttempt.statusCode, 503);
  assert.equal(attemptCount, 1);

  // 2. Retry with the same key and payload succeeds because 5xx released the key
  const secondAttempt = await manager.executeIdempotent({
    idempotencyKey: "idem-key-transient",
    userId: "user-2",
    method: "POST",
    path: "/api/v1/payouts/claim",
    body: { amount: 250, asset: "USDC" },
    handler: async () => {
      attemptCount += 1;
      return {
        statusCode: 200,
        body: { success: true, txHash: "0xsettled250" },
      };
    },
  });
  assert.equal(secondAttempt.statusCode, 200);
  assert.equal(secondAttempt.replayed, false);
  assert.equal(attemptCount, 2);

  // 3. Reusing the same Idempotency-Key with a modified amount (500 instead of 250) is rejected with 422
  const tamperedAttempt = await manager.executeIdempotent({
    idempotencyKey: "idem-key-transient",
    userId: "user-2",
    method: "POST",
    path: "/api/v1/payouts/claim",
    body: { amount: 500, asset: "USDC" },
    handler: async () => {
      attemptCount += 1;
      return { statusCode: 200, body: { success: true } };
    },
  });
  assert.equal(tamperedAttempt.statusCode, 422);
  assert.equal(tamperedAttempt.payloadMismatch, true);
  assert.equal(attemptCount, 2);
});
