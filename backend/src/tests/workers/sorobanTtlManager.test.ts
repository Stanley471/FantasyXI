import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SorobanTtlManagerWorker,
  DAY_IN_LEDGERS,
  FIVE_DAYS_TTL_SAFETY_THRESHOLD_LEDGERS,
  CONTRACT_BUMP_TARGET_LEDGERS,
  type ManagedLeagueRecord,
  type TtlAlertPayload,
} from "../../workers/sorobanTtlManager.js";

describe("SorobanTtlManagerWorker (#256)", () => {
  it("bumps TTL for Active and Upcoming leagues within 5 days of expiry and skips healthy or settled leagues", async () => {
    const leagues: ManagedLeagueRecord[] = [
      { id: "lg-healthy", onChainLeagueId: 101, status: "ACTIVE", participantCount: 10 },
      { id: "lg-expiring", onChainLeagueId: 102, status: "UPCOMING", participantCount: 75 },
      { id: "lg-archived", onChainLeagueId: 103, status: "ACTIVE", participantCount: 5 },
      { id: "lg-settled", onChainLeagueId: 104, status: "SETTLED", participantCount: 20 },
    ];

    const extendedLeagues: Array<{ leagueId: number | bigint; extendTo: number }> = [];
    const extendedPages: Array<{ leagueId: number | bigint; page: number }> = [];
    const alerts: TtlAlertPayload[] = [];

    const mockClient = {
      inspectLeagueTtl: async (leagueId: number | bigint) => {
        const idNum = Number(leagueId);
        if (idNum === 101) {
          return {
            leagueId: "101",
            latestLedger: 1_000_000,
            liveUntilLedgerSeq: 1_000_000 + 20 * DAY_IN_LEDGERS,
            remainingLedgers: 20 * DAY_IN_LEDGERS,
            needsRestore: false,
          };
        }
        if (idNum === 102) {
          // 3 days left (< 5-day safety threshold of 86,400 ledgers)
          return {
            leagueId: "102",
            latestLedger: 1_000_000,
            liveUntilLedgerSeq: 1_000_000 + 3 * DAY_IN_LEDGERS,
            remainingLedgers: 3 * DAY_IN_LEDGERS,
            needsRestore: false,
          };
        }
        // 103 is archived (needsRestore = true)
        return {
          leagueId: "103",
          latestLedger: 1_000_000,
          liveUntilLedgerSeq: 1_000_000,
          remainingLedgers: 0,
          needsRestore: true,
        };
      },
      extendLeagueTtl: async (
        _secret: string,
        leagueId: number | bigint,
        _threshold: number,
        extendTo: number
      ) => {
        extendedLeagues.push({ leagueId, extendTo });
        return { success: true, txHash: `tx-bump-${leagueId}` };
      },
      extendParticipantPageTtl: async (
        _secret: string,
        leagueId: number | bigint,
        page: number
      ) => {
        extendedPages.push({ leagueId, page });
        return { success: true, txHash: `tx-page-${leagueId}-${page}` };
      },
    };

    const worker = new SorobanTtlManagerWorker({
      contractClient: mockClient,
      signerSecret: "SDUMMYSECRET",
      fetchActiveLeagues: async () => leagues,
      onAlert: (alert) => {
        alerts.push(alert);
      },
    });

    const report = await worker.runOnce();

    // 3 eligible leagues inspected (lg-settled skipped)
    assert.equal(report.inspectedCount, 3);
    assert.deepEqual(report.bumpedLeagues, ["lg-expiring", "lg-archived"]);
    assert.deepEqual(report.restoredLeagues, ["lg-archived"]);
    assert.equal(report.failedLeagues.length, 0);

    // Verify 30-day bump target
    assert.equal(extendedLeagues.length, 2);
    assert.equal(extendedLeagues[0].extendTo, CONTRACT_BUMP_TARGET_LEDGERS);

    // lg-expiring has 75 participants -> 2 pages (0 and 1); lg-archived has 5 -> 1 page (0)
    assert.deepEqual(extendedPages, [
      { leagueId: 102, page: 0 },
      { leagueId: 102, page: 1 },
      { leagueId: 103, page: 0 },
    ]);

    const metrics = worker.getMetrics();
    assert.equal(metrics.scansCompleted, 1);
    assert.equal(metrics.leaguesInspected, 3);
    assert.equal(metrics.ttlBumpsTriggered, 2);
    assert.equal(metrics.restorationsTriggered, 1);
    assert.equal(metrics.participantPagesBumped, 3);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].severity, "WARNING");
    assert.equal(alerts[1].severity, "CRITICAL");
  });

  it("handles RPC failures and transaction congestion gracefully without crashing the worker loop", async () => {
    const leagues: ManagedLeagueRecord[] = [
      { id: "lg-rpc-error", onChainLeagueId: 201, status: "ACTIVE" },
      { id: "lg-congested", onChainLeagueId: 202, status: "UPCOMING" },
    ];

    const alerts: TtlAlertPayload[] = [];
    const mockClient = {
      inspectLeagueTtl: async (leagueId: number | bigint) => {
        if (Number(leagueId) === 201) {
          return {
            leagueId: "201",
            latestLedger: 0,
            needsRestore: false,
            error: "RPC timeout connecting to soroban-testnet.stellar.org",
          };
        }
        return {
          leagueId: "202",
          latestLedger: 500_000,
          liveUntilLedgerSeq: 500_000 + FIVE_DAYS_TTL_SAFETY_THRESHOLD_LEDGERS - 10,
          remainingLedgers: FIVE_DAYS_TTL_SAFETY_THRESHOLD_LEDGERS - 10,
          needsRestore: false,
        };
      },
      extendLeagueTtl: async () => ({
        success: false,
        error: "Transaction rejected: Soroban network congestion",
        isRetryable: true,
      }),
      extendParticipantPageTtl: async () => ({ success: true }),
    };

    const worker = new SorobanTtlManagerWorker({
      contractClient: mockClient,
      signerSecret: "SDUMMYSECRET",
      fetchActiveLeagues: async () => leagues,
      onAlert: (alert) => {
        alerts.push(alert);
      },
    });

    const report = await worker.runOnce();
    assert.equal(report.inspectedCount, 2);
    assert.equal(report.bumpedLeagues.length, 0);
    assert.equal(report.failedLeagues.length, 2);

    const metrics = worker.getMetrics();
    assert.equal(metrics.rpcErrors, 2);
    assert.ok(alerts.some((a) => a.severity === "CRITICAL" && a.leagueId === "lg-rpc-error"));
    assert.ok(alerts.some((a) => a.severity === "CRITICAL" && a.leagueId === "lg-congested"));
  });
});
