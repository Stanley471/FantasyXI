import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  baseTxHash,
  decimalToStroops,
  formatStroops,
  HorizonLookupResult,
  LedgerReconciliationService,
  OnChainMovement,
  parseEscrowEvent,
  reportToJson,
  reportToMarkdown,
  SorobanEscrowEventSource,
} from "../services/financial/ledgerReconciliationService.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";
import { FinancialAuditAction } from "../services/audit/financialAuditLog.js";
import { AdminAlert } from "../services/notifications/adminAlertNotifier.js";
import { TransactionStatus, TransactionType } from "../types/index.js";

const LEAGUE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const LEAGUE_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CONTRACT_A = toContractLeagueId(LEAGUE_A).toString();
const CONTRACT_B = toContractLeagueId(LEAGUE_B).toString();
const ALICE = Keypair.random().publicKey();
const BOB = Keypair.random().publicKey();
const h = (label: string) => Buffer.from(label.padEnd(32, "_")).toString("hex").slice(0, 64);
const usdc = (amount: string) => decimalToStroops(amount);
const CLOSED_AT = "2026-10-17T10:00:00Z";

let rowSeq = 0;
function row(type: TransactionType, stellarTxHash: string, amount: string, extra: Record<string, unknown> = {}) {
  rowSeq++;
  return {
    id: `row-${rowSeq}`,
    userId: `user-${rowSeq}`,
    leagueId: LEAGUE_A,
    memberId: null,
    type,
    amount,
    stellarTxHash,
    ledgerSeq: 1_000 + rowSeq,
    confirmedAt: new Date(CLOSED_AT),
    createdAt: new Date(CLOSED_AT),
    ...extra,
  };
}

function movement(kind: OnChainMovement["kind"], txHash: string, extra: Partial<OnChainMovement> = {}): OnChainMovement {
  return {
    kind,
    txHash,
    ledgerSeq: 1_500,
    closedAt: CLOSED_AT,
    eventType: kind === "DEPOSIT" ? "deposit" : kind === "REFUND" ? "refund" : kind === "PRIZE_CLAIM" ? "claimed" : "settle",
    contractLeagueId: CONTRACT_A,
    ...extra,
  };
}

/** A balanced ledger: every DB row has its on-chain counterpart. */
function cleanFixture() {
  const rows = [
    // Soroban deposit
    row(TransactionType.ENTRY_FEE, h("deposit-ok"), "10.00", { memberId: "m-alice" }),
    // Settlement: two winners + platform fee written by executeSettlement, and the
    // same fee indexed again from the settle event (`-fee` suffix)
    row(TransactionType.PRIZE_PAYOUT, h("settle-ok"), "13.30", { userId: "winner-1" }),
    row(TransactionType.PRIZE_PAYOUT, h("settle-ok"), "5.70", { userId: "winner-2" }),
    row(TransactionType.PLATFORM_FEE, h("settle-ok"), "1.00"),
    // Batched refund: one hash shared by two members
    row(TransactionType.REFUND, h("refund-ok"), "10.00", { memberId: "m-1" }),
    row(TransactionType.REFUND, `${h("refund-ok")}-m-2`, "10.00", { memberId: "m-2" }),
    // Indexed prize claim
    row(TransactionType.PRIZE_PAYOUT, `${h("claim-ok")}-${ALICE}`, "13.30", { userId: "winner-1" }),
    // Classic USDC payment verified through Horizon (no contract event)
    row(TransactionType.ENTRY_FEE, h("classic-ok"), "10.00", { memberId: "m-bob" }),
  ];
  const movements = [
    movement("DEPOSIT", h("deposit-ok"), { address: ALICE, amountStroops: usdc("10") }),
    movement("PRIZE_ALLOCATION", h("settle-ok"), { amountStroops: usdc("19") }),
    movement("PLATFORM_FEE", h("settle-ok"), { amountStroops: usdc("1") }),
    movement("REFUND", h("refund-ok"), { count: 2 }),
    movement("PRIZE_CLAIM", h("claim-ok"), { address: ALICE, amountStroops: usdc("13.3") }),
  ];
  const horizon: Record<string, HorizonLookupResult> = {
    [h("classic-ok")]: { status: "SUCCESS", ledgerSeq: 1_008, usdcTransferredStroops: usdc("10") },
  };
  return { rows, movements, horizon };
}

function createService(input: { rows: any[]; movements: OnChainMovement[]; horizon: Record<string, HorizonLookupResult> }) {
  const audits: any[] = [];
  const alerts: AdminAlert[] = [];
  const horizonCalls: string[] = [];
  let lastWhere: any;
  const service = new LedgerReconciliationService({
    db: {
      transaction: {
        findMany: async ({ where }: any) => {
          lastWhere = where;
          return input.rows;
        },
      },
    },
    events: { fetchMovements: async () => ({ movements: input.movements, fromLedger: 1_000, toLedger: 2_000 }) },
    horizon: {
      lookup: async (txHash) => {
        horizonCalls.push(txHash);
        return input.horizon[txHash] ?? { status: "NOT_FOUND" };
      },
    },
    audit: { record: (entry) => audits.push(entry) },
    alerts: {
      notify: async (alert) => {
        alerts.push(alert);
        return { slack: "sent", email: { sent: 1, failed: 0 } };
      },
    },
    now: () => new Date("2026-10-17T12:00:00Z"),
  });
  return { service, audits, alerts, horizonCalls, getWhere: () => lastWhere };
}

describe("LedgerReconciliationService", () => {
  it("reports a balanced ledger with no false positives", async () => {
    const { service, audits, alerts, getWhere } = createService(cleanFixture());
    const report = await service.reconcile();

    assert.equal(report.status, "BALANCED", JSON.stringify(report.discrepancies, null, 2));
    assert.equal(report.summary.discrepancies, 0);
    assert.equal(report.summary.matched, 5);
    assert.equal(report.summary.verifiedViaHorizon, 1);
    assert.deepEqual(report.ledgerRange, { from: 1_000, to: 2_000 });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, FinancialAuditAction.RECONCILIATION_BALANCED);
    assert.equal(alerts.length, 0);

    // Only CONFIRMED rows inside the scanned ledger range are compared
    const where = getWhere();
    assert.equal(where.status, TransactionStatus.CONFIRMED);
    assert.deepEqual(where.OR[0], { ledgerSeq: { gte: 1_000, lte: 2_000 } });
  });

  it("identifies 100% of injected discrepancies", async () => {
    const fixture = cleanFixture();
    // 1. Phantom: CONFIRMED in the DB, unknown to the network
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("phantom-missing"), "10.00"));
    // 2. Phantom: CONFIRMED in the DB, failed on-chain
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("phantom-failed"), "10.00"));
    fixture.horizon[h("phantom-failed")] = { status: "FAILED", ledgerSeq: 1_600 };
    // 3. Unindexed on-chain deposit (dropped indexer event)
    fixture.movements.push(movement("DEPOSIT", h("unindexed"), { address: BOB, amountStroops: usdc("10") }));
    // 4. Amount mismatch on a contract deposit
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("amount-mismatch"), "10.00"));
    fixture.movements.push(movement("DEPOSIT", h("amount-mismatch"), { amountStroops: usdc("7.5") }));
    // 5. Amount mismatch on a classic payment verified through Horizon
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("classic-mismatch"), "10.00"));
    fixture.horizon[h("classic-mismatch")] = { status: "SUCCESS", usdcTransferredStroops: usdc("1") };
    // 6. Refund event covers fewer members than were marked refunded
    fixture.rows.push(row(TransactionType.REFUND, h("refund-count"), "10.00", { memberId: "r-1" }));
    fixture.rows.push(row(TransactionType.REFUND, h("refund-count"), "10.00", { memberId: "r-2" }));
    fixture.rows.push(row(TransactionType.REFUND, h("refund-count"), "10.00", { memberId: "r-3" }));
    fixture.movements.push(movement("REFUND", h("refund-count"), { count: 2 }));
    // 7. Ledger row attached to the wrong league
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("wrong-league"), "10.00", { leagueId: LEAGUE_B }));
    fixture.movements.push(movement("DEPOSIT", h("wrong-league"), { amountStroops: usdc("10") }));
    // 8. One deposit claimed by two members
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("double-claim"), "10.00", { memberId: "x-1" }));
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("double-claim"), "10.00", { memberId: "x-2" }));
    fixture.movements.push(movement("DEPOSIT", h("double-claim"), { amountStroops: usdc("10") }));
    // 9. Platform fee accrued in the DB with a settle hash that emitted no fee and moved no USDC
    fixture.rows.push(row(TransactionType.PLATFORM_FEE, h("no-event"), "1.00"));
    fixture.horizon[h("no-event")] = { status: "SUCCESS", usdcTransferredStroops: 0n };
    // 10. Unindexed settlement (both allocation and fee missing from the DB)
    fixture.movements.push(movement("PRIZE_ALLOCATION", h("settle-unindexed"), { amountStroops: usdc("38") }));
    fixture.movements.push(movement("PLATFORM_FEE", h("settle-unindexed"), { amountStroops: usdc("2") }));

    const { service, audits, alerts } = createService(fixture);
    const report = await service.reconcile();

    const found = new Set(report.discrepancies.map((d) => `${d.type}:${d.txHash}`));
    const expected = [
      `PHANTOM_DB_RECORD:${h("phantom-missing")}`,
      `PHANTOM_DB_RECORD:${h("phantom-failed")}`,
      `UNINDEXED_ON_CHAIN:${h("unindexed")}`,
      `AMOUNT_MISMATCH:${h("amount-mismatch")}`,
      `AMOUNT_MISMATCH:${h("classic-mismatch")}`,
      `COUNT_MISMATCH:${h("refund-count")}`,
      `LEAGUE_MISMATCH:${h("wrong-league")}`,
      `DUPLICATE_DB_RECORD:${h("double-claim")}`,
      `MISSING_CONTRACT_EVENT:${h("no-event")}`,
      `UNINDEXED_ON_CHAIN:${h("settle-unindexed")}`,
    ];
    for (const key of expected) assert.ok(found.has(key), `missing ${key}`);

    // No clean record is flagged
    const clean = ["deposit-ok", "settle-ok", "refund-ok", "claim-ok", "classic-ok"].map(h);
    assert.ok(report.discrepancies.every((d) => !clean.includes(d.txHash)));
    // The two missing settle movements are reported separately
    assert.equal(report.discrepancies.filter((d) => d.txHash === h("settle-unindexed")).length, 2);
    assert.equal(report.discrepancies.length, expected.length + 1);

    const mismatch = report.discrepancies.find((d) => d.txHash === h("amount-mismatch"))!;
    assert.equal(mismatch.dbAmount, "10.0000000");
    assert.equal(mismatch.onChainAmount, "7.5000000");
    assert.equal(mismatch.timestamp, CLOSED_AT);
    assert.equal(mismatch.ledgerSeq, 1_500);
    assert.equal(mismatch.transactionIds.length, 1);

    const count = report.discrepancies.find((d) => d.type === "COUNT_MISMATCH")!;
    assert.equal(count.dbCount, 3);
    assert.equal(count.onChainCount, 2);

    const phantomFailed = report.discrepancies.find((d) => d.txHash === h("phantom-failed"))!;
    assert.match(phantomFailed.message, /failed on-chain/);

    // Critical findings sort first; the doubly-recorded deposit is critical, missing fee event a warning
    assert.equal(report.discrepancies[0].severity, "critical");
    assert.equal(report.discrepancies.find((d) => d.type === "MISSING_CONTRACT_EVENT")!.severity, "warning");
    assert.equal(report.summary.bySeverity.warning, 1);

    assert.equal(audits[0].action, FinancialAuditAction.RECONCILIATION_DISCREPANCY);
    assert.equal(audits[0].metadata.summary.discrepancies, report.discrepancies.length);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "critical");
    assert.match(alerts[0].text, new RegExp(h("phantom-missing")));
  });

  it("flags a fee recorded twice (executeSettlement + indexer) as a warning but keeps amounts matched", async () => {
    const fixture = cleanFixture();
    fixture.rows.push(row(TransactionType.PLATFORM_FEE, `${h("settle-ok")}-fee`, "1.00"));
    const { service } = createService(fixture);
    const report = await service.reconcile({ notify: false });

    assert.equal(report.discrepancies.length, 1);
    assert.equal(report.discrepancies[0].type, "DUPLICATE_DB_RECORD");
    assert.equal(report.discrepancies[0].severity, "warning");
    assert.equal(report.discrepancies[0].dbCount, 2);
  });

  it("tolerates 2-decimal ledger rounding but not a cent of real drift", async () => {
    const within = cleanFixture();
    within.movements[0] = movement("DEPOSIT", h("deposit-ok"), { amountStroops: usdc("10.0049999") });
    assert.equal((await createService(within).service.reconcile()).status, "BALANCED");

    const drift = cleanFixture();
    drift.movements[0] = movement("DEPOSIT", h("deposit-ok"), { amountStroops: usdc("10.01") });
    const report = await createService(drift).service.reconcile({ notify: false });
    assert.equal(report.discrepancies[0].type, "AMOUNT_MISMATCH");
  });

  it("looks up each unmatched hash on Horizon only once and survives Horizon outages", async () => {
    const fixture = cleanFixture();
    fixture.rows.push(row(TransactionType.PRIZE_PAYOUT, h("outage"), "5.00", { userId: "w1" }));
    fixture.rows.push(row(TransactionType.PLATFORM_FEE, h("outage"), "1.00"));
    const { service, horizonCalls } = createService(fixture);
    (service as any).horizon = {
      lookup: async (txHash: string) => {
        horizonCalls.push(txHash);
        if (txHash === h("outage")) throw new Error("Horizon 503");
        return fixture.horizon[txHash] ?? { status: "NOT_FOUND" };
      },
    };
    const report = await service.reconcile({ notify: false });
    assert.equal(horizonCalls.filter((c) => c === h("outage")).length, 1);
    assert.equal(report.discrepancies.filter((d) => d.txHash === h("outage")).length, 2);
  });

  it("does not alert when notify is false", async () => {
    const fixture = cleanFixture();
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("phantom-quiet"), "10.00"));
    const { service, alerts, audits } = createService(fixture);
    const report = await service.reconcile({ notify: false });
    assert.equal(report.status, "DISCREPANCIES_FOUND");
    assert.equal(alerts.length, 0);
    assert.equal(audits.length, 1);
  });

  it("renders JSON and Markdown audit reports with hashes and timestamps", async () => {
    const fixture = cleanFixture();
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("phantom-report"), "10.00"));
    const { service } = createService(fixture);
    const report = await service.reconcile({ notify: false, trigger: "cli" });

    const parsed = JSON.parse(reportToJson(report));
    assert.equal(parsed.runId, report.runId);
    assert.equal(parsed.discrepancies[0].txHash, h("phantom-report"));

    const markdown = reportToMarkdown(report);
    assert.match(markdown, /^# Ledger Reconciliation Report/);
    assert.match(markdown, /DISCREPANCIES FOUND/);
    assert.match(markdown, new RegExp(`\`${h("phantom-report")}\``));
    assert.match(markdown, /PHANTOM_DB_RECORD/);
    assert.match(markdown, new RegExp(CLOSED_AT.replace(/[.:]/g, ".").slice(0, 16)));
    assert.match(markdown, /\(cli\)/);

    const balanced = reportToMarkdown(await createService(cleanFixture()).service.reconcile());
    assert.match(balanced, /No discrepancies found/);
  });

  it("escapes backslashes, pipes and newlines in Markdown table cells", async () => {
    const fixture = cleanFixture();
    fixture.rows.push(row(TransactionType.ENTRY_FEE, h("escape"), "10.00"));
    const { service } = createService(fixture);
    const report = await service.reconcile({ notify: false });
    report.discrepancies[0].message = "a\\|b | c\nd";

    const tableRow = reportToMarkdown(report).split("\n").find((l) => l.includes(h("escape")))!;
    assert.ok(tableRow.includes("a\\\\\\|b \\| c d"), tableRow);
    // The row still has exactly 10 cells (11 unescaped pipes)
    assert.equal(tableRow.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|").length - 1, 11);
  });
});

describe("Escrow event parsing", () => {
  const leagueU64 = () => nativeToScVal(BigInt(CONTRACT_A), { type: "u64" });
  const event = (name: string, value: xdr.ScVal, ok = true): any => ({
    topic: [xdr.ScVal.scvSymbol(name), leagueU64()],
    value,
    txHash: h(`evt-${name}`).toUpperCase(),
    ledger: 321,
    ledgerClosedAt: CLOSED_AT,
    inSuccessfulContractCall: ok,
  });

  it("parses deposit, settle, claimed and refund events", () => {
    const [deposit] = parseEscrowEvent(
      event("deposit", nativeToScVal([ALICE, 100_000_000n], { type: ["address", "i128"] }))
    );
    assert.equal(deposit.kind, "DEPOSIT");
    assert.equal(deposit.address, ALICE);
    assert.equal(deposit.amountStroops, 100_000_000n);
    assert.equal(deposit.contractLeagueId, CONTRACT_A);
    assert.equal(deposit.txHash, h("evt-deposit"), "hashes are normalized to lower case");

    // total_payout includes the platform fee
    const settle = parseEscrowEvent(event("settle", nativeToScVal([200_000_000n, 10_000_000n], { type: ["i128", "i128"] })));
    assert.deepEqual(
      settle.map((m) => [m.kind, m.amountStroops]),
      [
        ["PRIZE_ALLOCATION", 190_000_000n],
        ["PLATFORM_FEE", 10_000_000n],
      ]
    );

    const [claim] = parseEscrowEvent(event("claimed", nativeToScVal([BOB, 5n], { type: ["address", "i128"] })));
    assert.equal(claim.kind, "PRIZE_CLAIM");
    assert.equal(claim.address, BOB);

    const [refund] = parseEscrowEvent(event("refund", nativeToScVal(3, { type: "u32" })));
    assert.equal(refund.kind, "REFUND");
    assert.equal(refund.count, 3);

    assert.deepEqual(parseEscrowEvent(event("created", nativeToScVal(1, { type: "u32" }))), []);
  });

  it("ignores events from failed contract calls", () => {
    assert.deepEqual(
      parseEscrowEvent(event("deposit", nativeToScVal([ALICE, 1n], { type: ["address", "i128"] }), false)),
      []
    );
  });

  it("pages through getEvents within the requested range and RPC retention", async () => {
    const mk = (ledger: number, n: number) => ({
      ...event("deposit", nativeToScVal([ALICE, BigInt(n)], { type: ["address", "i128"] })),
      ledger,
      txHash: h(`page-${n}`),
    });
    const pages = [
      { events: [mk(500, 1), mk(510, 2)], cursor: "c1" },
      { events: [mk(520, 3), mk(900, 4)], cursor: "c2" },
    ];
    const requests: any[] = [];
    const stellar: any = {
      getRpcLedgerRange: async () => ({ oldestLedger: 500, latestLedger: 1_000 }),
      getEscrowContractEvents: async (params: any) => {
        requests.push(params);
        return pages.shift() ?? { events: [], cursor: "end" };
      },
    };
    const source = new SorobanEscrowEventSource(stellar, 2);
    const batch = await source.fetchMovements({ fromLedger: 100, toLedger: 600, lookbackLedgers: 10 });

    assert.equal(batch.fromLedger, 500, "clamped to the oldest retained ledger");
    assert.equal(batch.toLedger, 600);
    assert.deepEqual(requests[0], { startLedger: 500, limit: 2 });
    assert.deepEqual(requests[1], { cursor: "c1", limit: 2 });
    assert.equal(requests.length, 2, "stops once events pass toLedger");
    assert.deepEqual(batch.movements.map((m) => m.amountStroops), [1n, 2n, 3n]);
  });
});

describe("Reconciliation amount helpers", () => {
  it("converts decimals to stroops exactly", () => {
    assert.equal(decimalToStroops("10"), 100_000_000n);
    assert.equal(decimalToStroops("0.1"), 1_000_000n);
    assert.equal(decimalToStroops("13.30"), 133_000_000n);
    assert.equal(decimalToStroops(1.5), 15_000_000n);
    assert.equal(decimalToStroops({ toString: () => "2.25" }), 22_500_000n);
    assert.equal(decimalToStroops("-0.0000001"), -1n);
    assert.throws(() => decimalToStroops("abc"));
    assert.equal(formatStroops(133_000_000n), "13.3000000");
    assert.equal(formatStroops(-25_000_000n), "-2.5000000");
  });

  it("strips ledger hash suffixes", () => {
    assert.equal(baseTxHash(`${h("x").toUpperCase()}-fee`), h("x"));
    assert.equal(baseTxHash(`${h("x")}-${ALICE}`), h("x"));
  });
});
