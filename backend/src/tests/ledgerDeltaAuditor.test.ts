import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LedgerDeltaAuditor,
  HorizonAccountStateSnapshot,
} from "../services/financial/ledgerDeltaAuditor.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";
import { FinancialAuditAction } from "../services/audit/financialAuditLog.js";
import { AdminAlert } from "../services/notifications/adminAlertNotifier.js";
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  TransactionStatus,
  TransactionType,
} from "../types/index.js";

const LEAGUE_ID_1 = "11111111-2222-4333-8444-555555555551";
const LEAGUE_ID_2 = "11111111-2222-4333-8444-555555555552";
const WALLET_ALICE = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXV2Z6QWQETVCH2D64";
const WALLET_BOB = "GB2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXV2Z6QWQETVCH2D65";

function createTestHarness(snapshotOverride?: Partial<HorizonAccountStateSnapshot>) {
  const leagues = new Map<string, any>();
  const contractStates = new Map<string, any>();
  const contractDeposits = new Map<string, bigint>();
  const recordedAudits: any[] = [];
  const emittedAlerts: AdminAlert[] = [];

  const snapshot: HorizonAccountStateSnapshot = {
    accountId: "CESCROW_CONTRACT_TEST",
    accountSequence: "900100200300",
    latestLedgerSeq: 55_000,
    usdcBalanceStroops: 500_000_000n,
    recentMovements: [],
    ...snapshotOverride,
  };

  const db = {
    league: {
      findUnique: async ({ where }: any) => leagues.get(where.id) || null,
      findMany: async () =>
        Array.from(leagues.values()).map((l) => ({ id: l.id })),
    },
  };

  const stellar: any = {
    getContractLeagueState: async (contractId: bigint) =>
      contractStates.get(contractId.toString()) || null,
    getContractDeposit: async (contractId: bigint, wallet: string) =>
      contractDeposits.get(`${contractId.toString()}:${wallet}`) ?? 0n,
  };

  const auditor = new LedgerDeltaAuditor({
    db,
    stellar,
    horizonProvider: {
      getEscrowAccountSnapshot: async () => snapshot,
    },
    audit: {
      record: (entry) => {
        recordedAudits.push(entry);
      },
    },
    alerts: {
      notify: async (alert) => {
        emittedAlerts.push(alert);
        return { slack: "sent", email: { sent: 1, failed: 0 } };
      },
    },
    discrepancyThresholdStroops: 10n,
    now: () => new Date("2026-10-20T09:00:00Z"),
  });

  return {
    auditor,
    leagues,
    contractStates,
    contractDeposits,
    recordedAudits,
    emittedAlerts,
    snapshot,
  };
}

describe("Automated Ledger Delta Auditor (#345)", () => {
  it("verifies a balanced league with deposits, partial refunds, payouts, and contract fees", async () => {
    const h = createTestHarness();
    const contractId = toContractLeagueId(LEAGUE_ID_1);

    // Gross deposits: 50 USDC (Alice 25, Bob 25)
    // Partial refund to Bob: 5 USDC
    // Prize payout to Alice: 18 USDC
    // Platform contract fee: 2 USDC
    // Expected remaining active escrow: 50 - 5 - 18 - 2 = 25 USDC (250,000,000 stroops)
    h.leagues.set(LEAGUE_ID_1, {
      id: LEAGUE_ID_1,
      name: "Matchday Delta Balanced League",
      status: LeagueStatus.ACTIVE,
      members: [
        {
          id: "m-alice",
          userId: "u-alice",
          walletAddress: WALLET_ALICE,
          paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
          status: MembershipStatus.ACTIVE,
        },
        {
          id: "m-bob",
          userId: "u-bob",
          walletAddress: WALLET_BOB,
          paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
          status: MembershipStatus.ACTIVE,
        },
      ],
      transactions: [
        {
          id: "tx-dep-alice",
          userId: "u-alice",
          memberId: "m-alice",
          type: TransactionType.ENTRY_FEE,
          status: TransactionStatus.CONFIRMED,
          amount: "25.0000000",
          stellarTxHash: "a".repeat(64),
          ledgerSeq: 54_100,
          sequenceId: "900100200101",
        },
        {
          id: "tx-dep-bob",
          userId: "u-bob",
          memberId: "m-bob",
          type: TransactionType.ENTRY_FEE,
          status: TransactionStatus.CONFIRMED,
          amount: "25.0000000",
          stellarTxHash: "b".repeat(64),
          ledgerSeq: 54_120,
          sequenceId: "900100200102",
        },
        {
          id: "tx-ref-bob",
          userId: "u-bob",
          memberId: "m-bob",
          type: TransactionType.REFUND,
          status: TransactionStatus.CONFIRMED,
          amount: "5.0000000",
          stellarTxHash: "c".repeat(64),
          ledgerSeq: 54_200,
          sequenceId: "900100200103",
        },
        {
          id: "tx-pay-alice",
          userId: "u-alice",
          memberId: "m-alice",
          type: TransactionType.PRIZE_PAYOUT,
          status: TransactionStatus.CONFIRMED,
          amount: "18.0000000",
          stellarTxHash: "d".repeat(64),
          ledgerSeq: 54_300,
          sequenceId: "900100200104",
        },
        {
          id: "tx-fee-1",
          userId: null,
          memberId: null,
          type: TransactionType.PLATFORM_FEE,
          status: TransactionStatus.CONFIRMED,
          amount: "2.0000000",
          stellarTxHash: "e".repeat(64),
          ledgerSeq: 54_300,
          sequenceId: "900100200105",
        },
      ],
    });

    h.contractStates.set(contractId.toString(), {
      league_id: contractId,
      total_deposited: 500_000_000n,
      escrow_balance: 250_000_000n,
      platform_fee: 20_000_000n,
      participant_count: 2,
    });
    h.contractDeposits.set(`${contractId.toString()}:${WALLET_ALICE}`, 250_000_000n);
    // Bob deposited 25 and was refunded 5 -> net 20 USDC on-chain deposit balance
    h.contractDeposits.set(`${contractId.toString()}:${WALLET_BOB}`, 200_000_000n);

    const report = await h.auditor.runDeltaAudit({ trigger: "scheduled" });

    assert.equal(report.status, "BALANCED");
    assert.equal(report.highPriorityAlertTriggered, false);
    assert.equal(report.findings.length, 0);
    assert.equal(report.balancedLeagues, 1);
    assert.equal(report.driftedLeagues, 0);
    assert.equal(report.leagueSummaries[0].dbExpectedEscrowUsdc, "25.0000000");
    assert.equal(report.leagueSummaries[0].onChainEscrowBalanceUsdc, "25.0000000");
    assert.equal(report.leagueSummaries[0].txHashes.length, 5);
    assert.ok(report.integrityDigest.length === 64);
    assert.equal(h.emittedAlerts.length, 0);
    assert.equal(h.recordedAudits.length, 1);
    assert.equal(h.recordedAudits[0].action, FinancialAuditAction.RECONCILIATION_BALANCED);
  });

  it("accurately identifies injected synthetic balance drift, partial deposit mismatches, missing deposits, uncredited payouts, and contract fee drift", async () => {
    const txHashMissingDeposit = "1".repeat(64);
    const txHashUncreditedPayout = "2".repeat(64);
    const txHashExistingDeposit = "3".repeat(64);

    const h = createTestHarness({
      accountSequence: "900100200999",
      latestLedgerSeq: 60_000,
      recentMovements: [
        {
          txHash: txHashMissingDeposit,
          sequenceId: "900100200881",
          ledgerSeq: 59_800,
          kind: "DEPOSIT",
          leagueId: LEAGUE_ID_2,
          participantAddress: WALLET_BOB,
          userId: "u-bob",
          amountStroops: 300_000_000n, // 30 USDC on-chain deposit not in DB
        },
        {
          txHash: txHashUncreditedPayout,
          sequenceId: "900100200882",
          ledgerSeq: 59_850,
          kind: "PAYOUT",
          leagueId: LEAGUE_ID_2,
          participantAddress: WALLET_ALICE,
          userId: "u-alice",
          amountStroops: 150_000_000n, // 15 USDC payout on-chain uncredited in DB
        },
      ],
    });

    const contractId = toContractLeagueId(LEAGUE_ID_2);

    // Alice has 20 USDC recorded in DB, but only 12.5 USDC on-chain (partial deposit mismatch)
    // Bob has 0 USDC recorded in DB, but 30 USDC on-chain (missing deposit record)
    // Contract fee in DB is 1 USDC, but on-chain platform_fee is 2.5 USDC (contract fee mismatch)
    h.leagues.set(LEAGUE_ID_2, {
      id: LEAGUE_ID_2,
      name: "Synthetic Drift League",
      status: LeagueStatus.ACTIVE,
      members: [
        {
          id: "m-alice",
          userId: "u-alice",
          walletAddress: WALLET_ALICE,
          paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
          status: MembershipStatus.ACTIVE,
        },
        {
          id: "m-bob",
          userId: "u-bob",
          walletAddress: WALLET_BOB,
          paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
          status: MembershipStatus.ACTIVE,
        },
      ],
      transactions: [
        {
          id: "tx-alice-1",
          userId: "u-alice",
          memberId: "m-alice",
          type: TransactionType.ENTRY_FEE,
          status: TransactionStatus.CONFIRMED,
          amount: "20.0000000",
          stellarTxHash: txHashExistingDeposit,
          ledgerSeq: 59_100,
          sequenceId: "900100200500",
        },
        {
          id: "tx-fee-db",
          userId: null,
          memberId: null,
          type: TransactionType.PLATFORM_FEE,
          status: TransactionStatus.CONFIRMED,
          amount: "1.0000000",
          stellarTxHash: "4".repeat(64),
          ledgerSeq: 59_200,
          sequenceId: "900100200501",
        },
      ],
    });

    h.contractStates.set(contractId.toString(), {
      league_id: contractId,
      total_deposited: 425_000_000n, // 42.5 USDC on-chain vs 19 USDC net DB
      escrow_balance: 250_000_000n,
      platform_fee: 25_000_000n, // 2.5 USDC on-chain vs 1.0 USDC DB
      participant_count: 2,
    });
    h.contractDeposits.set(`${contractId.toString()}:${WALLET_ALICE}`, 125_000_000n);
    h.contractDeposits.set(`${contractId.toString()}:${WALLET_BOB}`, 300_000_000n);

    const report = await h.auditor.runDeltaAudit({ trigger: "manual" });

    assert.equal(report.status, "DISCREPANCIES_FOUND");
    assert.equal(report.highPriorityAlertTriggered, true);
    assert.equal(report.driftedLeagues, 1);

    const anomalyKinds = new Set(report.findings.map((f) => f.kind));
    assert.ok(anomalyKinds.has("PARTIAL_DEPOSIT_MISMATCH"));
    assert.ok(anomalyKinds.has("MISSING_DEPOSIT_RECORD"));
    assert.ok(anomalyKinds.has("UNCREDITED_PAYOUT"));
    assert.ok(anomalyKinds.has("CONTRACT_FEE_MISMATCH"));
    assert.ok(anomalyKinds.has("BALANCE_DRIFT"));

    // Verify transaction hashes and sequence IDs are populated in findings
    const missingDepositFinding = report.findings.find(
      (f) => f.kind === "MISSING_DEPOSIT_RECORD"
    );
    assert.ok(missingDepositFinding);
    assert.ok(missingDepositFinding.txHashes.includes(txHashMissingDeposit));
    assert.ok(missingDepositFinding.sequenceIds.includes("900100200881"));

    const uncreditedPayoutFinding = report.findings.find(
      (f) => f.kind === "UNCREDITED_PAYOUT"
    );
    assert.ok(uncreditedPayoutFinding);
    assert.ok(uncreditedPayoutFinding.txHashes.includes(txHashUncreditedPayout));
    assert.ok(uncreditedPayoutFinding.sequenceIds.includes("900100200882"));

    // Verify high-priority critical alert was emitted
    assert.equal(h.emittedAlerts.length, 1);
    assert.equal(h.emittedAlerts[0].severity, "critical");
    assert.ok(h.emittedAlerts[0].title.includes("[HIGH PRIORITY]"));
    assert.ok(h.emittedAlerts[0].text.includes(txHashMissingDeposit));

    // Verify audit log recorded discrepancy
    assert.equal(h.recordedAudits.length, 1);
    assert.equal(
      h.recordedAudits[0].action,
      FinancialAuditAction.RECONCILIATION_DISCREPANCY
    );
  });

  it("detects Horizon ledger sequence regression when DB sequence exceeds Horizon head", async () => {
    const h = createTestHarness({
      accountSequence: "900100200100",
      latestLedgerSeq: 40_000, // Horizon node is lagging behind DB ledger 45,000
    });
    const contractId = toContractLeagueId(LEAGUE_ID_1);

    h.leagues.set(LEAGUE_ID_1, {
      id: LEAGUE_ID_1,
      name: "Sequence Lag League",
      status: LeagueStatus.ACTIVE,
      members: [],
      transactions: [
        {
          id: "tx-future-seq",
          userId: "u-alice",
          type: TransactionType.ENTRY_FEE,
          status: TransactionStatus.CONFIRMED,
          amount: "10.0000000",
          stellarTxHash: "f".repeat(64),
          ledgerSeq: 45_000,
          sequenceId: "900100200555",
        },
      ],
    });

    h.contractStates.set(contractId.toString(), {
      league_id: contractId,
      total_deposited: 100_000_000n,
      escrow_balance: 100_000_000n,
      participant_count: 1,
    });

    const report = await h.auditor.runDeltaAudit();
    assert.equal(report.status, "DISCREPANCIES_FOUND");
    assert.ok(report.findings.some((f) => f.kind === "SEQUENCE_REGRESSION"));

    // Verify scheduled daemon lifecycle starts and stops cleanly
    h.auditor.startScheduled(60_000);
    h.auditor.startScheduled(60_000);
    h.auditor.stop();
    h.auditor.stop();
  });
});
