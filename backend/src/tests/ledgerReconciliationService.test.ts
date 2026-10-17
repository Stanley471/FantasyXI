import test from "node:test";
import assert from "node:assert/strict";
import {
  LedgerReconciliationService,
  DbLedgerTransaction,
  OnChainHorizonTransaction,
} from "../services/financial/ledgerReconciliationService.js";

test("LedgerReconciliationService: validates a balanced ledger with zero discrepancies", () => {
  const service = new LedgerReconciliationService();
  const windowStart = new Date("2026-10-17T00:00:00.000Z");
  const windowEnd = new Date("2026-10-18T00:00:00.000Z");

  const dbTxs: DbLedgerTransaction[] = [
    {
      id: "db-1",
      leagueId: "league-1",
      userId: "u-1",
      type: "DEPOSIT",
      status: "CONFIRMED",
      amount: 100,
      assetCode: "USDC",
      stellarTxHash: "tx-hash-1",
      createdAt: windowStart,
      confirmedAt: windowStart,
    },
    {
      id: "db-2",
      leagueId: "league-1",
      userId: "u-2",
      type: "PAYOUT",
      status: "CONFIRMED",
      amount: 95,
      assetCode: "USDC",
      stellarTxHash: "tx-hash-2",
      createdAt: windowStart,
      confirmedAt: windowStart,
    },
  ];

  const chainTxs: OnChainHorizonTransaction[] = [
    {
      txHash: "tx-hash-1",
      ledgerSeq: 50001,
      successful: true,
      leagueId: "league-1",
      type: "DEPOSIT",
      amount: 100,
      assetCode: "USDC",
      timestamp: windowStart,
    },
    {
      txHash: "tx-hash-2",
      ledgerSeq: 50050,
      successful: true,
      leagueId: "league-1",
      type: "PAYOUT",
      amount: 95,
      assetCode: "USDC",
      timestamp: windowStart,
    },
  ];

  const report = service.reconcileWindow({
    reportId: "recon-balanced-1",
    windowStart,
    windowEnd,
    dbTransactions: dbTxs,
    onChainTransactions: chainTxs,
  });

  assert.equal(report.isBalanced, true);
  assert.equal(report.summary.matchedCount, 2);
  assert.equal(report.summary.discrepancyCount, 0);
  assert.equal(report.summary.netDepositDrift, 0);
  assert.equal(report.summary.netPayoutDrift, 0);
});

test("LedgerReconciliationService: detects phantom DB records, unindexed on-chain txs, amount mismatches, and stale pending txs", () => {
  const service = new LedgerReconciliationService();
  const windowStart = new Date("2026-10-17T00:00:00.000Z");
  const windowEnd = new Date("2026-10-18T00:00:00.000Z");

  const dbTxs: DbLedgerTransaction[] = [
    // 1. Phantom DB record (marked CONFIRMED in DB, but does not exist on Horizon)
    {
      id: "db-phantom",
      leagueId: "league-1",
      userId: "u-phantom",
      type: "DEPOSIT",
      status: "CONFIRMED",
      amount: 50,
      assetCode: "USDC",
      stellarTxHash: "tx-missing-on-horizon",
      createdAt: windowStart,
      confirmedAt: windowStart,
    },
    // 2. Amount mismatch (DB says 100 USDC, Horizon says 80 USDC)
    {
      id: "db-mismatch",
      leagueId: "league-1",
      userId: "u-mismatch",
      type: "DEPOSIT",
      status: "CONFIRMED",
      amount: 100,
      assetCode: "USDC",
      stellarTxHash: "tx-amount-drift",
      createdAt: windowStart,
      confirmedAt: windowStart,
    },
    // 3. Stale pending record (DB stuck in PENDING, but Horizon succeeded)
    {
      id: "db-stale",
      leagueId: "league-1",
      userId: "u-stale",
      type: "DEPOSIT",
      status: "PENDING",
      amount: 25,
      assetCode: "USDC",
      stellarTxHash: "tx-succeeded-on-chain",
      createdAt: windowStart,
      confirmedAt: null,
    },
  ];

  const chainTxs: OnChainHorizonTransaction[] = [
    {
      txHash: "tx-amount-drift",
      ledgerSeq: 60001,
      successful: true,
      leagueId: "league-1",
      type: "DEPOSIT",
      amount: 80,
      assetCode: "USDC",
      timestamp: windowStart,
    },
    {
      txHash: "tx-succeeded-on-chain",
      ledgerSeq: 60002,
      successful: true,
      leagueId: "league-1",
      type: "DEPOSIT",
      amount: 25,
      assetCode: "USDC",
      timestamp: windowStart,
    },
    // 4. Unindexed on-chain payout (succeeded on Horizon, completely missing in DB)
    {
      txHash: "tx-unindexed-payout",
      ledgerSeq: 60003,
      successful: true,
      leagueId: "league-1",
      type: "PAYOUT",
      amount: 200,
      assetCode: "USDC",
      timestamp: windowStart,
    },
  ];

  const report = service.reconcileWindow({
    reportId: "recon-drift-test",
    windowStart,
    windowEnd,
    dbTransactions: dbTxs,
    onChainTransactions: chainTxs,
  });

  assert.equal(report.isBalanced, false);
  assert.equal(report.summary.discrepancyCount, 4);

  const categories = new Set(report.discrepancies.map((d) => d.category));
  assert.ok(categories.has("PHANTOM_DB_RECORD"));
  assert.ok(categories.has("AMOUNT_MISMATCH"));
  assert.ok(categories.has("STALE_PENDING_RECORD"));
  assert.ok(categories.has("UNINDEXED_ONCHAIN_TX"));

  const markdown = service.generateMarkdownAuditReport(report);
  assert.ok(markdown.includes("DISCREPANCY_DETECTED"));
  assert.ok(markdown.includes("PHANTOM_DB_RECORD"));
  assert.ok(markdown.includes("UNINDEXED_ONCHAIN_TX"));
});
