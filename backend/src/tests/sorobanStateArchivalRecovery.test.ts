import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Address,
  SorobanDataBuilder,
  Keypair,
  Networks,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  SorobanStateArchivalRecoveryService,
  EntryTtlStatus,
} from "../services/financial/sorobanStateArchivalRecovery.js";
import { SorobanStorageRentMonitorDaemon } from "../workers/sorobanStorageRentMonitor.js";
import { AdminAlert, AdminAlertResult } from "../services/notifications/adminAlertNotifier.js";

class MockAlertNotifier {
  public alerts: AdminAlert[] = [];
  public async notify(alert: AdminAlert): Promise<AdminAlertResult> {
    this.alerts.push(alert);
    return { slack: "skipped", email: { sent: 0, failed: 0 } };
  }
}

class MockSigner {
  public signedTransactions: any[] = [];
  public async publicKey(secret: string): Promise<string> {
    return Keypair.fromSecret(secret).publicKey();
  }
  public async sign(tx: any, secret: string): Promise<void> {
    this.signedTransactions.push(tx);
    const kp = Keypair.fromSecret(secret);
    tx.sign(kp);
  }
}

function createMockRpcServer(options?: {
  currentLedger?: number;
  entries?: Record<string, { liveUntilLedgerSeq?: number; lastModifiedLedgerSeq?: number }>;
  accountBalances?: Record<string, string>;
  simulateError?: string;
  txSuccess?: boolean;
}) {
  const currentLedger = options?.currentLedger ?? 100_000;
  const entriesMap = options?.entries ?? {};
  const accountBalances = options?.accountBalances ?? {};

  return {
    async getLatestLedger() {
      return {
        id: "mock-ledger-id",
        protocolVersion: 22,
        sequence: currentLedger,
      };
    },
    async getLedgerEntries(...keys: any[]) {
      const returned: any[] = [];
      for (const k of keys) {
        const keyBase64 = k.toXDR("base64");
        if (entriesMap[keyBase64]) {
          returned.push({
            key: keyBase64,
            xdr: "mock-entry-xdr",
            liveUntilLedgerSeq: entriesMap[keyBase64].liveUntilLedgerSeq,
            lastModifiedLedgerSeq: entriesMap[keyBase64].lastModifiedLedgerSeq ?? currentLedger - 100,
          });
        }
      }
      return {
        latestLedger: currentLedger,
        entries: returned,
      };
    },
    async getAccount(address: string) {
      const balance = accountBalances[address] ?? "15.0000000";
      return {
        accountId: () => address,
        sequenceNumber: () => "100",
        incrementSequenceNumber: () => {},
        balances: [
          {
            asset_type: "native",
            balance,
          },
        ],
      } as any;
    },
    async simulateTransaction(tx: any) {
      if (options?.simulateError) {
        return {
          error: options.simulateError,
        };
      }
      return {
        _parsed: true,
        id: "1",
        latestLedger: currentLedger,
        minResourceFee: "1000",
        transactionData: new SorobanDataBuilder(),
      };
    },
    async sendTransaction(tx: any) {
      return {
        status: "PENDING",
        hash: "mock-tx-hash-" + Math.random().toString(36).substring(2, 8),
      };
    },
    async getTransaction(hash: string) {
      return {
        status: options?.txSuccess === false ? "FAILED" : "SUCCESS",
      };
    },
  } as unknown as rpc.Server;
}

describe("SorobanStateArchivalRecoveryService (Issue #337)", () => {
  const testContractId = "CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA";
  const adminKp = Keypair.random();

  it("evaluates TTL status correctly against thresholds", () => {
    const service = new SorobanStateArchivalRecoveryService({
      warnThresholdLedgers: 17280,
      restoreThresholdLedgers: 1000,
    });

    assert.equal(service.evaluateTtlStatus(50000), "HEALTHY");
    assert.equal(service.evaluateTtlStatus(17280), "NEEDS_EXTEND");
    assert.equal(service.evaluateTtlStatus(10000), "NEEDS_EXTEND");
    assert.equal(service.evaluateTtlStatus(1000), "ARCHIVED");
    assert.equal(service.evaluateTtlStatus(500), "ARCHIVED");
    assert.equal(service.evaluateTtlStatus(0), "ARCHIVED");
  });

  it("accurately inspects and flags entries nearing TTL expiration", async () => {
    const service = new SorobanStateArchivalRecoveryService({
      warnThresholdLedgers: 17280,
      restoreThresholdLedgers: 1000,
      escrowContractId: testContractId,
    });

    const key = service.getContractInstanceLedgerKey(testContractId);
    const keyBase64 = key.toXDR("base64");

    // Current ledger = 100,000, liveUntil = 110,000 => remaining 10,000 (NEEDS_EXTEND)
    const mockServer = createMockRpcServer({
      currentLedger: 100_000,
      entries: {
        [keyBase64]: { liveUntilLedgerSeq: 110_000 },
      },
    });

    (service as any).server = mockServer;

    const inspection = await service.inspectContractEntries([testContractId]);
    assert.equal(inspection.currentLedger, 100_000);
    assert.equal(inspection.entries.length, 1);
    assert.equal(inspection.entries[0].status, "NEEDS_EXTEND");
    assert.equal(inspection.entries[0].remainingTtlLedgers, 10_000);
  });

  it("flags missing or expired entries as ARCHIVED", async () => {
    const service = new SorobanStateArchivalRecoveryService({
      escrowContractId: testContractId,
    });

    // Empty entries in server
    const mockServer = createMockRpcServer({
      currentLedger: 100_000,
      entries: {},
    });
    (service as any).server = mockServer;

    const inspection = await service.inspectContractEntries([testContractId]);
    assert.equal(inspection.entries.length, 1);
    assert.equal(inspection.entries[0].status, "ARCHIVED");
    assert.equal(inspection.entries[0].remainingTtlLedgers, 0);
  });

  it("executes extendFootprintTtl transaction for expiring entries", async () => {
    const mockSigner = new MockSigner();
    const mockServer = createMockRpcServer();

    const service = new SorobanStateArchivalRecoveryService({
      server: mockServer,
      signer: mockSigner,
      extendTtlLedgers: 50_000,
      networkPassphrase: Networks.TESTNET,
    });

    const key = service.getContractInstanceLedgerKey(testContractId);
    const result = await service.extendFootprintTtl(adminKp.secret(), [key], 50_000);

    if (!result.success) console.error("TEST_ERR:", result.error); assert.equal(result.success, true);
    assert.ok(result.txHash?.startsWith("mock-tx-hash-"));
    assert.equal(mockSigner.signedTransactions.length, 1);
  });

  it("executes restoreFootprint transaction for archived entries", async () => {
    const mockSigner = new MockSigner();
    const mockServer = createMockRpcServer();

    const service = new SorobanStateArchivalRecoveryService({
      server: mockServer,
      signer: mockSigner,
      networkPassphrase: Networks.TESTNET,
    });

    const key = service.getContractInstanceLedgerKey(testContractId);
    const result = await service.restoreFootprint(adminKp.secret(), [key]);

    if (!result.success) console.error("TEST_ERR:", result.error); assert.equal(result.success, true);
    assert.ok(result.txHash?.startsWith("mock-tx-hash-"));
    assert.equal(mockSigner.signedTransactions.length, 1);
  });

  it("emits telemetry alerts when contract rent reserves fall below minimum safe balances", async () => {
    const alertNotifier = new MockAlertNotifier();
    const mockServer = createMockRpcServer({
      accountBalances: {
        [testContractId]: "2.5000000", // 2.5 XLM < 10 XLM threshold
      },
    });

    const service = new SorobanStateArchivalRecoveryService({
      server: mockServer,
      alertNotifier: alertNotifier as any,
      minSafeBalanceStroops: 100_000_000n, // 10 XLM
    });

    const statuses = await service.inspectRentReserves([testContractId]);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].isSafe, false);
    assert.equal(statuses[0].alertEmitted, true);
    assert.equal(alertNotifier.alerts.length, 1);
    assert.match(alertNotifier.alerts[0].title, /Low Contract Rent Reserve/);
  });

  it("does not alert when contract rent reserves are healthy", async () => {
    const alertNotifier = new MockAlertNotifier();
    const mockServer = createMockRpcServer({
      accountBalances: {
        [testContractId]: "50.0000000", // 50 XLM >= 10 XLM threshold
      },
    });

    const service = new SorobanStateArchivalRecoveryService({
      server: mockServer,
      alertNotifier: alertNotifier as any,
      minSafeBalanceStroops: 100_000_000n,
    });

    const statuses = await service.inspectRentReserves([testContractId]);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].isSafe, true);
    assert.equal(statuses[0].alertEmitted, false);
    assert.equal(alertNotifier.alerts.length, 0);
  });

  it("orchestrates a full automated recovery cycle", async () => {
    const alertNotifier = new MockAlertNotifier();
    const mockSigner = new MockSigner();

    const service = new SorobanStateArchivalRecoveryService({
      alertNotifier: alertNotifier as any,
      signer: mockSigner,
      escrowContractId: testContractId,
    });

    const key = service.getContractInstanceLedgerKey(testContractId);
    const keyBase64 = key.toXDR("base64");

    // Mock entry needing extend
    const mockServer = createMockRpcServer({
      currentLedger: 100_000,
      entries: {
        [keyBase64]: { liveUntilLedgerSeq: 112_000 }, // remaining 12,000 => NEEDS_EXTEND
      },
      accountBalances: {
        [testContractId]: "20.0000000",
      },
    });
    (service as any).server = mockServer;

    const report = await service.runRecoveryCycle(adminKp.secret(), [testContractId]);

    assert.equal(report.currentLedger, 100_000);
    assert.equal(report.extendedCount, 1);
    assert.equal(report.extendTxHashes.length, 1);
    assert.equal(report.errors.length, 0);
  });
});

describe("SorobanStorageRentMonitorDaemon (Issue #337)", () => {
  it("runs tick and maintains latest recovery report", async () => {
    const testContractId = "CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA";
    const adminKp = Keypair.random();

    const service = new SorobanStateArchivalRecoveryService({
      signer: new MockSigner(),
      escrowContractId: testContractId,
    });
    const key = service.getContractInstanceLedgerKey(testContractId);
    const keyBase64 = key.toXDR("base64");
    const mockServer = createMockRpcServer({
      currentLedger: 50_000,
      entries: {
        [keyBase64]: { liveUntilLedgerSeq: 200_000 },
      },
    });
    (service as any).server = mockServer;

    const daemon = new SorobanStorageRentMonitorDaemon({
      service,
      intervalMs: 1000,
      adminSecretKey: adminKp.secret(),
      monitoredContractIds: [testContractId],
    });

    const report = await daemon.tick();
    assert.ok(report);
    assert.equal(report.currentLedger, 50_000);
    assert.equal(daemon.getLastReport(), report);

    daemon.start();
    daemon.stop();
  });
});
