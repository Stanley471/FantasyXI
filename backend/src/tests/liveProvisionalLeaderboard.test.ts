import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveProvisionalLeaderboardService,
  type IRedisZSetClient,
  type IRedisZSetPipeline,
  type LeagueRankDiffPayload,
  type LiveMatchPointEvent,
} from "../services/live/liveProvisionalLeaderboardService.js";

/**
 * In-memory Redis ZSET mock that implements `IRedisZSetClient` and `pipeline()`
 * with `zincrby`, `zadd`, `zrevrange`, `del`.
 */
class MockRedisZSetClient implements IRedisZSetClient {
  private readonly zsets = new Map<string, Map<string, number>>();
  public pipelineCallCount = 0;
  public zincrbyCallCount = 0;

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      if (this.zsets.delete(k)) removed++;
    }
    return removed;
  }

  async zadd(key: string, ...args: Array<string | number>): Promise<number> {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    let added = 0;
    for (let i = 0; i < args.length; i += 2) {
      const score = Number(args[i]);
      const member = String(args[i + 1]);
      if (!set.has(member)) added++;
      set.set(member, score);
    }
    return added;
  }

  async zincrby(key: string, increment: number, member: string): Promise<string> {
    this.zincrbyCallCount++;
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    const next = (set.get(member) ?? 0) + increment;
    set.set(member, next);
    return String(next);
  }

  async zrevrange(
    key: string,
    start: number,
    stop: number,
    withScores?: "WITHSCORES"
  ): Promise<string[]> {
    const set = this.zsets.get(key);
    if (!set) return [];
    const sorted = [...set.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const end = stop < 0 ? sorted.length : stop + 1;
    const slice = sorted.slice(start, end);
    const out: string[] = [];
    for (const [member, score] of slice) {
      out.push(member);
      if (withScores === "WITHSCORES") {
        out.push(String(score));
      }
    }
    return out;
  }

  pipeline(): IRedisZSetPipeline {
    this.pipelineCallCount++;
    const ops: Array<() => Promise<[Error | null, unknown]>> = [];
    const pipe: IRedisZSetPipeline = {
      zincrby: (key: string, increment: number, member: string) => {
        ops.push(async () => [null, await this.zincrby(key, increment, member)]);
        return pipe;
      },
      zadd: (key: string, ...args: Array<string | number>) => {
        ops.push(async () => [null, await this.zadd(key, ...args)]);
        return pipe;
      },
      del: (...keys: string[]) => {
        ops.push(async () => [null, await this.del(...keys)]);
        return pipe;
      },
      exec: async () => Promise.all(ops.map((fn) => fn())),
    };
    return pipe;
  }

  getZSetScore(key: string, member: string): number | undefined {
    return this.zsets.get(key)?.get(member);
  }
}

test("LiveProvisionalLeaderboardService: zero DB reads during live match event stream updates, tie-breaking, and SSE/WebSocket diff broadcasting", async () => {
  const redis = new MockRedisZSetClient();

  let dbReadsLocked = false;
  const baseDb = {
    league: {
      findMany: async () => [
        {
          id: "league-alpha",
          status: "ACTIVE",
          startGameweekId: 1,
          endGameweekId: 38,
          members: [
            {
              userId: "user-1",
              squadId: "squad-1",
              joinedAt: new Date("2026-08-01T10:00:00Z"),
              user: { username: "alice" },
              squad: {
                name: "Alice XI",
                players: [
                  {
                    playerId: 101, // Captain (2x)
                    isStarter: true,
                    isCaptain: true,
                    isViceCaptain: false,
                  },
                ],
                gameweekScores: [{ gameweekId: 11, points: 50 }],
              },
            },
            {
              userId: "user-2",
              squadId: "squad-2",
              joinedAt: new Date("2026-08-01T09:00:00Z"), // Earlier join date wins tie
              user: { username: "bob" },
              squad: {
                name: "Bob XI",
                players: [
                  {
                    playerId: 202,
                    isStarter: true,
                    isCaptain: false,
                    isViceCaptain: false,
                  },
                ],
                gameweekScores: [{ gameweekId: 11, points: 50 }],
              },
            },
          ],
        },
      ],
    },
  };

  // Wrap DB in a proxy that throws if ANY read query occurs after hydration
  const guardedDb = new Proxy(baseDb, {
    get(target, prop: string) {
      const model = (target as Record<string, unknown>)[prop];
      if (!model || typeof model !== "object") {
        return model;
      }
      return new Proxy(model as Record<string, unknown>, {
        get(modelTarget, method: string) {
          const fn = modelTarget[method];
          if (typeof fn !== "function") return fn;
          return (...args: unknown[]) => {
            if (dbReadsLocked) {
              throw new Error(
                `Forbidden DB query during live event ingestion: ${String(prop)}.${method}`
              );
            }
            return (fn as (...a: unknown[]) => unknown).apply(modelTarget, args);
          };
        },
      });
    },
  });

  const wsBroadcasts: Array<{ leagueId: string; event: string; payload: unknown }> = [];
  const mockGateway = {
    broadcast: async () => {},
    broadcastToLeague: async (leagueId: string, event: string, payload: unknown) => {
      wsBroadcasts.push({ leagueId, event, payload });
    },
  };

  const service = new LiveProvisionalLeaderboardService({
    db: guardedDb,
    redis,
    gateway: mockGateway,
  });

  const warmedCount = await service.warmFromDatabase(12);
  assert.equal(warmedCount, 2);

  // Lock DB reads to strictly verify zero database read queries during live match updates
  dbReadsLocked = true;

  // Initially both have 50 points and 0 livePoints; Bob joined earlier so Bob is rank 1
  const initialStandings = service.getLeagueLeaderboard("league-alpha");
  assert.equal(initialStandings.length, 2);
  assert.equal(initialStandings[0].squadId, "squad-2");
  assert.equal(initialStandings[0].rank, 1);
  assert.equal(initialStandings[0].competitionRank, 1);
  assert.equal(initialStandings[1].squadId, "squad-1");
  assert.equal(initialStandings[1].rank, 2);
  assert.equal(initialStandings[1].competitionRank, 1);

  const capturedDiffs: LeagueRankDiffPayload[] = [];
  const unsubscribe = service.subscribeLeagueDiffs("league-alpha", (diff) => {
    capturedDiffs.push(diff);
  });

  // Player 101 (Alice's captain, 2x) scores a goal (+4 base * 2 captain = +8 points)
  const metrics = await service.ingestMatchEvent({
    eventId: "evt-goal-101",
    gameweekId: 12,
    fixtureId: 9001,
    playerId: 101,
    type: "GOAL",
    pointsDelta: 4,
  });

  assert.equal(metrics.eventsProcessed, 1);
  assert.equal(metrics.squadsUpdated, 1);
  assert.equal(metrics.leaguesUpdated, 1);
  assert.equal(capturedDiffs.length, 1);
  assert.equal(wsBroadcasts.length, 1);
  assert.equal(wsBroadcasts[0].event, "LEADERBOARD_RANK_DIFF");

  const leagueDiff = capturedDiffs[0];
  assert.equal(leagueDiff.leagueId, "league-alpha");

  const aliceChange = leagueDiff.diffs.find((c) => c.squadId === "squad-1")!;
  const bobChange = leagueDiff.diffs.find((c) => c.squadId === "squad-2")!;

  assert.ok(aliceChange);
  assert.equal(aliceChange.pointsDelta, 8);
  assert.equal(aliceChange.newPoints, 58);
  assert.equal(aliceChange.livePoints, 8);
  assert.equal(aliceChange.oldRank, 2);
  assert.equal(aliceChange.newRank, 1);
  assert.equal(aliceChange.rankDelta, 1);

  assert.ok(bobChange);
  assert.equal(bobChange.oldRank, 1);
  assert.equal(bobChange.newRank, 2);
  assert.equal(bobChange.rankDelta, -1);

  // Verify Redis ZSET was updated via pipeline ZINCRBY
  assert.equal(
    redis.getZSetScore(LiveProvisionalLeaderboardService.leagueZSetKey("league-alpha", 12), "squad-1"),
    58
  );
  assert.equal(
    redis.getZSetScore(LiveProvisionalLeaderboardService.globalZSetKey(12), "squad-1"),
    58
  );

  // Duplicate event ID must be ignored idempotently
  const dupMetrics = await service.ingestMatchEvent({
    eventId: "evt-goal-101",
    gameweekId: 12,
    fixtureId: 9001,
    playerId: 101,
    type: "GOAL",
    pointsDelta: 4,
  });
  assert.equal(dupMetrics.eventsProcessed, 0);
  assert.equal(dupMetrics.squadsUpdated, 0);

  unsubscribe();
});

test("LiveProvisionalLeaderboardService: stress test 1,000+ leagues and 1,000 simulated match events with sub-50ms latency", async () => {
  const redis = new MockRedisZSetClient();
  const service = new LiveProvisionalLeaderboardService({ db: {}, redis, fanout: null });

  // Hydrate 1,050 leagues across 200 squads sharing 30 active players
  const totalLeagues = 1050;
  const totalSquads = 200;
  const squads = Array.from({ length: totalSquads }, (_, idx) => {
    const squadId = `squad-${idx + 1}`;
    const leagueIds: string[] = [];
    // Each squad belongs to 6 leagues so all 1,050 leagues are populated
    for (let l = 0; l < 6; l++) {
      const leagueIndex = ((idx * 6 + l) % totalLeagues) + 1;
      leagueIds.push(`league-${leagueIndex}`);
    }
    const primaryPlayerId = (idx % 30) + 1;
    const secondaryPlayerId = ((idx + 7) % 30) + 1;
    return {
      squadId,
      squadName: `Squad ${idx + 1}`,
      userId: `user-${idx + 1}`,
      username: `manager_${idx + 1}`,
      basePoints: 100 + (idx % 25),
      livePoints: 0,
      joinedAt: 1_700_000_000_000 + idx * 1000,
      leagueIds,
      players: [
        {
          playerId: primaryPlayerId,
          isStarter: true,
          isCaptain: idx % 3 === 0,
          isViceCaptain: false,
        },
        {
          playerId: secondaryPlayerId,
          isStarter: true,
          isCaptain: false,
          isViceCaptain: true,
        },
      ],
    };
  });

  await service.registerSquads(15, squads);

  // Measure single event updating across affected leagues
  const singleMetrics = await service.ingestMatchEvent({
    eventId: "perf-single-goal",
    gameweekId: 15,
    fixtureId: 500,
    playerId: 1,
    type: "GOAL",
    pointsDelta: 5,
  });
  assert.ok(
    singleMetrics.elapsedMs < 50,
    `Expected single event across affected leagues to complete under 50ms, took ${singleMetrics.elapsedMs.toFixed(2)}ms`
  );

  // Stream 1,000 simulated match events and verify sub-50ms batch latency & state accuracy
  const eventTypes: Array<{ type: LiveMatchPointEvent["type"]; delta: number }> = [
    { type: "GOAL", delta: 5 },
    { type: "ASSIST", delta: 3 },
    { type: "YELLOW_CARD", delta: -1 },
    { type: "SAVE", delta: 1 },
    { type: "BONUS", delta: 2 },
  ];
  const events: LiveMatchPointEvent[] = Array.from({ length: 1000 }, (_, i) => {
    const template = eventTypes[i % eventTypes.length];
    return {
      eventId: `sim-evt-${i + 1}`,
      gameweekId: 15,
      fixtureId: 500 + (i % 10),
      playerId: (i % 30) + 1,
      type: template.type,
      pointsDelta: template.delta,
    };
  });

  const batchResult = await service.ingestMatchEventsBatch(events);

  assert.equal(batchResult.eventsProcessed, 1000);
  assert.ok(
    batchResult.elapsedMs < 50,
    `Expected 1,000 simulated match events batch processing latency < 50ms, got ${batchResult.elapsedMs.toFixed(3)}ms`
  );

  // Verify league rankings remain strictly ordered
  const sampleLeagueRankings = service.getLeagueLeaderboard("league-1");
  assert.ok(sampleLeagueRankings.length > 0);
  for (let i = 1; i < sampleLeagueRankings.length; i++) {
    assert.ok(
      sampleLeagueRankings[i - 1].totalPoints >= sampleLeagueRankings[i].totalPoints,
      "Rankings must be ordered by descending totalPoints"
    );
  }
});

test("LiveProvisionalLeaderboardService: seamless reconciliation with final database records at gameweek close", async () => {
  const redis = new MockRedisZSetClient();
  const updatedMembers: Array<{ id: string; totalPoints: number; rank: number }> = [];

  const mockDb = {
    leagueMember: {
      findMany: async () => [
        { id: "lm-a", squadId: "squad-a", totalPoints: 118, rank: 2 },
        { id: "lm-b", squadId: "squad-b", totalPoints: 122, rank: 1 },
      ],
      update: async ({ where, data }: { where: { id: string }; data: { totalPoints: number; rank: number } }) => {
        updatedMembers.push({ id: where.id, ...data });
        return { id: where.id, ...data };
      },
    },
    squadGameweekScore: {
      findMany: async () => [
        { squadId: "squad-a", points: 18 },
        { squadId: "squad-b", points: 22 },
      ],
    },
  };

  const service = new LiveProvisionalLeaderboardService({ db: mockDb, redis, fanout: null });
  await service.registerSquads(20, [
    {
      squadId: "squad-a",
      squadName: "Alpha",
      userId: "u-a",
      username: "alpha",
      basePoints: 100,
      livePoints: 14, // Slightly different before final bonus confirmation
      joinedAt: 1000,
      leagueIds: ["league-reconcile"],
      players: [],
    },
    {
      squadId: "squad-b",
      squadName: "Beta",
      userId: "u-b",
      username: "beta",
      basePoints: 100,
      livePoints: 22,
      joinedAt: 2000,
      leagueIds: ["league-reconcile"],
      players: [],
    },
  ]);

  const report = await service.reconcileWithDatabase(20);
  assert.equal(report.leaguesReconciled, 1);
  assert.equal(report.squadsChecked, 2);
  assert.equal(report.discrepanciesFound, 1);
  assert.equal(report.discrepanciesResolved, 1);

  const standings = service.getLeagueLeaderboard("league-reconcile");
  assert.equal(standings[0].squadId, "squad-b");
  assert.equal(standings[0].totalPoints, 122);
  assert.equal(standings[1].squadId, "squad-a");
  assert.equal(standings[1].totalPoints, 118);
});
