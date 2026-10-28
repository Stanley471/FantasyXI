import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import {
  FeeBumpService,
  DEFAULT_MAX_FEE_CAP_STROOPS,
} from "../services/financial/feeBumpService.js";
import { FinancialAuditAction } from "@prisma/client";

function createDummyInnerTx(sourceKeypair: Keypair, fee = "100"): Transaction {
  const account = new Account(sourceKeypair.publicKey(), "12345");
  return new TransactionBuilder(account, {
    fee,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "10",
      })
    )
    .setTimeout(300)
    .build();
}

describe("FeeBumpService", () => {
  let sponsorshipKeypair: Keypair;
  let senderKeypair: Keypair;
  let auditLogs: any[];
  let mockDb: any;

  beforeEach(() => {
    sponsorshipKeypair = Keypair.random();
    senderKeypair = Keypair.random();
    auditLogs = [];

    mockDb = {
      financialAuditLog: {
        create: async ({ data }: any) => {
          auditLogs.push(data);
          return { id: "audit-1", ...data };
        },
      },
    };
  });

  it("calculates dynamically escalated fee adhering to SEP-0015 and safety cap", () => {
    const service = new FeeBumpService({
      maxFeeCapStroops: 50_000,
      feeMultiplier: 1.5,
    });

    // Inner fee 100 stroops -> min required: 100 + 100 = 200, multiplier: 150 -> 200 stroops
    const fee1 = service.calculateBumpedFee(100, 100);
    assert.equal(fee1, 200);

    // Inner fee 10,000 stroops -> min: 10,100, multiplier: 15,000 -> 15,000 stroops
    const fee2 = service.calculateBumpedFee(10_000, 100);
    assert.equal(fee2, 15_000);

    // Inner fee 40,000 stroops -> 40,000 * 1.5 = 60,000 -> capped at 50,000
    const fee3 = service.calculateBumpedFee(40_000, 100);
    assert.equal(fee3, 50_000);

    // If required minimum fee strictly exceeds cap, throws error to protect reserves
    assert.throws(
      () => service.calculateBumpedFee(60_000, 100),
      /exceeds safety cap/
    );
  });

  it("builds a valid SEP-0015 fee-bump transaction signed by sponsorship keypair", () => {
    const service = new FeeBumpService({
      sponsorshipKeypair,
      networkPassphrase: Networks.TESTNET,
    });

    const innerTx = createDummyInnerTx(senderKeypair, "1000");
    innerTx.sign(senderKeypair);

    const { feeBumpTx, bumpedFeeStroops, innerTxHash } = service.buildFeeBumpTransaction(innerTx);

    assert.ok(feeBumpTx instanceof FeeBumpTransaction);
    assert.equal(feeBumpTx.feeSource, sponsorshipKeypair.publicKey());
    assert.equal(Number(feeBumpTx.fee), bumpedFeeStroops);
    assert.equal(feeBumpTx.signatures.length, 1);
    assert.equal(innerTxHash, innerTx.hash().toString("hex"));
  });

  it("refuses to bump transactions if sponsorship balance is below safety threshold", async () => {
    const mockHorizon = {
      loadAccount: async () => ({
        balances: [{ asset_type: "native", balance: "0.5000000" }], // below 2.0 XLM threshold
      }),
    };

    const service = new FeeBumpService({
      sponsorshipKeypair,
      horizonClient: mockHorizon,
      minSponsorshipBalanceXlm: 2.0,
      db: mockDb,
    });

    const innerTx = createDummyInnerTx(senderKeypair, "500");
    innerTx.sign(senderKeypair);

    const result = await service.submitFeeBump(innerTx);

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /insufficient balance/i);
    assert.equal(auditLogs.length, 0); // No fee recorded
  });

  it("submits fee bump and accurately writes internal accounting audit records", async () => {
    let submittedTx: any = null;
    const mockHorizon = {
      loadAccount: async () => ({
        balances: [{ asset_type: "native", balance: "50.0000000" }], // plenty of funds
      }),
      submitTransaction: async (tx: any) => {
        submittedTx = tx;
        return { successful: true, ledger: 99420 };
      },
    };

    const service = new FeeBumpService({
      sponsorshipKeypair,
      horizonClient: mockHorizon,
      db: mockDb,
      networkPassphrase: Networks.TESTNET,
    });

    const innerTx = createDummyInnerTx(senderKeypair, "1000");
    innerTx.sign(senderKeypair);

    const result = await service.submitFeeBump(innerTx, {
      leagueId: "league-123",
      userId: "user-456",
      transactionId: "tx-789",
    });

    assert.equal(result.success, true);
    assert.equal(result.ledgerSeq, 99420);
    assert.ok(submittedTx instanceof FeeBumpTransaction);
    assert.equal(result.sponsorshipAccount, sponsorshipKeypair.publicKey());

    // Verify audit log record
    assert.equal(auditLogs.length, 1);
    const log = auditLogs[0];
    assert.equal(log.action, FinancialAuditAction.FEE_EXTRACTION);
    assert.equal(log.actorId, "system:fee_bump_service");
    assert.equal(log.leagueId, "league-123");
    assert.equal(log.userId, "user-456");
    assert.equal(log.transactionId, "tx-789");
    assert.equal(log.metadata.reason, "FEE_BUMP");
    assert.equal(log.metadata.innerTxHash, innerTx.hash().toString("hex"));
    assert.equal(log.metadata.originalFeeStroops, 1000);
    assert.equal(log.metadata.bumpedFeeStroops, result.bumpedFeeStroops);
  });

  it("scans candidates and bumps transactions pending past threshold", async () => {
    const mockHorizon = {
      loadAccount: async () => ({
        balances: [{ asset_type: "native", balance: "25.0000000" }],
      }),
      submitTransaction: async () => ({ successful: true, ledger: 1001 }),
    };

    const baseTime = new Date("2026-10-20T10:00:00Z");
    const service = new FeeBumpService({
      sponsorshipKeypair,
      horizonClient: mockHorizon,
      db: mockDb,
      pendingThresholdMs: 30_000,
      now: () => new Date("2026-10-20T10:01:00Z"), // 60s later
    });

    const innerTx1 = createDummyInnerTx(senderKeypair, "200");
    innerTx1.sign(senderKeypair);
    const xdr1 = innerTx1.toXDR();

    const innerTx2 = createDummyInnerTx(senderKeypair, "300");
    innerTx2.sign(senderKeypair);
    const xdr2 = innerTx2.toXDR();

    const candidates = [
      // Stuck for 60s (exceeds 30s threshold -> should bump)
      {
        id: "tx-stuck",
        txHash: innerTx1.hash().toString("hex"),
        envelopeXdr: xdr1,
        submittedAt: baseTime,
        leagueId: "league-1",
      },
      // Submitted 10s ago (below 30s threshold -> skip)
      {
        id: "tx-recent",
        txHash: innerTx2.hash().toString("hex"),
        envelopeXdr: xdr2,
        submittedAt: new Date("2026-10-20T10:00:50Z"),
        leagueId: "league-1",
      },
    ];

    const scanResult = await service.scanAndBumpStuckTransactions(candidates);

    assert.equal(scanResult.inspected, 2);
    assert.equal(scanResult.bumped, 1);
    assert.equal(scanResult.skipped, 1);
    assert.equal(scanResult.results.length, 1);
    assert.equal(scanResult.results[0].success, true);
  });

  it("integrates with TransactionCoordinatorService to automatically bump stuck transactions", async () => {
    const { TransactionCoordinatorService } = await import(
      "../services/financial/transactionCoordinatorService.js"
    );

    let feeBumpSubmitted = false;
    const mockFeeBumpService = {
      submitFeeBump: async () => {
        feeBumpSubmitted = true;
        return {
          success: true,
          innerTxHash: "1111",
          feeBumpTxHash: "2222",
          originalFeeStroops: 100,
          bumpedFeeStroops: 300,
          sponsorshipAccount: "GBUMP",
        };
      },
    } as unknown as FeeBumpService;

    const innerTx = createDummyInnerTx(senderKeypair, "200");
    innerTx.sign(senderKeypair);
    const hash = innerTx.hash().toString("hex");

    const record = {
      id: "coord-1",
      txHash: hash,
      kind: "SETTLEMENT",
      status: "PENDING" as any,
      userId: "user-1",
      leagueId: "league-1",
      transactionId: "tx-1",
      attempts: 1,
      ledgerSeq: null,
      lastError: null,
      metadata: { envelopeXdr: innerTx.toXDR() },
      submittedAt: new Date("2026-10-20T10:00:00Z"),
      nextPollAt: new Date("2026-10-20T10:00:00Z"),
      lastPolledAt: null,
      finalizedAt: null,
    };

    let updatedMetadata: any = null;
    const dbMock = {
      coordinatedTransaction: {
        findMany: async () => [record],
        updateMany: async ({ data }: any) => {
          updatedMetadata = data.metadata;
          return { count: 1 };
        },
      },
    };

    const rpcMock = {
      getTransaction: async () => ({
        status: "NOT_FOUND",
      }),
    };

    const coordinator = new TransactionCoordinatorService({
      db: dbMock,
      rpc: rpcMock,
      feeBumpService: mockFeeBumpService,
      feeBumpThresholdMs: 10_000,
      now: () => new Date("2026-10-20T10:01:00Z"), // 60s later (>10s threshold)
    });

    await coordinator.pollDue();

    assert.equal(feeBumpSubmitted, true);
    assert.equal(updatedMetadata.feeBumpTxHash, "2222");
    assert.equal(updatedMetadata.bumpedFeeStroops, 300);
  });
});
