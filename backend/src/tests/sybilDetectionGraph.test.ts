import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  analyzeSybilGraph,
  DEFAULT_SYBIL_POLICY,
  SybilDetectionGraphService,
  SybilLeagueNotFoundError,
  type SybilAccountNode,
} from "../services/security/sybilDetectionGraph.js";
import { AccountSignalRecorder, toSubnet } from "../services/security/accountSignals.js";
import { SecurityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";
import type { IRedisCacheClient } from "../config/redis.js";

/**
 * Sybil-ring detection (issue #274) against synthesized attack topologies:
 * funding trees, shared devices, coordinated squads and mixed syndicates,
 * next to honest populations that share hubs (faucets, exchanges, NAT).
 */

const T0 = new Date("2026-10-10T12:00:00Z").getTime();
const minutes = (n: number) => new Date(T0 + n * 60_000);
const TEMPLATE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const FRIENDBOT = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";

function account(userId: string, overrides: Partial<SybilAccountNode> = {}): SybilAccountNode {
  return {
    userId,
    username: userId,
    stellarAddresses: [`G${userId.toUpperCase()}`],
    // Distinct squads created hours apart: no coordination by default
    squad: { createdAt: minutes(Number.parseInt(userId.replace(/\D/g, "") || "0", 10) * 600), playerIds: TEMPLATE.map((p) => p + userId.length * 100) },
    transfers: [],
    signals: [],
    ...overrides,
  };
}

const analyze = (nodes: SybilAccountNode[], funders: Record<string, string> = {}, fanout: Record<string, number> = {}) =>
  analyzeSybilGraph({ nodes, funders: new Map(Object.entries(funders)), globalFanout: new Map(Object.entries(fanout)) });

const clusterOf = (result: ReturnType<typeof analyze>, userId: string) =>
  result.clusters.find((cluster) => cluster.members.some((member) => member.userId === userId));

describe("Sybil graph: funding lineage (#274)", () => {
  it("clusters wallets created by one master account and the member who owns it", () => {
    const ring = ["s1", "s2", "s3", "s4"].map((id) => account(id));
    const master = account("boss", { stellarAddresses: ["GMASTER"] });
    const honest = ["h1", "h2", "h3"].map((id) => account(id));
    const funders = Object.fromEntries([
      ...ring.map((node) => [node.stellarAddresses[0], "GMASTER"]),
      ...honest.map((node, i) => [node.stellarAddresses[0], `GEXCHANGE${i}`]),
    ]);

    const result = analyze([...ring, master, ...honest], funders);

    assert.equal(result.clusters.length, 1);
    const [cluster] = result.clusters;
    assert.deepEqual(cluster.members.map((m) => m.userId).sort(), ["boss", "s1", "s2", "s3", "s4"]);
    assert.equal(cluster.rating, "HIGH");
    assert.equal(cluster.links.length, 10, "complete graph over 5 accounts sharing one lineage key");
    assert.deepEqual(cluster.links[0].evidence, [{ type: "FUNDING_LINEAGE", confidence: 0.85, values: ["GMASTER"] }]);
    for (const member of cluster.members) assert.ok(member.riskScore > 0.99);
    assert.ok(result.accounts.every((a) => a.flagged && a.clusterId === cluster.id));
    assert.equal(clusterOf(result, "h1"), undefined, "honest users are not linked");
  });

  it("ignores Friendbot and suppresses funder hubs such as exchange hot wallets", () => {
    const testnet = Array.from({ length: 6 }, (_, i) => account(`t${i}`));
    const exchange = Array.from({ length: 6 }, (_, i) => account(`e${i}`));
    const funders = Object.fromEntries([
      ...testnet.map((node) => [node.stellarAddresses[0], FRIENDBOT]),
      ...exchange.map((node) => [node.stellarAddresses[0], "GEXCHANGEHOT"]),
    ]);

    // The exchange funded 5,000 accounts platform-wide
    const result = analyze([...testnet, ...exchange], funders, { "FUNDER:GEXCHANGEHOT": 5000 });

    assert.deepEqual(result.clusters, []);
    assert.deepEqual(result.suppressedSignals, [{ signal: "FUNDER:GEXCHANGEHOT", accounts: 5000 }]);
  });
});

describe("Sybil graph: login signatures (#274)", () => {
  it("links a shared fingerprinted device but not a shared subnet alone", () => {
    const result = analyze([
      account("a1", { signals: [{ type: "DEVICE", value: "dev-1" }] }),
      account("a2", { signals: [{ type: "DEVICE", value: "dev-1" }] }),
      account("b1", { signals: [{ type: "IP_SUBNET", value: "198.51.100.0/24" }] }),
      account("b2", { signals: [{ type: "IP_SUBNET", value: "198.51.100.0/24" }] }),
    ]);

    assert.equal(result.clusters.length, 1);
    assert.deepEqual(result.clusters[0].members.map((m) => m.userId).sort(), ["a1", "a2"]);
    assert.equal(result.clusters[0].confidence, 0.7);
    assert.equal(result.clusters[0].rating, "MEDIUM");
    assert.equal(clusterOf(result, "b1"), undefined, "same household network is weak evidence");
  });

  it("combines independent signals by noisy-OR", () => {
    const signals = [
      { type: "DEVICE" as const, value: "dev-9" },
      { type: "IP_SUBNET" as const, value: "2001:db8:1:2::/64" },
    ];
    const result = analyze([account("c1", { signals }), account("c2", { signals })]);
    // 1 - (1 - 0.7)(1 - 0.3) = 0.79
    assert.equal(result.clusters[0].links[0].confidence, 0.79);
    assert.deepEqual(result.clusters[0].links[0].evidence.map((e) => e.type).sort(), ["SHARED_DEVICE", "SHARED_SUBNET"]);
  });

  it("suppresses carrier-grade NAT and campus networks shared by many accounts", () => {
    const signals = [{ type: "IP_SUBNET" as const, value: "100.64.0.0/24" }];
    const crowd = Array.from({ length: 25 }, (_, i) => account(`n${i}`, { signals }));
    const result = analyze(crowd);
    assert.deepEqual(result.clusters, []);
    assert.deepEqual(result.suppressedSignals, [{ signal: "IP_SUBNET:100.64.0.0/24", accounts: 25 }]);
  });
});

describe("Sybil graph: coordinated squad submissions (#274)", () => {
  const transfer = (gw: number, playerIn: number, playerOut: number, at: Date) => ({
    gameweekId: gw,
    playerInId: playerIn,
    playerOutId: playerOut,
    at,
  });

  it("flags identical squads created together that mirror each other's transfers", () => {
    const ring = ["q1", "q2", "q3"].map((id, i) =>
      account(id, {
        squad: { createdAt: minutes(i * 2), playerIds: TEMPLATE },
        transfers: [transfer(5, 99, 3, minutes(3000 + i)), transfer(6, 98, 7, minutes(4000 + i))],
      })
    );
    const result = analyze(ring);

    assert.equal(result.clusters.length, 1);
    const link = result.clusters[0].links[0];
    // 0.85 x Jaccard 1 x min(1, 0.5 + 0.125 x 2 mirrored transfers)
    assert.equal(link.confidence, 0.638);
    assert.equal(link.evidence[0].type, "COORDINATED_SQUAD");
    assert.match(link.evidence[0].values[0], /15 shared players \(Jaccard 1\), 2 mirrored transfers/);
    assert.equal(result.clusters[0].rating, "MEDIUM");
  });

  it("does not link popular template squads built at different times", () => {
    // 10 of 15 shared players, the same popular transfer made hours apart
    const a = account("p1", {
      squad: { createdAt: minutes(0), playerIds: TEMPLATE },
      transfers: [transfer(5, 99, 3, minutes(3000))],
    });
    const b = account("p2", {
      squad: { createdAt: minutes(600), playerIds: [...TEMPLATE.slice(0, 10), 51, 52, 53, 54, 55] },
      transfers: [transfer(5, 99, 3, minutes(3600))],
    });
    const twin = account("p3", { squad: { createdAt: minutes(5000), playerIds: TEMPLATE } });
    assert.deepEqual(analyze([a, b, twin]).clusters, [], "identical but uncoordinated squads are not evidence");
  });
});

describe("Sybil graph: mixed syndicates (#274)", () => {
  it("joins transitive links into one cluster with a per-link evidence breakdown", () => {
    const result = analyze(
      [
        account("m1", { signals: [{ type: "DEVICE", value: "laptop" }] }),
        account("m2", { signals: [{ type: "DEVICE", value: "laptop" }] }),
        account("m3"),
        account("m4"),
        account("honest"),
      ],
      { GM2: "GHUB", GM3: "GHUB" }
    );

    assert.equal(result.clusters.length, 1);
    const cluster = result.clusters[0];
    assert.equal(cluster.id, "cluster-1");
    assert.deepEqual(cluster.members.map((m) => m.userId).sort(), ["m1", "m2", "m3"]);
    assert.deepEqual(
      cluster.links.map((l) => [l.source, l.target, l.evidence[0].type]),
      [
        ["m2", "m3", "FUNDING_LINEAGE"],
        ["m1", "m2", "SHARED_DEVICE"],
      ]
    );
    // m2 bridges both links: highest risk
    assert.equal(cluster.members[0].userId, "m2");
    assert.equal(cluster.members[0].riskScore, 0.955);
    assert.deepEqual(
      result.accounts.filter((a) => a.flagged).map((a) => a.userId),
      ["m2", "m3"],
      "m1 (0.7) stays below the 0.8 flagging threshold"
    );
  });

  it("is deterministic for the same input", () => {
    const nodes = [
      account("x1", { signals: [{ type: "DEVICE", value: "d" }] }),
      account("x2", { signals: [{ type: "DEVICE", value: "d" }] }),
    ];
    assert.deepEqual(analyze(nodes), analyze(nodes));
  });
});

describe("Account signals (#274)", () => {
  it("normalizes client addresses to /24 and /64 networks", () => {
    assert.equal(toSubnet("203.0.113.77"), "203.0.113.0/24");
    assert.equal(toSubnet("::ffff:203.0.113.77"), "203.0.113.0/24");
    assert.equal(toSubnet("2001:db8:85a3::8a2e:370:7334"), "2001:db8:85a3:0::/64");
    assert.equal(toSubnet("2001:0db8:0001:0002:0003:0004:0005:0006"), "2001:db8:1:2::/64");
    assert.equal(toSubnet("::1"), "0:0:0:0::/64");
    assert.equal(toSubnet("fe80::1%eth0"), "fe80:0:0:0::/64");
    assert.equal(toSubnet("unknown"), null);
  });

  it("records a device only for fingerprinted browsers and never throws", async () => {
    const upserts: any[] = [];
    const recorder = new AccountSignalRecorder({ accountSignal: { upsert: async (args: any) => upserts.push(args) } });
    recorder.record("u1", { ip: "198.51.100.4", userAgent: "Chrome/130" });
    recorder.record("u1", { ip: "198.51.100.4", userAgent: "Chrome/130", deviceFingerprint: "a".repeat(32) });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(upserts.map((u) => u.create.type), ["IP_SUBNET", "DEVICE", "IP_SUBNET"]);
    assert.deepEqual(upserts[0].where, { type_value_userId: { type: "IP_SUBNET", value: "198.51.100.0/24", userId: "u1" } });
    assert.match(upserts.find((u) => u.create.type === "DEVICE").create.value, /^[0-9a-f]{64}$/);

    const broken = new AccountSignalRecorder({ accountSignal: { upsert: () => Promise.reject(new Error("db down")) } });
    assert.doesNotThrow(() => broken.record("u1", { ip: "198.51.100.4" }));
    assert.doesNotThrow(() => new AccountSignalRecorder({}).record("u1", { ip: "198.51.100.4" }));
  });
});

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
    return keys.filter((key) => this.store.delete(key)).length;
  }
  async keys() {
    return [...this.store.keys()];
  }
}

describe("SybilDetectionGraphService (#274)", () => {
  let funderRows: Array<{ address: string; funder: string }>;
  let resolved: string[];
  let anomalies: SecurityAnomalyLog;
  let redis: MockRedis;
  let queries: number;

  const member = (userId: string, address: string, createdAt: Date) => ({
    userId,
    stellarAddress: address,
    user: { username: `user-${userId}`, wallet: null, accountSignals: [] },
    squad: { createdAt, players: TEMPLATE.map((playerId) => ({ playerId: playerId + userId.charCodeAt(0) * 100 })), transfers: [] },
  });

  const db = {
    league: { findUnique: async ({ where }: any) => (where.id === "league-1" ? { id: "league-1" } : null) },
    leagueMember: {
      findMany: async () => {
        queries++;
        return [
          member("a", "GA", minutes(0)),
          member("b", "GB", minutes(600)),
          member("c", "GC", minutes(1200)),
          member("d", "GD", minutes(1800)),
        ];
      },
    },
    accountSignal: { groupBy: async () => [] },
    stellarAccountFunder: {
      findMany: async ({ where }: any) => funderRows.filter((row) => where.address.in.includes(row.address)),
      createMany: async ({ data }: any) => funderRows.push(...data),
      groupBy: async ({ where }: any) => {
        const counts = new Map<string, number>();
        for (const row of funderRows) {
          if (where.funder.in.includes(row.funder)) counts.set(row.funder, (counts.get(row.funder) ?? 0) + 1);
        }
        return [...counts].map(([funder, count]) => ({ funder, _count: { _all: count } }));
      },
    },
  };

  beforeEach(() => {
    // GA's funder is already cached; GB, GC, GD are resolved on Horizon
    funderRows = [{ address: "GA", funder: "GRING" }];
    resolved = [];
    anomalies = new SecurityAnomalyLog();
    redis = new MockRedis();
    queries = 0;
  });

  const service = () =>
    new SybilDetectionGraphService({
      db,
      redis,
      anomalyLog: anomalies,
      resolveFunder: async (address) => {
        resolved.push(address);
        return address === "GD" ? null : "GRING";
      },
    });

  it("resolves unknown funders once, flags the ring and caches the report", async () => {
    const report = await service().analyzeLeague("league-1");

    assert.deepEqual(resolved.sort(), ["GB", "GC", "GD"], "cached funders are not looked up again");
    assert.deepEqual(funderRows.map((r) => r.address).sort(), ["GA", "GB", "GC"], "unknown funders are not stored");
    assert.equal(report.memberCount, 4);
    assert.equal(report.clusters.length, 1);
    assert.deepEqual(report.clusters[0].members.map((m) => m.userId).sort(), ["a", "b", "c"]);
    assert.deepEqual(
      anomalies.query({ type: SecurityAnomalyType.SYBIL_CLUSTER_SUSPECTED }).map((e) => e.userId).sort(),
      ["a", "b", "c"]
    );

    const cached = await service().analyzeLeague("league-1");
    assert.deepEqual(cached, report);
    assert.equal(queries, 1, "served from the Redis report cache");

    await service().analyzeLeague("league-1", { refresh: true });
    assert.equal(queries, 2);
  });

  it("raises SybilLeagueNotFoundError for an unknown league", async () => {
    await assert.rejects(() => service().analyzeLeague("missing"), SybilLeagueNotFoundError);
  });

  it("returns the graph breakdown from the admin endpoint", async () => {
    const { getLeagueSybilReport } = await import("../controllers/securityAdmin.controller.js");
    const { sybilDetectionGraphService } = await import("../services/security/sybilDetectionGraph.js");
    Object.assign(sybilDetectionGraphService, { db, redis, anomalyLog: anomalies, resolveFunder: async () => "GRING" });

    const call = async (leagueId: string) => {
      let status = 200;
      let body: any;
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json(payload: unknown) {
          body = payload;
          return this;
        },
      } as unknown as Response;
      await getLeagueSybilReport({ params: { leagueId }, query: {} } as unknown as Request, res, (error) => {
        throw error;
      });
      return { status, body };
    };

    const ok = await call("league-1");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.clusters[0].links[0].evidence[0].type, "FUNDING_LINEAGE");
    assert.equal((await call("missing")).status, 404);
  });
});

describe("Sybil policy defaults (#274)", () => {
  it("needs corroboration before a weak network signal forms a link", () => {
    assert.ok(DEFAULT_SYBIL_POLICY.weights.SHARED_SUBNET < DEFAULT_SYBIL_POLICY.minLinkConfidence);
    assert.ok(DEFAULT_SYBIL_POLICY.ignoredFunders.has(FRIENDBOT));
  });
});
