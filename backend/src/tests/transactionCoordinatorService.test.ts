import test from "node:test";
import assert from "node:assert/strict";
import {
  TransactionCoordinatorService,
  TransactionStatusNotification,
  SorobanRpcGetTransactionResponse,
} from "../services/financial/transactionCoordinatorService.js";

test("TransactionCoordinatorService: polls pending Freighter tx with exponential backoff and dispatches CONFIRMED callbacks once", async () => {
  const wsEvents: TransactionStatusNotification[] = [];
  const webhookEvents: TransactionStatusNotification[] = [];

  let rpcCallCount = 0;
  const rpcResponses: SorobanRpcGetTransactionResponse[] = [
    { status: "NOT_FOUND" },
    { status: "NOT_FOUND" },
    { status: "SUCCESS", ledger: 812345 },
  ];

  const coordinator = new TransactionCoordinatorService({
    initialDelayMs: 1000,
    maxDelayMs: 16_000,
    maxPollAttempts: 6,
    maxPollDurationMs: 60_000,
    rpcGetTransaction: async () => {
      const res = rpcResponses[Math.min(rpcCallCount, rpcResponses.length - 1)];
      rpcCallCount += 1;
      return res;
    },
    onWebSocketNotify: (evt) => {
      wsEvents.push(evt);
    },
    onWebhookDispatch: (evt) => {
      webhookEvents.push(evt);
    },
  });

  const t0 = 1_700_000_000_000;
  const queued = await coordinator.enqueueTransaction({
    txHash: "tx-freighter-001",
    userId: "user-1",
    leagueId: "league-1",
    intent: "ENTRY_FEE_DEPOSIT",
    amountUsdc: 50,
    nowMs: t0,
  });
  assert.equal(queued.status, "SUBMITTED");
  assert.equal(queued.nextPollAtMs, t0 + 1000);
  assert.equal(wsEvents.length, 1);
  assert.equal(wsEvents[0].eventType, "freighter.tx.submitted");

  // Poll 1 -> NOT_FOUND, backoff = 1000 * 2^1 = 2000ms
  const p1 = await coordinator.pollTransactionOnce("tx-freighter-001", t0 + 1000);
  assert.equal(p1.status, "POLLING");
  assert.equal(p1.pollAttempts, 1);
  assert.equal(p1.nextPollAtMs, t0 + 1000 + 2000);

  // Poll 2 -> NOT_FOUND, backoff = 1000 * 2^2 = 4000ms
  const p2 = await coordinator.pollTransactionOnce("tx-freighter-001", t0 + 3000);
  assert.equal(p2.status, "POLLING");
  assert.equal(p2.pollAttempts, 2);
  assert.equal(p2.nextPollAtMs, t0 + 3000 + 4000);

  // Poll 3 -> SUCCESS at ledger 812345
  const p3 = await coordinator.pollTransactionOnce("tx-freighter-001", t0 + 7000);
  assert.equal(p3.status, "CONFIRMED");
  assert.equal(p3.ledgerSeq, 812345);
  assert.equal(webhookEvents.length, 1);
  assert.equal(webhookEvents[0].eventType, "freighter.tx.confirmed");
  assert.equal(wsEvents.length, 2);
  assert.equal(wsEvents[1].eventType, "freighter.tx.confirmed");

  // Extra poll after terminal state is a no-op and does not re-dispatch webhooks
  await coordinator.pollTransactionOnce("tx-freighter-001", t0 + 9000);
  assert.equal(webhookEvents.length, 1);
});

test("TransactionCoordinatorService: handles on-chain FAILED status and TIMED_OUT expiration", async () => {
  const webhookEvents: TransactionStatusNotification[] = [];

  const coordinator = new TransactionCoordinatorService({
    initialDelayMs: 500,
    maxDelayMs: 4000,
    maxPollAttempts: 3,
    maxPollDurationMs: 10_000,
    rpcGetTransaction: async (txHash) => {
      if (txHash === "tx-failed") {
        return {
          status: "FAILED",
          diagnosticError: "HostError: Error(Contract, #4) InsufficientTokenAllowance",
        };
      }
      return { status: "NOT_FOUND" };
    },
    onWebhookDispatch: (evt) => {
      webhookEvents.push(evt);
    },
  });

  const t0 = 2_000_000_000_000;
  await coordinator.enqueueTransaction({
    txHash: "tx-failed",
    userId: "user-2",
    leagueId: "league-2",
    intent: "PRIZE_SETTLEMENT",
    amountUsdc: 500,
    nowMs: t0,
  });

  const failedState = await coordinator.pollTransactionOnce("tx-failed", t0 + 500);
  assert.equal(failedState.status, "FAILED");
  assert.match(failedState.failureReason ?? "", /InsufficientTokenAllowance/);
  assert.equal(webhookEvents.length, 1);
  assert.equal(webhookEvents[0].eventType, "freighter.tx.failed");

  // Enqueue a tx that stays NOT_FOUND across all 3 maxPollAttempts -> TIMED_OUT
  await coordinator.enqueueTransaction({
    txHash: "tx-timeout",
    userId: "user-3",
    leagueId: "league-3",
    intent: "ENTRY_FEE_DEPOSIT",
    amountUsdc: 25,
    nowMs: t0,
  });

  await coordinator.pollTransactionOnce("tx-timeout", t0 + 500);
  await coordinator.pollTransactionOnce("tx-timeout", t0 + 1500);
  const timedOut = await coordinator.pollTransactionOnce("tx-timeout", t0 + 3500);

  assert.equal(timedOut.status, "TIMED_OUT");
  assert.equal(webhookEvents.length, 2);
  assert.equal(webhookEvents[1].eventType, "freighter.tx.timed_out");
});
