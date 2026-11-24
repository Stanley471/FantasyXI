import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  CRITICAL_TTL_THRESHOLD_LEDGERS,
  DEFAULT_EXTEND_TO_LEDGERS,
  SOROBAN_TTL_EXTENSION_CRON,
  SOROBAN_TTL_EXTENSION_JOB_NAME,
  SorobanTtlExtensionWorker,
} from "../jobs/sorobanTtlExtension.js";
import { JOB_DEFINITIONS } from "../queues/jobQueue.js";

test("Soroban TTL Extension Worker (Issue #548)", async (t) => {
  await t.test("is registered in JOB_DEFINITIONS with 12-hour schedule", () => {
    const job = JOB_DEFINITIONS.find((j) => j.name === SOROBAN_TTL_EXTENSION_JOB_NAME);
    assert.ok(job, "soroban-ttl-extension job must be registered in JOB_DEFINITIONS");
    assert.equal(job.cron, SOROBAN_TTL_EXTENSION_CRON);
    assert.equal(job.cron, "0 */12 * * *");
  });

  await t.test("defines safe critical threshold at 100,000 ledgers and extend boundary at 518,400 ledgers", () => {
    assert.equal(CRITICAL_TTL_THRESHOLD_LEDGERS, 100_000);
    assert.equal(DEFAULT_EXTEND_TO_LEDGERS, 518_400);
  });

  await t.test("identifies contracts needing bump when remaining TTL < 100,000 ledgers", async () => {
    const maintenanceKeypair = Keypair.random();
    const mockServer = {
      getLatestLedger: async () => ({ sequence: 1_000_000 }),
      getLedgerEntries: async () => ({
        entries: [
          {
            liveUntilLedgerSeq: 1_050_000, // 50,000 remaining (< 100,000 threshold)
          },
        ],
      }),
    };

    const worker = new SorobanTtlExtensionWorker({
      server: mockServer,
      maintenanceKeypair,
    });

    const testContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const key = worker.getContractInstanceLedgerKey(testContract);
    const result = await worker.inspectEntryTtl(testContract, key);

    assert.equal(result.currentLedgerSeq, 1_000_000);
    assert.equal(result.liveUntilLedgerSeq, 1_050_000);
    assert.equal(result.remainingTtlLedgers, 50_000);
    assert.equal(result.needsBump, true);
  });

  await t.test("skips healthy contracts when remaining TTL >= 100,000 ledgers", async () => {
    const maintenanceKeypair = Keypair.random();
    const mockServer = {
      getLatestLedger: async () => ({ sequence: 1_000_000 }),
      getLedgerEntries: async () => ({
        entries: [
          {
            liveUntilLedgerSeq: 1_350_000, // 350,000 remaining (>= 100,000 threshold)
          },
        ],
      }),
    };

    const worker = new SorobanTtlExtensionWorker({
      server: mockServer,
      maintenanceKeypair,
    });

    const testContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const key = worker.getContractInstanceLedgerKey(testContract);
    const result = await worker.inspectEntryTtl(testContract, key);

    assert.equal(result.remainingTtlLedgers, 350_000);
    assert.equal(result.needsBump, false);
  });

  await t.test("flags entry for bump if not present in ledger entries (expired/uninitialized)", async () => {
    const maintenanceKeypair = Keypair.random();
    const mockServer = {
      getLatestLedger: async () => ({ sequence: 1_000_000 }),
      getLedgerEntries: async () => ({ entries: [] }),
    };

    const worker = new SorobanTtlExtensionWorker({
      server: mockServer,
      maintenanceKeypair,
    });

    const testContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const key = worker.getContractInstanceLedgerKey(testContract);
    const result = await worker.inspectEntryTtl(testContract, key);

    assert.equal(result.remainingTtlLedgers, 0);
    assert.equal(result.needsBump, true);
  });

  await t.test("executes extendFootprintTtl and logs transaction hash and gas consumption", async () => {
    const maintenanceKeypair = Keypair.random();
    let sentTx: any = null;

    const mockServer = {
      getAccount: async () => ({
        sequenceNumber: () => "100",
        incrementSequenceNumber: () => {},
        accountId: () => maintenanceKeypair.publicKey(),
      }),
      sendTransaction: async (tx: any) => {
        sentTx = tx;
        return {
          status: "PENDING",
          hash: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
        };
      },
    };

    const worker = new SorobanTtlExtensionWorker({
      server: mockServer,
      maintenanceKeypair,
    });

    const testContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const key = worker.getContractInstanceLedgerKey(testContract);
    const res = await worker.executeExtendTtl([key], 518_400);

    assert.equal(res.success, true);
    assert.equal(res.txHash, "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5");
    assert.ok(res.gasFeeStroops > 0, "Gas fee must be recorded");
    assert.ok(sentTx, "Transaction must have been submitted to server");
  });

  await t.test("run() scans contracts, bumps only critical ones, and aggregates logs and metrics", async () => {
    const maintenanceKeypair = Keypair.random();
    const contractExpiring = "CCLTJSNCE6MR7PF6MP7RR3KJDF4BWX6X7Z7ZI7WADXQZKMEPLG6DU5AO";
    const contractHealthy = "CDUD2QH34XKDAAZ5UFAV4WLFDLHELY4NCZIX22FGTRLXKFLDWRVNDPDQ";

    const mockDb = {
      league: {
        findMany: async () => [
          { contractAddress: contractExpiring },
          { contractAddress: contractHealthy },
        ],
      },
    };

    let callCount = 0;
    const mockServer = {
      getLatestLedger: async () => ({ sequence: 1_000_000 }),
      getLedgerEntries: async () => {
        callCount++;
        // First contract expiring (< 100k), second contract healthy (>= 100k)
        if (callCount === 1) {
          return { entries: [{ liveUntilLedgerSeq: 1_060_000 }] }; // 60,000 remaining (< 100k)
        }
        return { entries: [{ liveUntilLedgerSeq: 1_400_000 }] }; // 400,000 remaining (>= 100k)
      },
      getAccount: async () => ({
        sequenceNumber: () => "200",
        incrementSequenceNumber: () => {},
        accountId: () => maintenanceKeypair.publicKey(),
      }),
      sendTransaction: async () => ({
        status: "PENDING",
        hash: "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344",
      }),
    };

    const worker = new SorobanTtlExtensionWorker({
      db: mockDb,
      server: mockServer,
      maintenanceKeypair,
    });

    const summary = await worker.run();

    assert.equal(summary.inspectedCount, 2);
    assert.equal(summary.bumpedCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.operations.length, 1);
    assert.equal(summary.operations[0].contractId, contractExpiring);
    assert.equal(summary.operations[0].previousRemainingTtl, 60_000);
    assert.equal(summary.operations[0].extendedByLedgers, 518_400);
    assert.equal(summary.operations[0].txHash, "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344");
    assert.ok(summary.operations[0].gasFeeStroops > 0);
  });
});
