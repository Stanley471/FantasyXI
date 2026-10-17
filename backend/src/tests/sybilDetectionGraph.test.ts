import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SybilDetectionGraphService,
  type AccountActivityNode,
} from "../services/security/sybilDetectionGraphService.js";
import { securityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";
import { getSybilGraphReport } from "../controllers/securityAdmin.controller.js";

describe("Sybil Syndicate Detection Graph Analyzer (#274)", () => {
  it("detects multi-account clusters sharing Stellar funder wallets, IP subnets, and coordinated squad submissions", () => {
    securityAnomalyLog.clear();
    const analyzer = new SybilDetectionGraphService();

    const sharedSquad = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const baseTime = 1_760_000_000_000;

    const accounts: AccountActivityNode[] = [
      {
        userId: "sybil-1",
        stellarAddress: "GSYBIL1",
        funderStellarAddress: "GFUNDER_MASTER_999",
        ipAddresses: ["203.0.113.10"],
        deviceFingerprints: ["fp-cluster-alpha"],
        squadSubmissions: [
          { leagueId: "lg-1", playerIds: sharedSquad, captainId: 9, submittedAtMs: baseTime },
        ],
      },
      {
        userId: "sybil-2",
        stellarAddress: "GSYBIL2",
        funderStellarAddress: "GFUNDER_MASTER_999",
        ipAddresses: ["203.0.113.45"], // same /24 subnet
        deviceFingerprints: ["fp-cluster-alpha"],
        squadSubmissions: [
          {
            leagueId: "lg-1",
            playerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 99], // 14/16 = 87.5% Jaccard
            captainId: 9,
            submittedAtMs: baseTime + 12_000,
          },
        ],
      },
      {
        userId: "sybil-3",
        stellarAddress: "GSYBIL3",
        funderStellarAddress: "GFUNDER_MASTER_999",
        ipAddresses: ["203.0.113.88"],
        squadSubmissions: [
          {
            leagueId: "lg-1",
            playerIds: sharedSquad,
            captainId: 9,
            submittedAtMs: baseTime + 25_000,
          },
        ],
      },
      {
        userId: "honest-user-1",
        stellarAddress: "GHONEST1",
        funderStellarAddress: "GCOINBASE_HOT_WALLET_1",
        ipAddresses: ["198.51.100.7"],
        deviceFingerprints: ["fp-honest-macbook"],
        squadSubmissions: [
          {
            leagueId: "lg-1",
            playerIds: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35],
            captainId: 25,
            submittedAtMs: baseTime - 3_600_000,
          },
        ],
      },
    ];

    const report = analyzer.analyzeAccounts(accounts);

    assert.equal(report.totalAccountsAnalyzed, 4);
    assert.equal(report.flaggedAccountsCount, 3);
    assert.equal(report.clusters.length, 1);

    const cluster = report.clusters[0];
    assert.deepEqual(cluster.memberUserIds.sort(), ["sybil-1", "sybil-2", "sybil-3"]);
    assert.equal(cluster.confidence, "CRITICAL");
    assert.ok(cluster.dominantSignals.includes("SHARED_WALLET_FUNDER"));
    assert.ok(cluster.dominantSignals.includes("SHARED_IP_SUBNET"));
    assert.ok(cluster.dominantSignals.includes("COORDINATED_SQUAD_SUBMISSION"));

    const honestProfile = report.userProfiles.find((p) => p.userId === "honest-user-1")!;
    assert.equal(honestProfile.flagged, false);
    assert.equal(honestProfile.riskScore, 0);

    // Verify anomaly log recorded the syndicate cluster
    const anomalies = securityAnomalyLog.query({
      type: SecurityAnomalyType.SYBIL_SYNDICATE_DETECTED,
    });
    assert.equal(anomalies.length, 1);
  });

  it("exposes actionable cluster breakdown via getSybilGraphReport admin endpoint", async () => {
    let statusCode = 0;
    let body: any = null;

    const req: any = {
      body: {
        accounts: [
          {
            userId: "bot-a",
            funderStellarAddress: "GBOTFUNDER",
            deviceFingerprints: ["fp-shared-bot"],
          },
          {
            userId: "bot-b",
            funderStellarAddress: "GBOTFUNDER",
            deviceFingerprints: ["fp-shared-bot"],
          },
        ],
      },
    };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };

    await getSybilGraphReport(req, res, (err) => {
      if (err) throw err;
    });

    assert.equal(statusCode, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.flaggedAccountsCount, 2);
    assert.equal(body.data.clusters.length, 1);
    assert.equal(body.data.clusters[0].confidence, "CRITICAL");
  });
});
