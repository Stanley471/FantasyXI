import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ChipType } from "../types/index.js";
import {
  InMemoryLeaderboardRedis,
  LiveProvisionalLeaderboardService,
  ProvisionalLeaderboardLoader,
  decodeScore,
  encodeScore,
  primeProvisionalLeaderboard,
  reconcileProvisionalLeaderboard,
  type ProvisionalRankUpdate,
  type ProvisionalSeed,
} from "../services/live/liveProvisionalLeaderboard.js";

/**
 * Live provisional leaderboard (issue #268): ZSET tie-breaking, Redis-only
 * ingestion, SSE fan-out, reconciliation and a stress test across 1,000 leagues.
 */

const GW = 7;

function newService(redis = new InMemoryLeaderboardRedis(), gateway: any = null) {
  return { redis, service: new LiveProvisionalLeaderboardService(() => redis, gateway) };
}

/** Three squads in one league: A joined first, then B, then C. */
function smallSeed(): ProvisionalSeed {
  return {
    leagues: [
      {
        leagueId: "L1",
        members: [
          { squadId: "C", basePoints: 100, joinedAt: "2026-08-03T00:00:00Z" },
          { squadId: "A", basePoints: 100, joinedAt: "2026-08-01T00:00:00Z" },
          { squadId: "B", basePoints: 104, joinedAt: "2026-08-02T00:00:00Z" },
        ],
      },
    ],
    squads: [
      { squadId: "A", players: [{ playerId: 10, multiplier: 2 }, { playerId: 11, multiplier: 1 }] },
      { squadId: "B", livePoints: -4, players: [{ playerId: 11, multiplier: 2 }, { playerId: 12, multiplier: 0 }] },
      { squadId: "C", players: [{ playerId: 12, multiplier: 1 }, { playerId: 10, multiplier: 1 }] },
    ],
  };
}

describe("LiveProvisionalLeaderboardService (issue #268)", () => {
  describe("score encoding", () => {
    it("round-trips totals and live points, including negatives", () => {
      for (const [total, live] of [[0, 0], [1234, 87], [-8, -8], [50, -12], [99999, 1499]]) {
        assert.deepEqual(decodeScore(encodeScore(total, live, 4321)), { points: total, livePoints: live });
      }
    });

    it("orders by total, then live points, then the tie-break component", () => {
      assert.ok(encodeScore(101, 0, 0) > encodeScore(100, 99, 99_998));
      assert.ok(encodeScore(100, 10, 0) > encodeScore(100, 9, 99_998));
      assert.ok(encodeScore(100, 10, 2) > encodeScore(100, 10, 1));
    });

    it("rejects live points outside the encodable range", () => {
      assert.throws(() => encodeScore(0, -501, 0), RangeError);
      assert.throws(() => encodeScore(0, 1500, 0), RangeError);
    });
  });

  describe("priming and tie-breaking", () => {
    it("ranks equal totals by live points, then earliest join", async () => {
      const { service } = newService();
      await service.prime(GW, smallSeed());
      // A 100 (live 0, joined 1st), B 104-4 = 100 (live -4), C 100 (live 0, joined 3rd)
      const standings = await service.getStandings(GW, "L1");
      assert.deepEqual(
        standings.map((s) => [s.rank, s.squadId, s.points, s.livePoints]),
        [
          [1, "A", 100, 0],
          [2, "C", 100, 0],
          [3, "B", 100, -4],
        ]
      );
    });

    it("re-priming replaces previous state", async () => {
      const { service } = newService();
      await service.prime(GW, smallSeed());
      await service.ingestEvents(GW, [{ playerId: 10, pointsDelta: 5 }]);
      await service.prime(GW, smallSeed());
      const standings = await service.getStandings(GW, "L1");
      assert.equal(standings[0].points, 100);
    });
  });

  describe("ingestion", () => {
    let service: LiveProvisionalLeaderboardService;
    beforeEach(async () => {
      ({ service } = newService());
      await service.prime(GW, smallSeed());
    });

    it("applies multipliers and reports rank and point diffs", async () => {
      // Player 11 scores 6: A gets 6 (x1), B gets 12 (captain), C does not own him
      const result = await service.ingestEvents(GW, [{ playerId: 11, pointsDelta: 6 }]);
      assert.equal(result.squadsUpdated, 2);
      const changes = new Map(result.updates[0].changes.map((c) => [c.squadId, c]));
      assert.deepEqual(changes.get("B"), {
        squadId: "B",
        previousRank: 3,
        rank: 1,
        points: 112,
        livePoints: 8,
        pointsDelta: 12,
      });
      assert.equal(changes.get("A")!.points, 106);

      const standings = await service.getStandings(GW, "L1");
      assert.deepEqual(standings.map((s) => s.squadId), ["B", "A", "C"]);
    });

    it("ignores bench players with a zero multiplier", async () => {
      const result = await service.ingestEvents(GW, [{ playerId: 12, pointsDelta: 9 }]);
      assert.equal(result.squadsUpdated, 1);
      assert.equal(result.updates[0].changes[0].squadId, "C");
    });

    it("handles negative events (cards, own goals)", async () => {
      await service.ingestEvents(GW, [{ playerId: 10, pointsDelta: -1 }]);
      const standings = await service.getStandings(GW, "L1");
      const a = standings.find((s) => s.squadId === "A")!;
      assert.equal(a.points, 98);
      assert.equal(a.livePoints, -2);
    });

    it("aggregates a batch of events for the same player", async () => {
      await service.ingestEvents(GW, [
        { playerId: 10, pointsDelta: 2 },
        { playerId: 10, pointsDelta: 4 },
        { playerId: 10, pointsDelta: 0 },
      ]);
      const a = (await service.getStandings(GW, "L1")).find((s) => s.squadId === "A")!;
      assert.equal(a.livePoints, 12);
    });

    it("applies absolute player totals idempotently", async () => {
      await service.ingestPlayerTotals(GW, [{ playerId: 10, totalPoints: 5 }]);
      const replay = await service.ingestPlayerTotals(GW, [{ playerId: 10, totalPoints: 5 }]);
      assert.equal(replay.playersApplied, 0, "replaying the same poll must not double count");
      await service.ingestPlayerTotals(GW, [{ playerId: 10, totalPoints: 7 }]);
      const a = (await service.getStandings(GW, "L1")).find((s) => s.squadId === "A")!;
      assert.equal(a.livePoints, 14);
    });

    it("mixes event deltas and totals consistently", async () => {
      await service.ingestEvents(GW, [{ playerId: 10, pointsDelta: 3 }]);
      const result = await service.ingestPlayerTotals(GW, [{ playerId: 10, totalPoints: 3 }]);
      assert.equal(result.playersApplied, 0);
    });

    it("does nothing for players nobody owns", async () => {
      const result = await service.ingestEvents(GW, [{ playerId: 999, pointsDelta: 6 }]);
      assert.equal(result.squadsUpdated, 0);
      assert.deepEqual(result.updates, []);
    });
  });

  describe("fan-out", () => {
    it("pushes diffs and fresh standings to league subscribers until they unsubscribe", async () => {
      const gatewayCalls: Array<[string, string, any]> = [];
      const gateway = {
        broadcast: () => undefined,
        broadcastToLeague: (leagueId: string, event: string, payload: any) => {
          gatewayCalls.push([leagueId, event, payload]);
        },
      };
      const { service } = newService(new InMemoryLeaderboardRedis(), gateway);
      await service.prime(GW, smallSeed());

      const received: ProvisionalRankUpdate[] = [];
      const unsubscribe = service.subscribe("L1", (u) => received.push(u));
      await service.ingestEvents(GW, [{ playerId: 11, pointsDelta: 6 }]);

      assert.equal(received.length, 1);
      assert.equal(received[0].reason, "event");
      assert.deepEqual(received[0].standings!.map((s) => s.squadId), ["B", "A", "C"]);
      assert.equal(gatewayCalls[0][1], "PROVISIONAL_RANKS_UPDATED");

      unsubscribe();
      await service.ingestEvents(GW, [{ playerId: 11, pointsDelta: 1 }]);
      assert.equal(received.length, 1);
    });

    it("omits standings when nobody is watching the league", async () => {
      const { service } = newService();
      await service.prime(GW, smallSeed());
      const result = await service.ingestEvents(GW, [{ playerId: 11, pointsDelta: 6 }]);
      assert.equal(result.updates[0].standings, undefined);
    });
  });

  describe("reconciliation", () => {
    it("realigns ranks with final scores and reports discrepancies", async () => {
      const { service } = newService();
      await service.prime(GW, smallSeed());
      await service.ingestEvents(GW, [{ playerId: 10, pointsDelta: 6 }]); // A +12, C +6

      // Final scores differ: A's captain was auto-subbed (vice scored less), B unchanged
      const final = new Map([
        ["A", 7],
        ["B", -4],
        ["C", 6],
      ]);
      const received: ProvisionalRankUpdate[] = [];
      service.subscribe("L1", (u) => received.push(u));
      const report = await service.reconcile(GW, final);

      assert.equal(report.leaguesReconciled, 1);
      assert.equal(report.membersReconciled, 3);
      assert.deepEqual(report.discrepancies, [
        { leagueId: "L1", squadId: "A", provisionalPoints: 112, finalPoints: 107 },
      ]);
      assert.deepEqual(report.missingFinalScores, []);

      const standings = await service.getStandings(GW, "L1");
      assert.deepEqual(
        standings.map((s) => [s.squadId, s.points, s.livePoints]),
        [
          ["A", 107, 7],
          ["C", 106, 6],
          ["B", 100, -4],
        ]
      );
      assert.equal(received[0].reason, "reconciled");
    });

    it("flags squads missing a final score and treats them as zero", async () => {
      const { service } = newService();
      await service.prime(GW, smallSeed());
      const report = await service.reconcile(GW, new Map([["A", 3], ["C", 1]]));
      assert.deepEqual(report.missingFinalScores, ["B"]);
      const b = (await service.getStandings(GW, "L1")).find((s) => s.squadId === "B")!;
      assert.equal(b.points, 104);
    });

    it("clears all gameweek state", async () => {
      const { service } = newService();
      await service.prime(GW, smallSeed());
      await service.clear(GW);
      assert.deepEqual(await service.getStandings(GW, "L1"), []);
    });
  });
});

describe("ProvisionalLeaderboardLoader (issue #268)", () => {
  function fakeDb() {
    const calls: string[] = [];
    const track = (name: string, value: unknown) => async () => {
      calls.push(name);
      return value;
    };
    const db = {
      league: {
        findMany: track("league.findMany", [
          {
            id: "L1",
            startGameweekId: 5,
            endGameweekId: 10,
            members: [
              { squadId: "S1", joinedAt: new Date("2026-08-01") },
              { squadId: "S2", joinedAt: new Date("2026-08-02") },
            ],
          },
          {
            id: "L2",
            startGameweekId: 6,
            endGameweekId: 8,
            members: [{ squadId: "S1", joinedAt: new Date("2026-08-05") }],
          },
        ]),
      },
      squadGameweekScore: {
        findMany: async ({ where }: any) => {
          calls.push("squadGameweekScore.findMany");
          if (where.gameweekId?.equals !== undefined || typeof where.gameweekId === "number") {
            return [
              { squadId: "S1", points: 70 },
              { squadId: "S2", points: 55 },
            ];
          }
          return [
            { squadId: "S1", gameweekId: 5, points: 50 },
            { squadId: "S1", gameweekId: 6, points: 60 },
            { squadId: "S2", gameweekId: 6, points: 40 },
          ];
        },
      },
      squadPlayer: {
        findMany: track("squadPlayer.findMany", [
          { squadId: "S1", playerId: 1, isStarter: true, isCaptain: true },
          { squadId: "S1", playerId: 2, isStarter: true, isCaptain: false },
          { squadId: "S1", playerId: 3, isStarter: false, isCaptain: false },
          { squadId: "S2", playerId: 1, isStarter: true, isCaptain: false },
          { squadId: "S2", playerId: 2, isStarter: true, isCaptain: true },
          { squadId: "S2", playerId: 3, isStarter: false, isCaptain: false },
        ]),
      },
      squadChipUsage: {
        findMany: track("squadChipUsage.findMany", [{ squadId: "S2", chipType: ChipType.TRIPLE_CAPTAIN }]),
      },
      squadTransfer: {
        groupBy: track("squadTransfer.groupBy", [{ squadId: "S1", _sum: { pointsCost: 8 } }]),
      },
      playerGameweekStats: {
        findMany: track("playerGameweekStats.findMany", [
          { playerId: 1, totalPoints: 2 },
          { playerId: 1, totalPoints: 6 },
          { playerId: 2, totalPoints: 1 },
        ]),
      },
    };
    return { db, calls };
  }

  it("builds multipliers, hits and windowed base points", async () => {
    const { db } = fakeDb();
    const seed = await new ProvisionalLeaderboardLoader(db).loadSeed(7);

    const s1 = seed.squads.find((s) => s.squadId === "S1")!;
    const s2 = seed.squads.find((s) => s.squadId === "S2")!;
    assert.equal(s1.livePoints, -8);
    assert.deepEqual(s1.players, [
      { playerId: 1, multiplier: 2 },
      { playerId: 2, multiplier: 1 },
      { playerId: 3, multiplier: 0 },
    ]);
    assert.deepEqual(s2.players.map((p) => p.multiplier), [1, 3, 0], "Triple Captain triples the captain");

    const l1 = seed.leagues.find((l) => l.leagueId === "L1")!;
    const l2 = seed.leagues.find((l) => l.leagueId === "L2")!;
    assert.equal(l1.members.find((m) => m.squadId === "S1")!.basePoints, 110);
    assert.equal(l2.members[0].basePoints, 60, "only gameweeks inside the league window count");
  });

  it("sums double gameweek player totals", async () => {
    const { db } = fakeDb();
    const totals = await new ProvisionalLeaderboardLoader(db).loadPlayerTotals(7);
    assert.deepEqual(totals, [
      { playerId: 1, totalPoints: 8 },
      { playerId: 2, totalPoints: 1 },
    ]);
  });

  it("primes, streams with zero database reads, then reconciles from final scores", async () => {
    const { db, calls } = fakeDb();
    const loader = new ProvisionalLeaderboardLoader(db);
    const { service } = newService();

    await primeProvisionalLeaderboard(7, service, loader);
    const primeReads = calls.length;
    assert.ok(primeReads > 0);

    for (let i = 0; i < 50; i++) {
      await service.ingestEvents(7, [{ playerId: 1 + (i % 3), pointsDelta: 1 + (i % 4) }]);
    }
    await service.ingestPlayerTotals(7, [{ playerId: 1, totalPoints: 40 }]);
    assert.equal(calls.length, primeReads, "live ingestion must not query the database");

    const report = await reconcileProvisionalLeaderboard(7, service, loader);
    assert.equal(report.leaguesReconciled, 2);
    const l1 = await service.getStandings(7, "L1");
    assert.deepEqual(
      l1.map((s) => [s.squadId, s.points]),
      [
        ["S1", 110 + 70],
        ["S2", 40 + 55],
      ]
    );
  });
});

/**
 * CPU time (ms) this process spends running `fn`. Test files run in parallel,
 * so wall-clock time measures contention from other suites rather than the
 * leaderboard; process CPU time measures the work the service actually does.
 */
async function cpuMs(fn: () => Promise<unknown>): Promise<number> {
  const start = process.cpuUsage();
  await fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

describe("LiveProvisionalLeaderboardService stress test (issue #268)", () => {
  const LEAGUES = 1_000;
  const LEAGUE_SIZE = 20;
  const SQUADS = 5_000;
  const PLAYERS = 300;

  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  function buildWorld() {
    const rand = rng(268);
    const squads = Array.from({ length: SQUADS }, (_, i) => {
      const ids = new Set<number>();
      while (ids.size < 15) ids.add(1 + Math.floor(rand() * PLAYERS));
      const players = [...ids].map((playerId, idx) => ({
        playerId,
        multiplier: idx === 0 ? 2 : idx < 11 ? 1 : 0,
      }));
      return { squadId: `S${i}`, livePoints: rand() < 0.1 ? -4 : 0, players };
    });
    const leagues = Array.from({ length: LEAGUES }, (_, l) => ({
      leagueId: `L${l}`,
      members: Array.from({ length: LEAGUE_SIZE }, (_, m) => ({
        squadId: `S${(l * LEAGUE_SIZE + m * 7) % SQUADS}`,
        basePoints: Math.floor(rand() * 40) * 5,
        joinedAt: new Date(Date.UTC(2026, 7, 1, 0, m)).toISOString(),
      })),
    }));
    const events = Array.from({ length: 1_000 }, () => ({
      playerId: 1 + Math.floor(rand() * PLAYERS),
      pointsDelta: [1, 2, 3, 4, 5, 6, -1, -2][Math.floor(rand() * 8)],
    }));
    return { seed: { leagues, squads }, events };
  }

  /** Brute-force standings: total desc, live desc, earliest join. */
  function expectedStandings(seed: ProvisionalSeed, events: Array<{ playerId: number; pointsDelta: number }>) {
    const live = new Map(seed.squads.map((s) => [s.squadId, s.livePoints ?? 0]));
    const holders = new Map<number, Array<[string, number]>>();
    for (const s of seed.squads) {
      for (const p of s.players) {
        const list = holders.get(p.playerId) ?? [];
        list.push([s.squadId, p.multiplier]);
        holders.set(p.playerId, list);
      }
    }
    for (const e of events) {
      for (const [squadId, multiplier] of holders.get(e.playerId) ?? []) {
        live.set(squadId, live.get(squadId)! + e.pointsDelta * multiplier);
      }
    }
    return new Map(
      seed.leagues.map((league) => [
        league.leagueId,
        league.members
          .map((m, joinIdx) => ({ squadId: m.squadId, total: m.basePoints + live.get(m.squadId)!, live: live.get(m.squadId)!, joinIdx }))
          .sort((a, b) => b.total - a.total || b.live - a.live || a.joinIdx - b.joinIdx)
          .map((m) => [m.squadId, m.total]),
      ])
    );
  }

  it("streams 1,000 events across 1,000 leagues with sub-50ms p95 latency and exact final ranks", async () => {
    const { seed, events } = buildWorld();
    const { service } = newService();
    await service.prime(GW, seed);

    const latencies: number[] = [];
    for (const e of events) {
      latencies.push(await cpuMs(() => service.ingestEvents(GW, [e])));
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    assert.ok(p95 < 50, `p95 latency ${p95.toFixed(2)}ms`);

    const expected = expectedStandings(seed, events);
    for (const leagueId of ["L0", "L1", "L499", "L998", "L999"]) {
      const actual = (await service.getStandings(GW, leagueId)).map((s) => [s.squadId, s.points]);
      assert.deepEqual(actual, expected.get(leagueId), `league ${leagueId} mismatch`);
    }
  });

  it("keeps state exact under concurrent event bursts", async () => {
    const world = buildWorld();
    const seed = world.seed;
    const events = world.events.slice(0, 300);
    const { service } = newService();
    await service.prime(GW, seed);

    const used = await cpuMs(() => Promise.all(events.map((e) => service.ingestEvents(GW, [e]))));
    const perEvent = used / events.length;
    assert.ok(perEvent < 50, `mean ${perEvent.toFixed(2)}ms per event under concurrency`);

    const expected = expectedStandings(seed, events);
    for (const [leagueId, standings] of expected) {
      const actual = (await service.getStandings(GW, leagueId)).map((s) => [s.squadId, s.points]);
      assert.deepEqual(actual, standings, `league ${leagueId} mismatch`);
    }
  });

  it("updates every league in under a second when a player owned everywhere scores", async () => {
    const { seed } = buildWorld();
    for (const s of seed.squads) s.players[0] = { playerId: 9999, multiplier: 2 };
    const { service } = newService();
    await service.prime(GW, seed);

    let result!: Awaited<ReturnType<typeof service.ingestEvents>>;
    const elapsed = await cpuMs(async () => {
      result = await service.ingestEvents(GW, [{ playerId: 9999, pointsDelta: 6 }]);
    });
    assert.equal(result.updates.length, LEAGUES);
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(1)}ms`);
  });
});
