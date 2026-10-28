import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLedgerAuditFindings,
  calculateExpectedEscrowBalance,
  LedgerAuditService,
  type LedgerAuditEventInput,
  type LedgerAuditTransactionInput,
} from "../services/financial/ledgerAuditService.js";
import type { PrismaClient } from "@prisma/client";
import type { StellarService } from "../services/financial/stellarService.js";
import { TransactionStatus, TransactionType } from "../types/index.js";

describe("Ledger delta auditor calculations", () => {
  it("nets confirmed deposits, refunds, platform fees, and claimed payouts", () => {
    const transactions: LedgerAuditTransactionInput[] = [
      { type: TransactionType.ENTRY_FEE, amount: "10.00", status: TransactionStatus.CONFIRMED },
      { type: TransactionType.ENTRY_FEE, amount: "5.25", status: TransactionStatus.CONFIRMED },
      { type: TransactionType.REFUND, amount: "5.25", status: TransactionStatus.CONFIRMED },
      { type: TransactionType.PLATFORM_FEE, amount: "0.50", status: TransactionStatus.CONFIRMED },
      { type: TransactionType.PRIZE_PAYOUT, amount: "4.00", status: TransactionStatus.CONFIRMED },
      { type: TransactionType.ENTRY_FEE, amount: "99.00", status: TransactionStatus.PENDING },
    ];

    assert.equal(calculateExpectedEscrowBalance(transactions), 55_000_000n);
  });

  it("finds mismatches in balances, active deposits, missing claims, fees, and refunds", () => {
    const transactions: LedgerAuditTransactionInput[] = [
      {
        type: TransactionType.REFUND,
        amount: "1.00",
        status: TransactionStatus.CONFIRMED,
        stellarTxHash: "refund-1-member",
        ledgerSeq: 21,
      },
    ];
    const events: LedgerAuditEventInput[] = [
      {
        eventType: "deposit",
        leagueId: "league-a",
        txHash: "deposit-missing",
        ledgerSeq: 18,
        payload: { value: ["GDEPOSITOR", "10000000"] },
      },
      {
        eventType: "claimed",
        leagueId: "league-a",
        txHash: "claim-missing",
        ledgerSeq: 19,
        payload: { value: ["GWINNER", "20000000"] },
      },
      {
        eventType: "settle",
        leagueId: "league-a",
        txHash: "settle-missing",
        ledgerSeq: 20,
        payload: { value: ["90000000", "10000000"] },
      },
      {
        eventType: "refund",
        leagueId: "league-a",
        txHash: "refund-1",
        ledgerSeq: 21,
        payload: { value: "2" },
      },
    ];

    const findings = buildLedgerAuditFindings({
      expectedBalanceStroops: 10_000_000n,
      observedBalanceStroops: 12_000_000n,
      thresholdStroops: 100_000n,
      latestSorobanLedger: 30,
      indexedThroughLedger: 30,
      transactions,
      events,
      leagues: [
        {
          leagueId: "league-a",
          stateFound: true,
          expectedDepositStroops: "10000000",
          observedDepositStroops: "9000000",
          databaseParticipantCount: 1,
          chainParticipantCount: 2,
        },
      ],
      coverageComplete: true,
    });

    const categories = findings.map((finding) => finding.category);
    assert.ok(categories.includes("ESCROW_BALANCE_MISMATCH"));
    assert.ok(categories.includes("LEAGUE_DEPOSIT_MISMATCH"));
    assert.ok(categories.includes("LEAGUE_PARTICIPANT_COUNT_MISMATCH"));
    assert.ok(categories.includes("MISSING_DEPOSIT_RECORD"));
    assert.ok(categories.includes("UN_CREDITED_PAYOUT"));
    assert.ok(categories.includes("MISSING_PLATFORM_FEE_RECORD"));
    assert.ok(categories.includes("REFUND_RECORD_COUNT_MISMATCH"));
    assert.equal(findings.find((finding) => finding.category === "MISSING_DEPOSIT_RECORD")?.ledgerSeq, 18);
  });

  it("defers balance mismatch alerts while the event indexer is behind", () => {
    const findings = buildLedgerAuditFindings({
      expectedBalanceStroops: 0n,
      observedBalanceStroops: 5_000_000n,
      thresholdStroops: 100_000n,
      latestSorobanLedger: 50,
      indexedThroughLedger: 20,
      transactions: [],
      events: [],
      leagues: [],
      coverageComplete: false,
    });

    assert.deepEqual(findings.map((finding) => finding.category), ["INDEXER_LAG"]);
  });

  it("keeps balances separate across multiple leagues", () => {
    const findings = buildLedgerAuditFindings({
      expectedBalanceStroops: 20_000_000n,
      observedBalanceStroops: 20_000_000n,
      thresholdStroops: 100_000n,
      latestSorobanLedger: 40,
      indexedThroughLedger: 40,
      transactions: [],
      events: [],
      leagues: [
        {
          leagueId: "league-a",
          stateFound: true,
          expectedDepositStroops: "10000000",
          observedDepositStroops: "10000000",
          databaseParticipantCount: 1,
          chainParticipantCount: 1,
        },
        {
          leagueId: "league-b",
          stateFound: true,
          expectedDepositStroops: "10000000",
          observedDepositStroops: "9000000",
          databaseParticipantCount: 1,
          chainParticipantCount: 1,
        },
      ],
      coverageComplete: true,
    });

    assert.deepEqual(
      findings.map((finding) => [finding.category, finding.leagueId]),
      [["LEAGUE_DEPOSIT_MISMATCH", "league-b"]]
    );
  });

  it("persists reports in a hash-linked sequence", async () => {
    const runs: Array<Record<string, unknown>> = [];
    const findings: Array<Record<string, unknown>> = [];
    const db = {
      league: { findMany: async () => [] },
      transaction: { findMany: async () => [] },
      contractEvent: { findMany: async () => [] },
      indexerCursor: { findUnique: async () => ({ lastLedger: 100 }) },
      ledgerAuditRun: {
        findFirst: async () =>
          runs.length ? { reportHash: runs[runs.length - 1].reportHash } : null,
      },
      $transaction: async (operation: (transaction: unknown) => Promise<void>) =>
        operation({
          ledgerAuditRun: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              runs.push(data);
            },
          },
          ledgerAuditFinding: {
            createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
              findings.push(...data);
            },
          },
        }),
    };
    const stellar = {
      getRpcLedgerRange: async () => ({ oldestLedger: 1, latestLedger: 100 }),
      getHorizonLatestLedger: async () => 100,
      getContractTokenBalanceForAudit: async () => 0n,
    };
    const service = new LedgerAuditService({
      db: db as unknown as PrismaClient,
      stellar: stellar as unknown as StellarService,
    });

    const first = await service.runAudit();
    const second = await service.runAudit();

    assert.equal(first.previousHash, null);
    assert.equal(second.previousHash, first.reportHash);
    assert.equal(runs.length, 2);
    assert.equal(findings.length, 0);
    assert.equal(first.reportHash.length, 64);
  });
});
