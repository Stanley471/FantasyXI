import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AccountSignals,
  SybilSignalType,
  analyzeSybilGraph,
  rateConfidence,
  subnetOf,
} from "../services/security/sybilDetectionGraph.js";
import {
  HorizonFunderResolver,
  PrismaSybilSignalSource,
  SybilDetectionGraphService,
} from "../services/security/sybilDetectionGraphService.js";
import { SecurityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";
import { createSybilReportHandler, createSybilUserBreakdownHandler } from "../controllers/securityAdmin.controller.js";
import { IRedisCacheClient } from "../config/redis.js";

/**
 * Detection tests against synthesized Sybil attack topologies (issue #274):
 * funding stars, shared login rings, coordinated squad submissions, chained
 * syndicates, and honest populations that must not be flagged.
 */

const T0 = new Date("2026-10-10T12:00:00Z").getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const SQUAD_A = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** An honest user: unique funder, IP, user agent and squad. */
function honest(i: number, extra: Partial<AccountSignals> = {}): AccountSignals {
  return {
    userId: `honest-${i}`,
    walletAddresses: [`GHONEST${i}`],
    funderAddresses: [`GFUNDER${i}`],
    logins: [{ ip: `10.${Math.floor(i / 250)}.${i % 250}.${(i * 7) % 250}`, userAgent: `Browser/${i}` }],
    squadSubmissions: [
      {
        squadId: `sq-honest-${i}`,
        leagueIds: ["paid-league"],
        playerIds: Array.from({ length: 15 }, (_, k) => 100 + ((i * 31 + k * 17) % 600)),
        submittedAt: at(i * 600),
      },
    ],
    ...extra,
  };
}

function clusterOf(report: ReturnType<typeof analyzeSybilGraph>, userId: string) {
  return report.clusters.find((c) => c.members.includes(userId));
}

describe("Sybil graph analysis: attack topologies (#274)", () => {
  it("detects a funding star: one wallet creating several accounts' wallets", () => {
    const sybils: AccountSignals[] = Array.from({ length: 5 }, (_, i) => ({
      userId: `sybil-${i}`,
      walletAddresses: [`GSYBIL${i}`],
      funderAddresses: ["GMASTER"],
    }));
    const master: AccountSignals = { userId: "mastermind", walletAddresses: ["GMASTER"], funderAddresses: ["GROOT"] };
    const report = analyzeSybilGraph([master, ...sybils, honest(1), honest(2)]);

    const cluster = clusterOf(report, "sybil-0");
    assert.ok(cluster, "funding star must form a cluster");
    assert.deepEqual(cluster.members, ["mastermind", "sybil-0", "sybil-1", "sybil-2", "sybil-3", "sybil-4"]);
    assert.equal(cluster.confidence, "HIGH");
    assert.ok((cluster.signalCounts[SybilSignalType.FUNDING_LINEAGE] ?? 0) >= 5);
    assert.ok((cluster.signalCounts[SybilSignalType.SHARED_FUNDER] ?? 0) >= 10);
    assert.equal(clusterOf(report, "honest-1"), undefined);

    const flagged = new Set(report.flaggedUsers.map((u) => u.userId));
    for (let i = 0; i < 5; i++) assert.ok(flagged.has(`sybil-${i}`));
    assert.ok(!flagged.has("honest-1"));
  });

  it("detects accounts sharing a login signature (same IP and browser)", () => {
    const ring: AccountSignals[] = ["a", "b", "c"].map((id) => ({
      userId: `ring-${id}`,
      logins: [{ ip: "203.0.113.50", userAgent: "Mozilla/5.0 (X11; Linux) Firefox/131.0" }],
    }));
    const report = analyzeSybilGraph([...ring, honest(1)]);
    const cluster = clusterOf(report, "ring-a");
    assert.equal(cluster?.size, 3);
    const edge = cluster!.edges[0];
    // The strongest network signal wins; IP and subnet are not double-counted
    assert.equal(edge.confidence, 0.75);
    assert.deepEqual(edge.signals.map((s) => s.type), [SybilSignalType.SHARED_LOGIN_SIGNATURE]);
  });

  it("detects shared client fingerprints across different IPs", () => {
    const report = analyzeSybilGraph([
      { userId: "fp-1", logins: [{ ip: "198.51.100.1", fingerprint: "fp:abc123" }] },
      { userId: "fp-2", logins: [{ ip: "192.0.2.77", fingerprint: "fp:abc123" }] },
    ]);
    assert.equal(clusterOf(report, "fp-1")?.edges[0].signals[0].type, SybilSignalType.SHARED_FINGERPRINT);
  });

  it("a shared subnet alone is weak evidence and does not cluster", () => {
    const report = analyzeSybilGraph([
      { userId: "n-1", logins: [{ ip: "198.51.100.10", userAgent: "A" }] },
      { userId: "n-2", logins: [{ ip: "198.51.100.20", userAgent: "B" }] },
    ]);
    assert.equal(report.edgeCount, 1);
    assert.equal(report.clusters.length, 0);
    assert.equal(report.flaggedUsers.length, 0);
  });

  it("flags collusive squad submissions with confidence ratings", () => {
    const submit = (userId: string, seconds: number, players = SQUAD_A, leagueId = "paid-league"): AccountSignals => ({
      userId,
      squadSubmissions: [{ squadId: `sq-${userId}`, leagueIds: [leagueId], playerIds: players, submittedAt: at(seconds) }],
    });
    const report = analyzeSybilGraph([
      submit("colluder-1", 0),
      submit("colluder-2", 30),
      // 14/15 shared players, 2 minutes later
      submit("colluder-3", 150, [...SQUAD_A.slice(0, 14), 99]),
      // Identical squad but 20 minutes later: outside the coordination window
      submit("late", 1200 + 150),
      // Identical squad in a different league: not a same-league collusion signal
      submit("elsewhere", 10, SQUAD_A, "other-league"),
    ]);

    const patterns = report.collusionPatterns;
    const pair = (a: string, b: string) =>
      patterns.find((p) => p.users.includes(a) && p.users.includes(b));
    const top = pair("colluder-1", "colluder-2")!;
    assert.equal(top.overlap, 1);
    assert.equal(top.secondsApart, 30);
    assert.equal(top.rating, "MEDIUM");
    assert.ok(top.confidence > 0.75 && top.confidence <= 0.8);
    assert.ok(pair("colluder-1", "colluder-3"));
    assert.equal(pair("colluder-1", "late"), undefined);
    assert.equal(pair("colluder-1", "elsewhere"), undefined);

    const cluster = clusterOf(report, "colluder-1");
    assert.deepEqual(cluster?.members, ["colluder-1", "colluder-2", "colluder-3"]);
  });

  it("weak signals combine across independent families", () => {
    // Same subnet (0.25) + coordinated squad (~0.79) => noisy-OR ~0.84: clustered and flagged
    const report = analyzeSybilGraph([
      {
        userId: "mix-1",
        logins: [{ ip: "198.51.100.10", userAgent: "A" }],
        squadSubmissions: [{ squadId: "s1", leagueIds: ["L"], playerIds: SQUAD_A, submittedAt: at(0) }],
      },
      {
        userId: "mix-2",
        logins: [{ ip: "198.51.100.99", userAgent: "B" }],
        squadSubmissions: [{ squadId: "s2", leagueIds: ["L"], playerIds: SQUAD_A, submittedAt: at(20) }],
      },
    ]);
    const edge = report.clusters[0].edges[0];
    assert.deepEqual(
      edge.signals.map((s) => s.type).sort(),
      [SybilSignalType.COORDINATED_SQUAD, SybilSignalType.SHARED_SUBNET].sort()
    );
    assert.ok(edge.confidence > 0.8);
    assert.equal(report.flaggedUsers.length, 2);
  });

  it("chains different signals into one syndicate cluster", () => {
    const report = analyzeSybilGraph([
      { userId: "chain-a", funderAddresses: ["GX"] },
      { userId: "chain-b", funderAddresses: ["GX"], logins: [{ ip: "192.0.2.5", userAgent: "UA" }] },
      { userId: "chain-c", logins: [{ ip: "192.0.2.5", userAgent: "UA" }] },
    ]);
    assert.deepEqual(clusterOf(report, "chain-a")?.members, ["chain-a", "chain-b", "chain-c"]);
  });

  it("damps hub attributes such as an exchange hot wallet or campus NAT", () => {
    const exchangeUsers: AccountSignals[] = Array.from({ length: 40 }, (_, i) => ({
      userId: `exchange-user-${i}`,
      funderAddresses: ["GEXCHANGEHOTWALLET"],
      logins: [{ ip: "100.64.0.1", userAgent: `Phone/${i}` }],
    }));
    const report = analyzeSybilGraph(exchangeUsers);
    assert.equal(report.clusters.length, 0, "shared infrastructure must not cluster everyone");
    assert.equal(report.flaggedUsers.length, 0);
  });

  it("ignores attributes beyond the fan-out cap entirely", () => {
    const users: AccountSignals[] = Array.from({ length: 30 }, (_, i) => ({
      userId: `u${i}`,
      funderAddresses: ["GFRIENDBOT"],
    }));
    const report = analyzeSybilGraph(users, { maxAttributeFanout: 25 });
    assert.equal(report.edgeCount, 0);
  });

  it("does not flag a large honest population, while still finding a hidden ring", () => {
    const population = Array.from({ length: 300 }, (_, i) => honest(i));
    const ring: AccountSignals[] = ["x", "y", "z"].map((id, k) => ({
      userId: `hidden-${id}`,
      walletAddresses: [`GHIDDEN${id}`],
      funderAddresses: ["GHIDDENFUNDER"],
      squadSubmissions: [{ squadId: `sq-hidden-${id}`, leagueIds: ["paid-league"], playerIds: SQUAD_A, submittedAt: at(5 + k * 40) }],
    }));
    const report = analyzeSybilGraph([...population, ...ring]);
    assert.equal(report.accountsAnalyzed, 303);
    assert.deepEqual(report.flaggedUsers.map((u) => u.userId).sort(), ["hidden-x", "hidden-y", "hidden-z"]);
    assert.equal(report.clusters.length, 1);
    assert.equal(report.clusters[0].confidence, "HIGH");
  });
});

describe("Sybil graph helpers (#274)", () => {
  it("derives IPv4 /24 and IPv6 /48 subnets, including IPv4-mapped addresses", () => {
    assert.equal(subnetOf("203.0.113.77"), "203.0.113.0/24");
    assert.equal(subnetOf("::ffff:203.0.113.77"), "203.0.113.0/24");
    assert.equal(subnetOf("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
    assert.equal(subnetOf("2001:db8::1"), "2001:db8:0::/48");
    assert.equal(subnetOf("not-an-ip"), null);
  });

  it("rates confidence bands", () => {
    assert.equal(rateConfidence(0.9), "HIGH");
    assert.equal(rateConfidence(0.7), "MEDIUM");
    assert.equal(rateConfidence(0.3), "LOW");
  });
});

// ---------------------------------------------------------------------------
// Service, data sources and admin endpoint
// ---------------------------------------------------------------------------

class MockRedis implements IRedisCacheClient {
  public store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
    return "OK";
  }
  async del(...keys: string[]) {
    return keys.filter((k) => this.store.delete(k)).length;
  }
  async keys() {
    return [...this.store.keys()];
  }
}

const RING: AccountSignals[] = [
  { userId: "r1", username: "alpha", funderAddresses: ["GM"] },
  { userId: "r2", username: "beta", funderAddresses: ["GM"] },
  { userId: "solo", username: "solo" },
];

describe("SybilDetectionGraphService (#274)", () => {
  it("caches reports in Redis and refreshes on demand", async () => {
    let loads = 0;
    const redis = new MockRedis();
    const service = new SybilDetectionGraphService({
      source: { loadAccountSignals: async () => (loads++, RING) },
      redis,
      anomalyLog: new SecurityAnomalyLog(),
    });

    const first = await service.generateReport({ leagueId: "L1" });
    await service.generateReport({ leagueId: "L1" });
    assert.equal(loads, 1);
    assert.ok(redis.store.has("sybil:report:L1"));

    await service.generateReport({ leagueId: "L1" }, { refresh: true });
    assert.equal(loads, 2);
    assert.equal(first.clusters[0].members.join(","), "r1,r2");
  });

  it("records each newly flagged account once in the security anomaly log", async () => {
    const anomalyLog = new SecurityAnomalyLog();
    const service = new SybilDetectionGraphService({
      source: { loadAccountSignals: async () => RING },
      redis: null,
      anomalyLog,
    });
    await service.generateReport({}, { refresh: true });
    await service.generateReport({}, { refresh: true });

    const entries = anomalyLog.query({ type: SecurityAnomalyType.SYBIL_CLUSTER_SUSPECTED });
    assert.deepEqual(entries.map((e) => e.userId).sort(), ["r1", "r2"]);
    assert.equal(entries[0].identifier, "cluster-r1");
    assert.equal((entries[0].detail as any).clusterSize, 2);
  });

  it("returns a per-user breakdown with cluster and evidence", async () => {
    const service = new SybilDetectionGraphService({
      source: { loadAccountSignals: async () => RING },
      redis: null,
      anomalyLog: new SecurityAnomalyLog(),
    });
    const flagged = await service.getUserBreakdown("r1");
    assert.equal(flagged.clusterId, "cluster-r1");
    assert.deepEqual(flagged.clusterMembers, ["r1", "r2"]);
    assert.equal(flagged.connections[0].signals[0].type, SybilSignalType.SHARED_FUNDER);
    assert.equal(flagged.assessment?.rating, "HIGH");

    const clean = await service.getUserBreakdown("solo");
    assert.equal(clean.clusterId, null);
    assert.equal(clean.riskScore, 0);
  });
});

describe("HorizonFunderResolver (#274)", () => {
  it("reads the funder of the account's create_account operation and caches it", async () => {
    let calls = 0;
    const redis = new MockRedis();
    const resolver = new HorizonFunderResolver({
      horizonUrl: "https://horizon.example/",
      redis,
      fetchImpl: (async (url: string) => {
        calls++;
        assert.equal(url, "https://horizon.example/accounts/GNEW/operations?order=asc&limit=1");
        return new Response(
          JSON.stringify({ _embedded: { records: [{ type: "create_account", funder: "GFUNDER" }] } }),
          { status: 200 }
        );
      }) as typeof fetch,
    });
    assert.deepEqual(await resolver.resolveFunders("GNEW"), ["GFUNDER"]);
    assert.deepEqual(await resolver.resolveFunders("GNEW"), ["GFUNDER"]);
    assert.equal(calls, 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(redis.store.get("sybil:funder:GNEW"), JSON.stringify(["GFUNDER"]));
  });

  it("caches unknown accounts but retries after transient failures", async () => {
    let calls = 0;
    const notFound = new HorizonFunderResolver({
      redis: null,
      fetchImpl: (async () => (calls++, new Response("", { status: 404 }))) as typeof fetch,
    });
    assert.deepEqual(await notFound.resolveFunders("GMISSING"), []);
    await notFound.resolveFunders("GMISSING");
    assert.equal(calls, 1);

    calls = 0;
    const flaky = new HorizonFunderResolver({
      redis: null,
      fetchImpl: (async () => {
        calls++;
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    });
    assert.deepEqual(await flaky.resolveFunders("GX"), []);
    await flaky.resolveFunders("GX");
    assert.equal(calls, 2);
  });
});

describe("PrismaSybilSignalSource (#274)", () => {
  it("assembles wallets, funders, login signatures and league squad submissions", async () => {
    let memberWhere: any;
    const updatedAt = new Date("2026-10-10T10:00:00Z");
    const db: any = {
      leagueMember: {
        findMany: async (args: any) => {
          memberWhere = args.where;
          return [
            { userId: "u1", leagueId: "L1", squadId: "s1", stellarAddress: "GPAYOUT1" },
            { userId: "u2", leagueId: "L1", squadId: "s2", stellarAddress: null },
          ];
        },
      },
      user: {
        findMany: async () => [
          {
            id: "u1",
            username: "one",
            wallet: { stellarAddress: "GWALLET1" },
            squads: [
              { id: "s1", updatedAt, players: [{ playerId: 1 }, { playerId: 2 }] },
              { id: "unentered", updatedAt, players: [] },
            ],
          },
          { id: "u2", username: "two", wallet: null, squads: [{ id: "s2", updatedAt, players: [] }] },
        ],
      },
    };
    const source = new PrismaSybilSignalSource({
      db,
      devices: {
        getKnownDevices: async (userId) =>
          userId === "u1" ? [{ ip: "203.0.113.9", userAgent: "UA", firstSeenAt: "2026-10-01" }] : [],
      },
      funderResolver: { resolveFunders: async (address) => (address === "GWALLET1" ? ["GROOT"] : []) },
    });

    const accounts = await source.loadAccountSignals({ leagueId: "L1" });
    assert.deepEqual(memberWhere, { leagueId: "L1" });
    const u1 = accounts.find((a) => a.userId === "u1")!;
    assert.deepEqual(u1.walletAddresses!.sort(), ["GPAYOUT1", "GWALLET1"]);
    assert.deepEqual(u1.funderAddresses, ["GROOT"]);
    assert.deepEqual(u1.logins, [{ ip: "203.0.113.9", userAgent: "UA" }]);
    assert.deepEqual(u1.squadSubmissions, [
      { squadId: "s1", leagueIds: ["L1"], playerIds: [1, 2], submittedAt: updatedAt },
    ]);
  });

  it("defaults to members of paid leagues that are upcoming or active", async () => {
    let memberWhere: any;
    const source = new PrismaSybilSignalSource({
      db: { leagueMember: { findMany: async (args: any) => ((memberWhere = args.where), []) } } as any,
      devices: { getKnownDevices: async () => [] },
      funderResolver: { resolveFunders: async () => [] },
    });
    assert.deepEqual(await source.loadAccountSignals({}), []);
    assert.deepEqual(memberWhere.league.entryFee, { gt: 0 });
    assert.deepEqual(memberWhere.league.status, { in: ["UPCOMING", "ACTIVE"] });
  });
});

describe("Sybil admin endpoints (#274)", () => {
  const response = () => {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (code: number) => ((res.statusCode = code), res);
    res.json = (body: unknown) => ((res.body = body), res);
    return res;
  };
  const service = new SybilDetectionGraphService({
    source: { loadAccountSignals: async () => RING },
    redis: null,
    anomalyLog: new SecurityAnomalyLog(),
  });

  it("returns the graph breakdown, filtered by minimum risk", async () => {
    const res = response();
    await createSybilReportHandler(service)({ query: { minRisk: "0.5" } } as any, res, assert.fail);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.clusters.length, 1);
    assert.deepEqual(res.body.data.clusters[0].members, ["r1", "r2"]);

    const strict = response();
    await createSybilReportHandler(service)({ query: { minRisk: "1" } } as any, strict, assert.fail);
    assert.equal(strict.body.data.flaggedUsers.length, 0);
  });

  it("rejects an invalid minRisk", async () => {
    const res = response();
    await createSybilReportHandler(service)({ query: { minRisk: "7" } } as any, res, assert.fail);
    assert.equal(res.statusCode, 400);
  });

  it("returns one user's breakdown", async () => {
    const res = response();
    await createSybilUserBreakdownHandler(service)(
      { query: {}, params: { userId: "r2" } } as any,
      res,
      assert.fail
    );
    assert.equal(res.body.data.clusterId, "cluster-r1");
  });
});
