import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import { SorobanSubmissionStatus } from "@prisma/client";
import { SorobanTransactionReplayQueue } from "../services/financial/sorobanTransactionReplayQueue.js";
import { MemorySorobanReplayStore } from "./helpers/sorobanReplayStore.js";

function createSignedTransaction(
  keypair: Keypair,
  maxTime = Math.floor(Date.now() / 1000) + 30
): Transaction {
  const tx = new TransactionBuilder(
    new Account(keypair.publicKey(), "1"),
    { fee: "100", networkPassphrase: Networks.TESTNET }
  )
    .addOperation(Operation.manageData({ name: "replay", value: "test" }))
    .setTimebounds(0, maxTime)
    .build();
  tx.sign(keypair);
  return tx;
}

function missingTransaction(latestLedgerCloseTime: number) {
  return {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedger: 100,
    latestLedgerCloseTime,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
  };
}

function createQueue(
  server: Record<string, any>,
  store = new MemorySorobanReplayStore(),
  maxPollAttempts = 2
) {
  return {
    store,
    queue: new SorobanTransactionReplayQueue({
      server: server as unknown as rpc.Server,
      store,
      networkPassphrase: Networks.TESTNET,
      pollIntervalMs: 1,
      maxPollAttempts,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
    }),
  };
}

describe("Soroban transaction replay queue", () => {
  it("persists before submission and replays the same envelope after a gateway timeout", async () => {
    const keypair = Keypair.random();
    const tx = createSignedTransaction(keypair);
    const store = new MemorySorobanReplayStore();
    const envelopes: string[] = [];
    let sendCount = 0;
    let pollCount = 0;
    const server = {
      sendTransaction: async (submitted: Transaction) => {
        assert.equal(store.records.size, 1);
        assert.equal(
          [...store.records.values()][0].status,
          SorobanSubmissionStatus.PENDING_VERIFICATION
        );
        envelopes.push(submitted.toXDR());
        sendCount++;
        if (sendCount === 1) {
          throw new Error("504 Gateway Timeout");
        }
        return {
          status: "PENDING",
          hash: Buffer.from(submitted.hash()).toString("hex"),
        };
      },
      getTransaction: async () => {
        pollCount++;
        if (pollCount === 1) {
          return missingTransaction(Math.floor(Date.now() / 1000));
        }
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 101,
          returnValue: undefined,
        };
      },
      getAccount: async (publicKey: string) => new Account(publicKey, "1"),
    };
    const { queue } = createQueue(server, store);

    const result = await queue.submit(tx);

    assert.equal(result.success, true);
    assert.equal(result.status, SorobanSubmissionStatus.SUCCESS);
    assert.equal(result.sequence, tx.sequence);
    assert.equal(sendCount, 2);
    assert.deepEqual(envelopes, [tx.toXDR(), tx.toXDR()]);
    assert.deepEqual(
      store.transitions.map((transition) => transition.toStatus),
      [
        SorobanSubmissionStatus.PENDING_VERIFICATION,
        SorobanSubmissionStatus.PENDING_VERIFICATION,
        SorobanSubmissionStatus.SUBMITTED,
        SorobanSubmissionStatus.SUCCESS,
      ]
    );
    assert.equal(
      store.transitions.some((transition) => transition.reason === "504 Gateway Timeout"),
      true
    );
  });

  it("recovers a pending submission from the durable queue after the caller returns", async () => {
    const keypair = Keypair.random();
    const tx = createSignedTransaction(keypair);
    const serverStatus = { confirmed: false };
    let sendCount = 0;
    const server = {
      sendTransaction: async (submitted: Transaction) => {
        sendCount++;
        return {
          status: "PENDING",
          hash: Buffer.from(submitted.hash()).toString("hex"),
        };
      },
      getTransaction: async () =>
        serverStatus.confirmed
          ? {
              status: rpc.Api.GetTransactionStatus.SUCCESS,
              ledger: 108,
            }
          : missingTransaction(Math.floor(Date.now() / 1000)),
      getAccount: async (publicKey: string) => new Account(publicKey, "1"),
    };
    const { queue, store } = createQueue(server, undefined, 1);

    const firstResult = await queue.submit(tx);
    assert.equal(firstResult.pendingVerification, true);
    assert.equal(firstResult.status, SorobanSubmissionStatus.SUBMITTED);

    await new Promise((resolve) => setTimeout(resolve, 5));
    serverStatus.confirmed = true;
    assert.equal(await queue.processDueSubmissions(), 1);
    const finalRecord = await store.getByHash(firstResult.txHash);
    assert.equal(finalRecord?.status, SorobanSubmissionStatus.SUCCESS);
    assert.equal(finalRecord?.ledgerSeq, 108);
    assert.equal(sendCount, 2);
  });

  it("marks a transaction dropped only after expiry and unused account sequence are verified", async () => {
    const keypair = Keypair.random();
    const tx = createSignedTransaction(keypair, 1);
    let sendCount = 0;
    const server = {
      sendTransaction: async (submitted: Transaction) => {
        sendCount++;
        return {
          status: "PENDING",
          hash: Buffer.from(submitted.hash()).toString("hex"),
        };
      },
      getTransaction: async () =>
        missingTransaction(Math.floor(Date.now() / 1000)),
      getAccount: async (publicKey: string) => new Account(publicKey, "1"),
    };
    const { queue, store } = createQueue(server);

    const result = await queue.submit(tx);

    assert.equal(result.success, false);
    assert.equal(result.dropped, true);
    assert.equal(result.status, SorobanSubmissionStatus.DROPPED);
    assert.equal(sendCount, 1);
    assert.equal(
      [...store.records.values()][0].lastError,
      "Transaction expired and its sequence number remains unused"
    );
  });

  it("keeps expired transactions pending when the account sequence may have been consumed", async () => {
    const keypair = Keypair.random();
    const tx = createSignedTransaction(keypair, 1);
    let sendCount = 0;
    const server = {
      sendTransaction: async (submitted: Transaction) => {
        sendCount++;
        return {
          status: "PENDING",
          hash: Buffer.from(submitted.hash()).toString("hex"),
        };
      },
      getTransaction: async () =>
        missingTransaction(Math.floor(Date.now() / 1000)),
      getAccount: async (publicKey: string) =>
        new Account(publicKey, tx.sequence),
    };
    const { queue, store } = createQueue(server);

    const result = await queue.submit(tx);

    assert.equal(result.success, false);
    assert.equal(result.pendingVerification, true);
    assert.notEqual(result.status, SorobanSubmissionStatus.DROPPED);
    assert.equal(sendCount, 1);
    assert.match(
      [...store.records.values()][0].lastError ?? "",
      /Source sequence was consumed/
    );
  });
});
