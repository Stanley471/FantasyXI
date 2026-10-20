import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ZeroLossTransactionReplayQueue,
  ZeroLossLedgerDbAdapter,
  ZeroLossSorobanRpcEndpoint,
} from "../services/financial/sorobanErrorRecovery.js";

function createMockDbLedger() {
  const records = new Map<
    string,
    {
      status: string;
      txHash: string;
      sequenceNumber: string;
      ledgerSeq?: number;
      confirmedAt?: Date;
      reason?: string;
    }
  >();

  const adapter: ZeroLossLedgerDbAdapter = {
    async markTransactionPendingVerification({
      ledgerRecordId,
      txHash,
      sequenceNumber,
    }) {
      records.set(ledgerRecordId, {
        status: "PENDING_VERIFICATION",
        txHash,
        sequenceNumber,
      });
    },
    async markTransactionSuccess({
      ledgerRecordId,
      txHash,
      sequenceNumber,
      ledgerSeq,
      confirmedAt,
    }) {
      records.set(ledgerRecordId, {
        status: "SUCCESS",
        txHash,
        sequenceNumber,
        ledgerSeq,
        confirmedAt,
      });
    },
    async markTransactionFailed({ ledgerRecordId, txHash, reason }) {
      const prev = records.get(ledgerRecordId);
      records.set(ledgerRecordId, {
        status: "FAILED",
        txHash,
        sequenceNumber: prev?.sequenceNumber ?? "0",
        reason,
      });
    },
  };

  return { records, adapter };
}

describe("Zero-Loss Transaction Replay Queue (#344)", () => {
  it("transitions state to PENDING_VERIFICATION on HTTP 504 gateway timeout during submission and confirms on delayed RPC success", async () => {
    let currentTime = new Date("2026-10-20T10:00:00.000Z");
    const { records, adapter } = createMockDbLedger();

    let pollCount = 0;
    const rpc: ZeroLossSorobanRpcEndpoint = {
      async sendTransaction() {
        throw new Error("504 Gateway Timeout: Soroban RPC upstream timed out");
      },
      async getTransaction(txHash: string) {
        pollCount += 1;
        assert.equal(txHash, "tx-hash-timeout-1");
        if (pollCount === 1) {
          return { status: "PENDING" };
        }
        return { status: "SUCCESS", ledger: 88_420 };
      },
    };

    const queue = new ZeroLossTransactionReplayQueue({
      rpc,
      dbAdapter: adapter,
      basePollDelayMs: 500,
      backoffFactor: 2,
      clock: () => currentTime,
    });

    const tx = await queue.submitTransaction({
      id: "tx-timeout-1",
      idempotencyKey: "idem-timeout-1",
      ledgerRecordId: "db-ledger-1",
      txHash: "tx-hash-timeout-1",
      sourceAccount: "GADMIN_TREASURY_1",
      sequenceNumber: "50001",
      payload: { intentType: "SETTLEMENT", leagueId: "league-1" },
    });

    // Must transition to PENDING_VERIFICATION, NOT FAILED
    assert.equal(tx.status, "PENDING_VERIFICATION");
    assert.equal(records.get("db-ledger-1")?.status, "PENDING_VERIFICATION");
    assert.equal(tx.transitions.length, 2);
    assert.equal(tx.transitions[0].to, "SUBMITTING");
    assert.equal(tx.transitions[1].to, "PENDING_VERIFICATION");

    // Advance clock 500ms -> 1st poll returns PENDING, exponential backoff schedules next at +1000ms
    currentTime = new Date(currentTime.getTime() + 500);
    const poll1 = await queue.pollOnce(currentTime);
    assert.deepEqual(poll1.stillPending, ["tx-timeout-1"]);
    assert.equal(tx.status, "PENDING_VERIFICATION");
    assert.equal(records.get("db-ledger-1")?.status, "PENDING_VERIFICATION");

    // Advance clock 1000ms -> 2nd poll returns SUCCESS at ledger 88,420
    currentTime = new Date(currentTime.getTime() + 1000);
    const poll2 = await queue.pollOnce(currentTime);
    assert.deepEqual(poll2.confirmed, ["tx-timeout-1"]);
    assert.equal(tx.status, "SUCCESS");
    assert.equal(tx.confirmedLedger, 88_420);

    // DB ledger record updated to SUCCESS within SLA
    const dbRec = records.get("db-ledger-1");
    assert.ok(dbRec);
    assert.equal(dbRec.status, "SUCCESS");
    assert.equal(dbRec.ledgerSeq, 88_420);
    assert.equal(dbRec.txHash, "tx-hash-timeout-1");
  });

  it("detects dropped transactions and safely retries with incremented sequence numbers without collisions", async () => {
    let currentTime = new Date("2026-10-20T10:05:00.000Z");
    const { records, adapter } = createMockDbLedger();

    const confirmedHashes = new Set<string>();
    const rpc: ZeroLossSorobanRpcEndpoint = {
      async sendTransaction() {
        return { status: "PENDING" };
      },
      async getTransaction(txHash: string) {
        if (confirmedHashes.has(txHash)) {
          return { status: "SUCCESS", ledger: 90_100 };
        }
        return { status: "NOT_FOUND" };
      },
    };

    const assignedSequences: string[] = [];
    const queue = new ZeroLossTransactionReplayQueue({
      rpc,
      dbAdapter: adapter,
      basePollDelayMs: 200,
      notFoundDropThreshold: 2,
      clock: () => currentTime,
      resubmitter: {
        async rebuildAndSubmit({ tx, nextSequenceNumber }) {
          assignedSequences.push(nextSequenceNumber);
          const replayedHash = `${tx.id}-replayed-seq-${nextSequenceNumber}`;
          confirmedHashes.add(replayedHash);
          return {
            txHash: replayedHash,
            sequenceNumber: nextSequenceNumber,
            status: "PENDING",
          };
        },
      },
    });

    // Submit 2 concurrent transactions from the same sourceAccount
    const txA = await queue.submitTransaction({
      id: "tx-drop-A",
      idempotencyKey: "idem-drop-A",
      ledgerRecordId: "db-drop-A",
      txHash: "hash-initial-A",
      sourceAccount: "GSHARED_ESCROW_SIGNER",
      sequenceNumber: "1000",
    });

    const txB = await queue.submitTransaction({
      id: "tx-drop-B",
      idempotencyKey: "idem-drop-B",
      ledgerRecordId: "db-drop-B",
      txHash: "hash-initial-B",
      sourceAccount: "GSHARED_ESCROW_SIGNER",
      sequenceNumber: "1001",
    });

    assert.equal(txA.status, "PENDING_VERIFICATION");
    assert.equal(txB.status, "PENDING_VERIFICATION");

    // Poll 1: both return NOT_FOUND (1/2 threshold)
    currentTime = new Date(currentTime.getTime() + 200);
    await queue.pollOnce(currentTime);
    assert.equal(txA.status, "PENDING_VERIFICATION");
    assert.equal(txB.status, "PENDING_VERIFICATION");

    // Poll 2: both reach NOT_FOUND threshold (2/2), transition to DROPPED, and re-submit with collision-free sequences 1002 and 1003!
    currentTime = new Date(currentTime.getTime() + 400);
    const pollDrop = await queue.pollOnce(currentTime);
    assert.deepEqual(pollDrop.replayed, ["tx-drop-A", "tx-drop-B"]);
    assert.deepEqual(assignedSequences, ["1002", "1003"]);
    assert.equal(new Set(assignedSequences).size, 2, "Sequence numbers must never collide");
    assert.equal(txA.sequenceNumber, "1002");
    assert.equal(txB.sequenceNumber, "1003");
    assert.ok(txA.transitions.some((t) => t.to === "DROPPED"));
    assert.ok(txB.transitions.some((t) => t.to === "DROPPED"));

    // Poll 3: replayed transactions confirm on-chain and update DB records to SUCCESS
    currentTime = new Date(currentTime.getTime() + 200);
    const pollConfirm = await queue.pollOnce(currentTime);
    assert.deepEqual(pollConfirm.confirmed, ["tx-drop-A", "tx-drop-B"]);
    assert.equal(txA.status, "SUCCESS");
    assert.equal(txB.status, "SUCCESS");
    assert.equal(records.get("db-drop-A")?.status, "SUCCESS");
    assert.equal(records.get("db-drop-B")?.status, "SUCCESS");
  });

  it("preserves PENDING_VERIFICATION during transient RPC polling timeouts and deduplicates by idempotencyKey", async () => {
    let currentTime = new Date("2026-10-20T10:10:00.000Z");
    const { records, adapter } = createMockDbLedger();

    let rpcShouldTimeout = true;
    const rpc: ZeroLossSorobanRpcEndpoint = {
      async sendTransaction() {
        return { status: "PENDING" };
      },
      async getTransaction() {
        if (rpcShouldTimeout) {
          throw new Error("ETIMEDOUT: Soroban RPC socket hang up");
        }
        return { status: "SUCCESS", ledger: 91_000 };
      },
    };

    const queue = new ZeroLossTransactionReplayQueue({
      rpc,
      dbAdapter: adapter,
      basePollDelayMs: 100,
      clock: () => currentTime,
    });

    const first = await queue.submitTransaction({
      id: "tx-resilient-1",
      idempotencyKey: "idem-resilient-1",
      ledgerRecordId: "db-resilient-1",
      txHash: "hash-resilient-1",
      sourceAccount: "GADMIN",
      sequenceNumber: "700",
    });

    // Duplicate submission with same idempotencyKey returns existing tracked transaction
    const duplicate = await queue.submitTransaction({
      id: "tx-resilient-dup",
      idempotencyKey: "idem-resilient-1",
      ledgerRecordId: "db-resilient-1",
      txHash: "hash-resilient-dup",
      sourceAccount: "GADMIN",
      sequenceNumber: "701",
    });
    assert.equal(duplicate.id, first.id);

    // Poll while RPC throws ETIMEDOUT -> must remain PENDING_VERIFICATION
    currentTime = new Date(currentTime.getTime() + 100);
    const pollTimeout = await queue.pollOnce(currentTime);
    assert.deepEqual(pollTimeout.stillPending, ["tx-resilient-1"]);
    assert.equal(first.status, "PENDING_VERIFICATION");
    assert.equal(records.get("db-resilient-1")?.status, "PENDING_VERIFICATION");

    // RPC recovers -> next poll confirms transaction to SUCCESS
    rpcShouldTimeout = false;
    currentTime = new Date(currentTime.getTime() + 200);
    const pollRecovered = await queue.pollOnce(currentTime);
    assert.deepEqual(pollRecovered.confirmed, ["tx-resilient-1"]);
    assert.equal(first.status, "SUCCESS");
    assert.equal(records.get("db-resilient-1")?.status, "SUCCESS");

    queue.start(60_000);
    queue.stop();
  });
});
