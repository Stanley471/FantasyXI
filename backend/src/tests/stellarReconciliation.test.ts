import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeExpectedEscrowBalance,
  decimalToStroops,
  formatStroops,
  reconcileStellarEscrows,
  STELLAR_RECONCILIATION_CRON,
} from "../jobs/stellarReconciliation.js";
import { JOB_DEFINITIONS } from "../queues/jobQueue.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";
import { FinancialAuditAction } from "../services/audit/financialAuditLog.js";

const L1 = "11111111-1111-1111-1111-111111111111";
const L2 = "22222222-2222-2222-2222-222222222222";
const TOKEN = "CTOKEN";
const quiet = { log() {}, warn() {}, error() {} };

const tx = (type: string, amount: string, status = "CONFIRMED") => ({ type, amount, status });
const stroops = (usdc: number) => BigInt(Math.round(usdc * 1e7));
const league = (id: string, txs: any[]) => ({ id, name: `League ${id.slice(0, 2)}`, transactions: txs });

function harness(
  leagues: any[],
  chain: Record<string, bigint | null | Error>,
  tokenBalance: bigint | Error = 10n ** 12n
) {
  const audits: any[] = [];
  const alerts: any[] = [];
  const deps = {
    db: { league: { findMany: async () => leagues } },
    stellar: {
      getContractLeagueState: async (id: bigint) => {
        const entry = chain[id.toString()];
        if (entry instanceof Error) throw entry;
        if (entry === null || entry === undefined) return null;
        return {
          total_deposited: entry,
          token_address: TOKEN,
          participant_count: 0,
          status: 1,
          entry_fee: 0n,
          creator: "G",
        };
      },
      getContractTokenBalance: async () => {
        if (tokenBalance instanceof Error) throw tokenBalance;
        return tokenBalance;
      },
    } as any,
    audit: { record: (e: any) => void audits.push(e) },
    alerts: {
      notify: async (a: any) => {
        alerts.push(a);
        return { slack: "skipped", email: { sent: 0, failed: 0 } };
      },
    } as any,
    logger: quiet,
  };
  return { deps, audits, alerts };
}

describe("stellar escrow reconciliation", () => {
  it("converts decimals to exact stroops and back", () => {
    assert.equal(decimalToStroops("10.00"), 100_000_000n);
    assert.equal(decimalToStroops(0.1), 1_000_000n);
    assert.equal(decimalToStroops("1234.5678901"), 12_345_678_901n);
    assert.equal(formatStroops(12_345_678_901n), "1234.5678901");
    assert.equal(formatStroops(-5n), "-0.0000005");
    assert.throws(() => decimalToStroops("abc"));
    assert.throws(() => decimalToStroops("1.00000001"));
  });

  it("computes (participants * entryFee) - (payouts + refunds) from confirmed rows only", () => {
    const r = computeExpectedEscrowBalance([
      tx("ENTRY_FEE", "10.00"),
      tx("ENTRY_FEE", "10.00"),
      tx("ENTRY_FEE", "10.00"),
      tx("REFUND", "10.00"),
      tx("PRIZE_PAYOUT", "5.50"),
      tx("ENTRY_FEE", "10.00", "FAILED"),
    ]);
    assert.equal(r.participants, 3);
    assert.equal(r.expected, stroops(14.5));
  });

  it("is scheduled every 6 hours", () => {
    assert.equal(STELLAR_RECONCILIATION_CRON, "0 */6 * * *");
    const def = JOB_DEFINITIONS.find((j) => j.name === "stellar-reconciliation");
    assert.ok(def);
    assert.equal(def.cron, "0 */6 * * *");
  });

  it("reports balanced leagues without alerts or false alarms", async () => {
    const h = harness(
      [
        league(L1, [tx("ENTRY_FEE", "10.00"), tx("ENTRY_FEE", "10.00")]),
        league(L2, [tx("ENTRY_FEE", "5.00"), tx("ENTRY_FEE", "5.00"), tx("REFUND", "5.00")]),
      ],
      {
        [toContractLeagueId(L1).toString()]: stroops(20),
        [toContractLeagueId(L2).toString()]: stroops(5),
      }
    );
    const report = await reconcileStellarEscrows(h.deps);
    assert.equal(report.balanced, 2);
    assert.equal(report.drifted, 0);
    assert.deepEqual(report.flaggedLeagueIds, []);
    assert.equal(h.alerts.length, 0);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].action, FinancialAuditAction.RECONCILIATION_BALANCED);
  });

  it("detects drift, flags the league, audits and sends a critical alert", async () => {
    const h = harness(
      [league(L1, [tx("ENTRY_FEE", "10.00"), tx("ENTRY_FEE", "10.00")]), league(L2, [tx("ENTRY_FEE", "5.00")])],
      {
        [toContractLeagueId(L1).toString()]: stroops(20) - 1n, // 1 stroop short
        [toContractLeagueId(L2).toString()]: stroops(5),
      }
    );
    const report = await reconcileStellarEscrows(h.deps);
    assert.equal(report.drifted, 1);
    assert.equal(report.balanced, 1);
    assert.deepEqual(report.flaggedLeagueIds, [L1]);
    const entry = report.leagues.find((l) => l.leagueId === L1)!;
    assert.equal(entry.status, "DRIFT");
    assert.equal(entry.driftStroops, "-1");
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].severity, "critical");
    assert.match(h.alerts[0].text, new RegExp(L1));
    const audit = h.audits.find((a) => a.leagueId === L1);
    assert.equal(audit.action, FinancialAuditAction.RECONCILIATION_DISCREPANCY);
    assert.equal(audit.metadata.flaggedForInspection, true);
  });

  it("flags a league missing from the contract that expects funds, but not an empty one", async () => {
    const h = harness([league(L1, [tx("ENTRY_FEE", "10.00")]), league(L2, [])], {});
    const report = await reconcileStellarEscrows(h.deps);
    assert.deepEqual(report.flaggedLeagueIds, [L1]);
    assert.equal(report.leagues.find((l) => l.leagueId === L2)!.status, "BALANCED");
  });

  it("defers leagues with in-flight transactions instead of raising false alarms", async () => {
    const h = harness([league(L1, [tx("ENTRY_FEE", "10.00"), tx("ENTRY_FEE", "10.00", "SUBMITTED")])], {
      [toContractLeagueId(L1).toString()]: stroops(20), // chain already ahead of the DB
    });
    const report = await reconcileStellarEscrows(h.deps);
    assert.equal(report.skippedInFlight, 1);
    assert.equal(report.drifted, 0);
    assert.equal(h.alerts.length, 0);
  });

  it("treats RPC failures as unverified, not as drift", async () => {
    const h = harness([league(L1, [tx("ENTRY_FEE", "10.00")])], {
      [toContractLeagueId(L1).toString()]: new Error("rpc timeout"),
    });
    const report = await reconcileStellarEscrows(h.deps);
    assert.equal(report.unverified, 1);
    assert.equal(report.drifted, 0);
    assert.equal(h.alerts.length, 0);
  });

  it("raises a solvency alert when the token balance is below required funds", async () => {
    const h = harness(
      [league(L1, [tx("ENTRY_FEE", "10.00")])],
      { [toContractLeagueId(L1).toString()]: stroops(10) },
      stroops(4)
    );
    const report = await reconcileStellarEscrows(h.deps);
    assert.equal(report.drifted, 0);
    assert.equal(report.solvencyShortfalls.length, 1);
    assert.equal(report.solvencyShortfalls[0].shortfallStroops, stroops(6).toString());
    assert.equal(h.alerts.length, 1);
  });

  it("does not alert when the token balance exceeds requirements (other leagues share the contract)", async () => {
    const h = harness(
      [league(L1, [tx("ENTRY_FEE", "10.00")])],
      { [toContractLeagueId(L1).toString()]: stroops(10) },
      stroops(500)
    );
    const report = await reconcileStellarEscrows(h.deps);
    assert.equal(report.solvencyShortfalls.length, 0);
    assert.equal(h.alerts.length, 0);
  });
});
