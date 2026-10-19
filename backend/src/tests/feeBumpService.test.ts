import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  AutomatedFeeBumpService,
  FeeCapExceededError,
  SponsorshipReserveExhaustedError,
  UnauthorizedFeeSponsorshipError,
  type FeeBumpRpcPort,
  type NetworkFeeStats,
} from "../services/financial/feeBumpService.js";
import type {
  FinancialAuditEntryInput,
  FinancialAuditRecorder,
} from "../services/audit/financialAuditLog.js";

function buildSignedInnerTxXdr(options?: {
  sourceKeypair?: Keypair;
  feeStroops?: string;
  operationCount?: number;
  timeoutSec?: number;
}): { xdr: string; hash: string; keypair: Keypair } {
  const keypair = options?.sourceKeypair ?? Keypair.random();
  const account = new Account(keypair.publicKey(), "100");
  const builder = new TransactionBuilder(account, {
    fee: options?.feeStroops ?? "100",
    networkPassphrase: Networks.TESTNET,
  });

  const opCount = options?.operationCount ?? 1;
  for (let i = 0; i < opCount; i++) {
    builder.addOperation(
      Operation.bumpSequence({
        bumpTo: String(101 + i),
      })
    );
  }

  const tx = builder.setTimeout(options?.timeoutSec ?? 60).build();
  tx.sign(keypair);

  return {
    xdr: tx.toXDR(),
    hash: Buffer.from(tx.hash()).toString("hex"),
    keypair,
  };
}

describe("AutomatedFeeBumpService — Stellar SEP-0015 Fee-Bump (Issue #363)", () => {
  let sponsorKeypair: Keypair;
  let currentTimeMs: number;
  let auditEntries: FinancialAuditEntryInput[];
  let submittedFeeBumps: FeeBumpTransaction[];
  let txStatusByHash: Map<string, { status: "NOT_FOUND" | "PENDING" | "SUCCESS" | "FAILED"; ledger?: number }>;
  let feeStats: NetworkFeeStats;
  let sponsorBalanceStroops: bigint;
  let mockRpc: FeeBumpRpcPort;
  let mockAudit: FinancialAuditRecorder;

  beforeEach(() => {
    sponsorKeypair = Keypair.random();
    currentTimeMs = Date.parse("2026-10-19T15:00:00.000Z");
    auditEntries = [];
    submittedFeeBumps = [];
    txStatusByHash = new Map();
    feeStats = {
      baseFeeStroops: 100,
      p90FeeStroops: 250,
      p95FeeStroops: 500,
      p99FeeStroops: 1_200,
    };
    sponsorBalanceStroops = 50_000_000n; // 5 XLM

    mockRpc = {
      getTransactionStatus: async (txHash: string) => {
        return txStatusByHash.get(txHash) ?? { status: "NOT_FOUND" };
      },
      sendFeeBumpTransaction: async (feeBumpTx: FeeBumpTransaction) => {
        submittedFeeBumps.push(feeBumpTx);
        return {
          hash: Buffer.from(feeBumpTx.hash()).toString("hex"),
          status: "PENDING",
        };
      },
      getFeeStats: async () => feeStats,
      getSponsorBalanceStroops: async () => sponsorBalanceStroops,
    };

    mockAudit = {
      record: (entry: FinancialAuditEntryInput) => {
        auditEntries.push(entry);
      },
    };
  });

  it("automatically fee-bumps stuck transactions and verifies SEP-0015 FeeBumpTransaction signatures", async () => {
    const service = new AutomatedFeeBumpService({
      sponsorKeyReference: sponsorKeypair.secret(),
      networkPassphrase: Networks.TESTNET,
      rpc: mockRpc,
      audit: mockAudit,
      stuckThresholdMs: 15_000,
      escalationMultiplier: 2.0,
      maxFeeStroopsPerTx: 50_000,
      now: () => new Date(currentTimeMs),
    });

    const { xdr, hash } = buildSignedInnerTxXdr({ feeStroops: "100" });
    await service.registerPendingTransaction({
      envelopeXdr: xdr,
      leagueId: "league-premier-01",
      kind: "SETTLEMENT",
    });

    // At T+5s (< 15s threshold), transaction is not yet considered stuck
    currentTimeMs += 5_000;
    const earlyPoll = await service.pollMempoolOnce();
    assert.equal(earlyPoll.scanned, 1);
    assert.equal(earlyPoll.bumped, 0);
    assert.equal(submittedFeeBumps.length, 0);

    // At T+16s (>= 15s threshold), mempool monitor detects stuck tx and submits SEP-0015 fee bump
    currentTimeMs += 11_000;
    const bumpPoll = await service.pollMempoolOnce();
    assert.equal(bumpPoll.scanned, 1);
    assert.equal(bumpPoll.bumped, 1);
    assert.equal(submittedFeeBumps.length, 1);

    const submittedFb = submittedFeeBumps[0];
    assert.equal(submittedFb.feeSource, sponsorKeypair.publicKey());
    assert.equal(
      Buffer.from(submittedFb.innerTransaction.hash()).toString("hex"),
      hash,
      "FeeBumpTransaction must wrap the original signed inner transaction"
    );
    assert.ok(
      submittedFb.signatures.length > 0,
      "FeeBumpTransaction must be signed by the sponsorship keypair"
    );
    // Network surge p95 is 500 stroops/op; outer op count = 1 inner + 1 = 2 -> total fee = 1000 stroops
    assert.equal(Number(submittedFb.fee), 1_000);

    // Once the bumped hash lands on-chain, the next poll marks it CONFIRMED
    const bumpedHash = Buffer.from(submittedFb.hash()).toString("hex");
    txStatusByHash.set(bumpedHash, { status: "SUCCESS", ledger: 551234 });

    const confirmPoll = await service.pollMempoolOnce();
    assert.equal(confirmPoll.confirmed, 1);
    assert.equal(service.getTrackedTransaction(hash)?.status, "CONFIRMED");
  });

  it("bumps transactions approaching their timebounds timeout even before stuckThresholdMs", async () => {
    const service = new AutomatedFeeBumpService({
      sponsorKeyReference: sponsorKeypair.secret(),
      networkPassphrase: Networks.TESTNET,
      rpc: mockRpc,
      audit: mockAudit,
      stuckThresholdMs: 60_000,
      approachingTimeoutThresholdMs: 10_000,
      now: () => new Date(currentTimeMs),
    });

    const { xdr, hash } = buildSignedInnerTxXdr({ feeStroops: "100" });
    await service.registerPendingTransaction({
      envelopeXdr: xdr,
      leagueId: "league-timeout-urgent",
      kind: "SETTLEMENT",
      timeoutAt: new Date(currentTimeMs + 8_000), // 8s remaining <= 10s approaching timeout window
    });

    const summary = await service.pollMempoolOnce();
    assert.equal(summary.bumped, 1);
    assert.equal(service.getTrackedTransaction(hash)?.bumpCount, 1);
  });

  it("strictly enforces maximum fee caps and max bump attempts under extreme congestion", async () => {
    // Surge p95 jumps to 20,000 stroops/op, but maxFeeStroopsPerTx is capped at 4,000 stroops total (2,000/op for 1-op inner tx)
    feeStats = {
      baseFeeStroops: 100,
      p90FeeStroops: 10_000,
      p95FeeStroops: 20_000,
      p99FeeStroops: 50_000,
    };

    const service = new AutomatedFeeBumpService({
      sponsorKeyReference: sponsorKeypair.secret(),
      networkPassphrase: Networks.TESTNET,
      rpc: mockRpc,
      audit: mockAudit,
      stuckThresholdMs: 10_000,
      maxFeeStroopsPerTx: 4_000,
      maxBumpAttempts: 2,
      now: () => new Date(currentTimeMs),
    });

    const { xdr, hash } = buildSignedInnerTxXdr({ feeStroops: "100" });
    await service.registerPendingTransaction({
      envelopeXdr: xdr,
      leagueId: "league-cap-test",
    });

    // First bump clamps to the 4,000 stroop cap (2,000 per op * 2 ops)
    const entry = await service.bumpTransactionFee(hash);
    assert.equal(entry.bumpedTotalFeeStroops, 4_000);
    assert.equal(entry.bumpedPerOpFeeStroops, 2_000);

    // Second bump attempt must fail with FeeCapExceededError because tx is already at the 4,000 stroop ceiling
    await assert.rejects(
      () => service.bumpTransactionFee(hash),
      (err: unknown) => err instanceof FeeCapExceededError
    );
    assert.equal(service.getTrackedTransaction(hash)?.status, "CAPPED");
  });

  it("protects sponsorship account reserves and rejects arbitrary non-platform transactions", async () => {
    const allowedLeagues = new Set(["league-official-1"]);
    const service = new AutomatedFeeBumpService({
      sponsorKeyReference: sponsorKeypair.secret(),
      networkPassphrase: Networks.TESTNET,
      rpc: mockRpc,
      audit: mockAudit,
      isAllowedLeague: (id) => allowedLeagues.has(id),
      minSponsorReserveStroops: 20_000_000n, // 2 XLM reserve floor
      now: () => new Date(currentTimeMs),
    });

    const { xdr } = buildSignedInnerTxXdr({ feeStroops: "100" });

    // 1. Rejects non-platform league transaction
    await assert.rejects(
      () =>
        service.registerPendingTransaction({
          envelopeXdr: xdr,
          leagueId: "unauthorized-external-tx",
        }),
      (err: unknown) => err instanceof UnauthorizedFeeSponsorshipError
    );

    // 2. Registers authorized league tx, then simulates sponsor balance near minimum reserve floor
    const { xdr: validXdr, hash: validHash } = buildSignedInnerTxXdr({ feeStroops: "100" });
    await service.registerPendingTransaction({
      envelopeXdr: validXdr,
      leagueId: "league-official-1",
    });

    sponsorBalanceStroops = 20_000_100n; // Only 100 stroops above 20,000,000 reserve floor
    await assert.rejects(
      () => service.bumpTransactionFee(validHash),
      (err: unknown) => err instanceof SponsorshipReserveExhaustedError
    );
    assert.equal(service.getTrackedTransaction(validHash)?.status, "CAPPED");
  });

  it("accurately records multi-step bumped fees in internal accounting and FinancialAuditLog", async () => {
    feeStats = {
      baseFeeStroops: 100,
      p90FeeStroops: 150,
      p95FeeStroops: 200,
      p99FeeStroops: 400,
    };

    const service = new AutomatedFeeBumpService({
      sponsorKeyReference: sponsorKeypair.secret(),
      networkPassphrase: Networks.TESTNET,
      rpc: mockRpc,
      audit: mockAudit,
      escalationMultiplier: 2.0,
      maxFeeStroopsPerTx: 50_000,
      maxBumpAttempts: 3,
      now: () => new Date(currentTimeMs),
    });

    const { xdr, hash } = buildSignedInnerTxXdr({ feeStroops: "100" });
    await service.registerPendingTransaction({
      envelopeXdr: xdr,
      leagueId: "league-accounting-42",
      kind: "SETTLEMENT",
    });

    // Bump #1: initial 100 stroops/op * 2^1 = 200 stroops/op -> total 400 stroops
    const bump1 = await service.bumpTransactionFee(hash);
    assert.equal(bump1.bumpAttempt, 1);
    assert.equal(bump1.previousTotalFeeStroops, 100);
    assert.equal(bump1.bumpedTotalFeeStroops, 400);
    assert.equal(bump1.incrementalFeeStroops, 400);

    // Bump #2: current 200 stroops/op * 2^2 = 800 stroops/op -> total 1,600 stroops (incremental +1,200 stroops)
    const bump2 = await service.bumpTransactionFee(hash);
    assert.equal(bump2.bumpAttempt, 2);
    assert.equal(bump2.previousTotalFeeStroops, 400);
    assert.equal(bump2.bumpedTotalFeeStroops, 1_600);
    assert.equal(bump2.incrementalFeeStroops, 1_200);

    const summary = service.getLeagueFeeSummary("league-accounting-42");
    assert.equal(summary.totalBumpCount, 2);
    assert.equal(summary.totalBumpedFeeStroops, 1_600);
    assert.equal(summary.totalIncrementalFeeStroops, 1_600);
    assert.equal(service.getTotalSponsoredStroops(), 1_600n);

    assert.equal(auditEntries.length, 2);
    assert.equal(auditEntries[1].leagueId, "league-accounting-42");
    assert.equal(auditEntries[1].asset, "XLM");
    assert.equal((auditEntries[1].metadata as any).bumpedTotalFeeStroops, 1_600);
    assert.equal((auditEntries[1].metadata as any).innerTxHash, hash);
  });
});
