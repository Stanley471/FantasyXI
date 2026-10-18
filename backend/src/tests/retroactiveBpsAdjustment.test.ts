import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RetroactiveBpsAdjustmentService,
  ScoreAdjustmentConflictError,
  ScoreAdjustmentNotFoundError,
  SCORE_ADJUSTED_EVENT,
  StatCorrection,
  PlayerStatSnapshot,
} from "../services/scoring/retroactiveBpsAdjustmentService.js";
import { ScoringService } from "../services/scoring/scoringService.js";
import { UserNotificationHub, UserNotification } from "../services/notifications/userNotificationHub.js";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import {
  ChipType,
  LeagueStatus,
  MembershipStatus,
  Position,
  ScoringType,
  TransactionStatus,
  TransactionType,
} from "../types/index.js";

const GW = 5;
const FIXTURE = 100;
const FIXTURE_FPL = 900;

// Player id -> position (FPL fplId = 1000 + id)
const POSITIONS: Record<number, Position> = {
  1: Position.GKP,
  2: Position.DEF, 3: Position.DEF, 4: Position.DEF, 5: Position.DEF,
  6: Position.MID, 7: Position.MID, 8: Position.MID, 9: Position.MID,
  10: Position.FWD, 11: Position.FWD,
  12: Position.GKP, 13: Position.DEF, 14: Position.MID, 15: Position.FWD,
  16: Position.FWD, 17: Position.FWD, 18: Position.FWD,
};
const BENCH = [12, 13, 14, 15];

function line(minutes: number, totalPoints: number, extra: Partial<PlayerStatSnapshot> = {}): PlayerStatSnapshot {
  return {
    minutes,
    goals: 0,
    assists: 0,
    cleanSheet: false,
    yellowCards: 0,
    redCards: 0,
    saves: 0,
    bonus: 0,
    totalPoints,
    ...extra,
  };
}

interface SquadSpec {
  id: string;
  userId: string;
  starters: number[]; // 11 ids in pitch order (GKP, DEF x4, MID x4, FWD x2)
  captain: number;
  vice: number;
  chip?: ChipType;
}

const SQUADS: SquadSpec[] = [
  { id: "S1", userId: "u1", starters: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], captain: 10, vice: 6 },
  { id: "S2", userId: "u2", starters: [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17], captain: 16, vice: 6 },
  { id: "S3", userId: "u3", starters: [1, 2, 3, 4, 5, 6, 7, 8, 9, 17, 18], captain: 17, vice: 6 },
];

function createDb(options: { chips?: Record<string, ChipType>; stats?: Record<number, PlayerStatSnapshot> } = {}) {
  const stats = new Map<number, PlayerStatSnapshot>();
  for (const id of Object.keys(POSITIONS).map(Number)) {
    stats.set(id, options.stats?.[id] ?? (BENCH.includes(id) ? line(0, 0) : line(90, 2)));
  }

  const state: any = {
    stats: [...stats.entries()].map(([playerId, s]) => ({ playerId, gameweekId: GW, fixtureId: FIXTURE, ...s })),
    squads: SQUADS.map((s) => ({ id: s.id, userId: s.userId, totalPoints: 0 })),
    squadPlayers: SQUADS.flatMap((s) =>
      [...s.starters, ...BENCH].map((playerId, i) => ({
        squadId: s.id,
        playerId,
        isStarter: i < 11,
        isCaptain: playerId === s.captain,
        isViceCaptain: playerId === s.vice,
        positionOrder: i + 1,
      }))
    ),
    chips: Object.entries(options.chips ?? {}).map(([squadId, chipType]) => ({ squadId, gameweekId: GW, chipType })),
    scores: [] as any[],
    leagues: [
      { id: "L-active", status: LeagueStatus.ACTIVE, scoringType: ScoringType.CLASSIC, startGameweekId: 1, endGameweekId: 10 },
      { id: "L-completed", status: LeagueStatus.COMPLETED, scoringType: ScoringType.CLASSIC, startGameweekId: 1, endGameweekId: 5 },
      { id: "L-paid", status: LeagueStatus.ACTIVE, scoringType: ScoringType.CLASSIC, startGameweekId: 1, endGameweekId: 10 },
      { id: "L-h2h", status: LeagueStatus.ACTIVE, scoringType: ScoringType.HEAD_TO_HEAD, startGameweekId: 1, endGameweekId: 10 },
    ],
    members: [
      { id: "m1", leagueId: "L-active", userId: "u1", squadId: "S1", totalPoints: 100, rank: 2, joinedAt: new Date(1), status: MembershipStatus.ACTIVE },
      { id: "m2", leagueId: "L-active", userId: "u2", squadId: "S2", totalPoints: 101, rank: 1, joinedAt: new Date(2), status: MembershipStatus.ACTIVE },
      { id: "m3", leagueId: "L-active", userId: "u3", squadId: "S3", totalPoints: 50, rank: 3, joinedAt: new Date(3), status: MembershipStatus.ACTIVE },
      { id: "m4", leagueId: "L-completed", userId: "u1", squadId: "S1", totalPoints: 80, rank: 1, joinedAt: new Date(1), status: MembershipStatus.ACTIVE },
      { id: "m5", leagueId: "L-completed", userId: "u2", squadId: "S2", totalPoints: 79, rank: 2, joinedAt: new Date(2), status: MembershipStatus.ACTIVE },
      { id: "m6", leagueId: "L-paid", userId: "u1", squadId: "S1", totalPoints: 70, rank: 1, joinedAt: new Date(1), status: MembershipStatus.ACTIVE },
      { id: "m7", leagueId: "L-h2h", userId: "u1", squadId: "S1", totalPoints: 60, rank: 1, joinedAt: new Date(1), status: MembershipStatus.ACTIVE },
    ],
    transactions: [
      { leagueId: "L-paid", type: TransactionType.PRIZE_PAYOUT, status: TransactionStatus.CONFIRMED },
      { leagueId: "L-active", type: TransactionType.ENTRY_FEE, status: TransactionStatus.CONFIRMED },
    ],
    logs: [] as any[],
  };

  // Provisional tally, exactly as ScoringService would have persisted it
  const lineup = (squadId: string) =>
    state.squadPlayers
      .filter((sp: any) => sp.squadId === squadId)
      .map((sp: any) => ({ ...sp, position: POSITIONS[sp.playerId] }));
  for (const squad of state.squads) {
    const statsMap = new Map(state.stats.map((s: any) => [s.playerId, { minutes: s.minutes, totalPoints: s.totalPoints }]));
    const chip = state.chips.find((c: any) => c.squadId === squad.id)?.chipType ?? null;
    const result = ScoringService.calculateLineupScore(lineup(squad.id), statsMap as any, { chip });
    state.scores.push({ squadId: squad.id, gameweekId: GW, points: result.totalPoints, transferCost: 0, captainPoints: result.captainPoints, benchPoints: result.benchPoints });
    squad.totalPoints = 500 + result.totalPoints;
  }

  const inList = (value: unknown, filter: any) => (filter?.in ? filter.in.includes(value) : filter === undefined || filter === value);
  const reads: string[] = [];

  const db: any = {
    state,
    reads,
    gameweek: {
      findUnique: async ({ where }: any) => (where.id === GW ? { id: GW, fplId: 25, isFinished: true } : null),
    },
    player: {
      findMany: async () => Object.keys(POSITIONS).map((id) => ({ id: Number(id), fplId: 1000 + Number(id) })),
    },
    fixture: {
      findMany: async ({ where }: any) => (where.gameweekId === GW ? [{ id: FIXTURE, fplId: FIXTURE_FPL }] : []),
    },
    playerGameweekStats: {
      findMany: async ({ where }: any) =>
        state.stats.filter((s: any) => s.gameweekId === where.gameweekId && inList(s.playerId, where.playerId)).map((s: any) => ({ ...s })),
      upsert: async ({ where, update, create }: any) => {
        const key = where.playerId_gameweekId_fixtureId;
        const existing = state.stats.find(
          (s: any) => s.playerId === key.playerId && s.gameweekId === key.gameweekId && s.fixtureId === key.fixtureId
        );
        if (existing) Object.assign(existing, update);
        else state.stats.push({ ...create });
      },
    },
    squadPlayer: {
      findMany: async ({ where }: any) => state.squadPlayers.filter((sp: any) => inList(sp.playerId, where.playerId)),
    },
    squadGameweekScore: {
      findMany: async ({ where }: any) => {
        reads.push(...state.scores.filter((s: any) => inList(s.squadId, where.squadId)).map((s: any) => s.squadId));
        return state.scores.filter((s: any) => s.gameweekId === where.gameweekId && inList(s.squadId, where.squadId)).map((s: any) => ({ ...s }));
      },
      updateMany: async ({ where, data }: any) => {
        const score = state.scores.find(
          (s: any) => s.squadId === where.squadId && s.gameweekId === where.gameweekId && s.points === where.points
        );
        if (!score) return { count: 0 };
        Object.assign(score, data);
        return { count: 1 };
      },
    },
    squad: {
      findMany: async ({ where }: any) =>
        state.squads
          .filter((s: any) => inList(s.id, where.id))
          .map((s: any) => ({ ...s, players: lineup(s.id).map((sp: any) => ({ ...sp, player: { position: sp.position } })) })),
      update: async ({ where, data }: any) => {
        const squad = state.squads.find((s: any) => s.id === where.id);
        squad.totalPoints += data.totalPoints.increment;
      },
    },
    squadChipUsage: {
      findMany: async ({ where }: any) => state.chips.filter((c: any) => c.gameweekId === where.gameweekId && inList(c.squadId, where.squadId)),
    },
    leagueMember: {
      findMany: async ({ where, include }: any) =>
        state.members
          .filter((m: any) => inList(m.squadId, where.squadId) && inList(m.leagueId, where.leagueId) && m.status === where.status)
          .map((m: any) => ({ ...m, ...(include ? { league: state.leagues.find((l: any) => l.id === m.leagueId) } : {}) })),
      update: async ({ where, data }: any) => {
        const member = state.members.find((m: any) => m.id === where.id);
        if (data.totalPoints?.increment !== undefined) member.totalPoints += data.totalPoints.increment;
        if (data.rank !== undefined) member.rank = data.rank;
      },
    },
    transaction: {
      findMany: async ({ where }: any) =>
        state.transactions.filter((t: any) => inList(t.leagueId, where.leagueId) && t.type === where.type && t.status === where.status),
    },
    scoreAdjustmentLog: {
      createMany: async ({ data }: any) => {
        state.logs.push(...data);
      },
    },
    // Interactive transaction with real rollback semantics
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await fn(db);
      } catch (error) {
        for (const key of Object.keys(state)) state[key] = snapshot[key];
        throw error;
      }
    },
  };
  return db;
}

function createService(db: any, liveElements?: any[]) {
  const hub = new UserNotificationHub();
  const notifications: Array<{ userId: string; n: UserNotification }> = [];
  for (const userId of ["u1", "u2", "u3"]) hub.subscribe(userId, (n) => notifications.push({ userId, n }));
  const bus = new InMemoryEventBus();
  const busEvents: any[] = [];
  bus.subscribe(SCORE_ADJUSTED_EVENT, (p) => {
    busEvents.push(p);
  });
  const locks: string[] = [];
  const service = new RetroactiveBpsAdjustmentService({
    db,
    hub,
    eventBus: bus,
    fpl: { getGameweekLive: async () => ({ elements: liveElements ?? [] }) },
    lock: async (resource) => {
      locks.push(`acquire:${resource}`);
      return async () => {
        locks.push(`release:${resource}`);
      };
    },
    now: () => new Date("2026-10-17T09:00:00Z"),
  });
  return { service, notifications, busEvents, locks };
}

const correction = (db: any, playerId: number, next: PlayerStatSnapshot): StatCorrection => {
  const stored = db.state.stats.find((s: any) => s.playerId === playerId);
  const previous = stored ? line(stored.minutes, stored.totalPoints, stored) : null;
  return { playerId, fixtureId: FIXTURE, previous, next, changedFields: ["bonus", "totalPoints"] };
};
const score = (db: any, squadId: string) => db.state.scores.find((s: any) => s.squadId === squadId).points;
const member = (db: any, id: string) => db.state.members.find((m: any) => m.id === id);

/** FPL /event/{id}/live/ payload mirroring the stored stats, with overrides. */
function liveFrom(db: any, overrides: Record<number, Array<{ identifier: string; points: number; value: number }>>) {
  return db.state.stats.map((s: any) => ({
    id: 1000 + s.playerId,
    stats: {},
    explain: [
      {
        fixture: FIXTURE_FPL,
        stats: overrides[s.playerId] ?? [{ identifier: "minutes", points: s.totalPoints, value: s.minutes }],
      },
    ],
  }));
}

describe("RetroactiveBpsAdjustmentService", () => {
  it("applies a single-player bonus change differentially and re-ranks the league", async () => {
    const db = createDb();
    const { service, notifications, busEvents } = createService(db);
    const before = { s1: score(db, "S1"), s2: score(db, "S2"), s3: score(db, "S3"), squadTotal: db.state.squads[0].totalPoints };

    const report = await service.applyCorrections(GW, [correction(db, 11, line(90, 5, { bonus: 3 }))], {
      reason: "BPS finalised",
    });

    assert.equal(report.applied, true);
    assert.deepEqual(report.squadAdjustments.map((a) => [a.squadId, a.delta]), [["S1", 3]]);
    assert.equal(score(db, "S1"), before.s1 + 3);
    assert.equal(score(db, "S2"), before.s2, "squads without the player are untouched");
    assert.equal(score(db, "S3"), before.s3);
    assert.equal(db.state.squads[0].totalPoints, before.squadTotal + 3);
    assert.equal(db.state.stats.find((s: any) => s.playerId === 11).bonus, 3);

    // Classic league totals and ranks updated together
    assert.equal(member(db, "m1").totalPoints, 103);
    assert.equal(member(db, "m1").rank, 1);
    assert.equal(member(db, "m2").rank, 2);
    assert.equal(member(db, "m3").rank, 3);
    assert.equal(member(db, "m7").totalPoints, 60, "head-to-head totals are not touched");

    // Audit: player stat, squad score, league members, protected leagues
    const squadLog = db.state.logs.find((l: any) => l.entityType === "SQUAD_SCORE");
    assert.deepEqual(
      { prev: squadLog.previousPoints, delta: squadLog.delta, next: squadLog.newPoints, reason: squadLog.reason },
      { prev: before.s1, delta: 3, next: before.s1 + 3, reason: "BPS finalised" }
    );
    const statLog = db.state.logs.find((l: any) => l.entityType === "PLAYER_STAT");
    assert.deepEqual([statLog.previousPoints, statLog.delta, statLog.newPoints], [2, 3, 5]);
    const memberLog = db.state.logs.find((l: any) => l.entityType === "LEAGUE_MEMBER" && l.entityId === "m1");
    assert.deepEqual([memberLog.previousPoints, memberLog.delta, memberLog.newPoints], [100, 3, 103]);
    assert.deepEqual([memberLog.details.previousRank, memberLog.details.newRank], [2, 1]);
    assert.ok(new Set(db.state.logs.map((l: any) => l.runId)).size === 1);

    // Real-time notification to the affected user only
    assert.deepEqual(notifications.map((n) => n.userId), ["u1"]);
    const data = notifications[0].n.data as any;
    assert.equal(notifications[0].n.type, SCORE_ADJUSTED_EVENT);
    assert.equal(data.delta, 3);
    assert.equal(data.newPoints, before.s1 + 3);
    assert.equal(data.reason, "BPS finalised");
    assert.deepEqual(data.players, [{ playerId: 11, previousPoints: 2, newPoints: 5, multiplier: 1 }]);
    assert.deepEqual(data.leagues, [{ leagueId: "L-active", previousTotal: 100, newTotal: 103, previousRank: 2, newRank: 1 }]);
    assert.equal(busEvents.length, 1);
  });

  it("applies the captain multiplier to a corrected captain", async () => {
    const db = createDb();
    const { service } = createService(db);
    const before = score(db, "S1");
    const report = await service.applyCorrections(GW, [correction(db, 10, line(90, 5, { bonus: 3 }))]);
    assert.equal(report.squadAdjustments[0].delta, 6);
    assert.equal(score(db, "S1"), before + 6);
    assert.deepEqual(report.squadAdjustments[0].players, [{ playerId: 10, previousPoints: 4, newPoints: 10, multiplier: 2 }]);
  });

  it("applies the Triple Captain multiplier", async () => {
    const db = createDb({ chips: { S1: ChipType.TRIPLE_CAPTAIN } });
    const { service } = createService(db);
    const report = await service.applyCorrections(GW, [correction(db, 10, line(90, 5, { bonus: 3 }))]);
    assert.equal(report.squadAdjustments[0].delta, 9);
  });

  it("hands the armband to the vice-captain when a correction zeroes the captain's minutes", async () => {
    const db = createDb();
    const { service } = createService(db);
    // Captain (10) credited with 0 minutes; vice (6) has 2 pts and becomes captain; bench FWD 15 has 0 mins
    const report = await service.applyCorrections(GW, [correction(db, 10, line(0, 0))]);
    // Before: 10 played (2*2=4). After: 10 scores 0, vice 6 doubles (+2): delta = -4 + 2
    assert.equal(report.squadAdjustments[0].delta, -2);
  });

  it("adjusts several squads for multi-player corrections and leaves unaffected squads alone", async () => {
    const db = createDb();
    const { service, notifications } = createService(db);
    const before = { s1: score(db, "S1"), s2: score(db, "S2"), s3: score(db, "S3") };
    const report = await service.applyCorrections(GW, [
      correction(db, 11, line(90, 5, { bonus: 3 })), // S1 only
      correction(db, 16, line(90, 1, { yellowCards: 1 })), // S2 captain only: -1 x2
    ]);
    assert.deepEqual(
      report.squadAdjustments.map((a) => [a.squadId, a.delta]).sort(),
      [["S1", 3], ["S2", -2]]
    );
    assert.equal(score(db, "S1"), before.s1 + 3);
    assert.equal(score(db, "S2"), before.s2 - 2);
    assert.equal(score(db, "S3"), before.s3);
    assert.equal(member(db, "m2").totalPoints, 99);
    assert.equal(member(db, "m3").totalPoints, 50);
    assert.deepEqual(notifications.map((n) => n.userId).sort(), ["u1", "u2"]);
  });

  it("detects a retroactive goal re-attribution from the FPL API and applies it end to end", async () => {
    // Provisional tally credited the goal to player 11 (S1)
    const db = createDb({ stats: { 11: line(90, 6, { goals: 1 }) } });
    const before = { s1: score(db, "S1"), s2: score(db, "S2"), s3: score(db, "S3") };
    // Official correction: the goal belongs to player 17 (S2 starter, S3 captain)
    const live = liveFrom(db, {
      11: [{ identifier: "minutes", points: 2, value: 90 }],
      17: [
        { identifier: "minutes", points: 2, value: 90 },
        { identifier: "goals_scored", points: 4, value: 1 },
      ],
    });
    const { service, locks } = createService(db, live);

    const corrections = await service.detectStatCorrections(GW);
    assert.deepEqual(corrections.map((c) => [c.playerId, c.changedFields]).sort(), [
      [11, ["goals", "totalPoints"]],
      [17, ["goals", "totalPoints"]],
    ]);

    const report = await service.detectAndApply(GW);
    assert.deepEqual(locks, [`acquire:bps-adjustment:${GW}`, `release:bps-adjustment:${GW}`]);
    assert.equal(report.corrections.length, 2);
    assert.equal(score(db, "S1"), before.s1 - 4);
    assert.equal(score(db, "S2"), before.s2 + 4);
    assert.equal(score(db, "S3"), before.s3 + 8, "S3 captained the new scorer");
    assert.equal(db.state.stats.find((s: any) => s.playerId === 17).goals, 1);
    assert.equal(db.state.stats.find((s: any) => s.playerId === 11).goals, 0);

    // Standings: m2 105 > m1 96 > m3 58
    assert.deepEqual(
      ["m1", "m2", "m3"].map((id) => [member(db, id).totalPoints, member(db, id).rank]),
      [[96, 2], [105, 1], [58, 3]]
    );

    // Running the job again finds nothing new
    const rerun = await service.detectAndApply(GW);
    assert.equal(rerun.applied, false);
    assert.equal(rerun.corrections.length, 0);
    assert.equal(score(db, "S1"), before.s1 - 4);
  });

  it("never changes standings of settled leagues", async () => {
    const db = createDb();
    const { service } = createService(db);
    const report = await service.applyCorrections(GW, [correction(db, 11, line(90, 5, { bonus: 3 }))]);

    assert.deepEqual(
      report.protectedLeagues.sort((a, b) => a.leagueId.localeCompare(b.leagueId)),
      [
        { leagueId: "L-completed", reason: "LEAGUE_COMPLETED" },
        { leagueId: "L-paid", reason: "PRIZES_PAID_ON_CHAIN" },
      ]
    );
    assert.deepEqual([member(db, "m4").totalPoints, member(db, "m4").rank], [80, 1]);
    assert.deepEqual([member(db, "m6").totalPoints, member(db, "m6").rank], [70, 1]);
    assert.ok(report.leagueAdjustments.every((a) => a.leagueId === "L-active"));
    const skipped = db.state.logs.filter((l: any) => l.details?.skipped);
    assert.deepEqual(skipped.map((l: any) => l.leagueId).sort(), ["L-completed", "L-paid"]);
  });

  it("ignores bench corrections unless Bench Boost was played", async () => {
    const db = createDb();
    const { service, notifications } = createService(db);
    const report = await service.applyCorrections(GW, [correction(db, 13, line(0, 3, { bonus: 3 }))]);
    assert.equal(report.applied, true);
    assert.equal(report.squadAdjustments.length, 0);
    assert.equal(db.state.stats.find((s: any) => s.playerId === 13).totalPoints, 3, "the stat itself is still corrected");
    assert.deepEqual(db.state.logs.map((l: any) => l.entityType), ["PLAYER_STAT"]);
    assert.equal(notifications.length, 0);

    const boosted = createDb({ chips: { S1: ChipType.BENCH_BOOST } });
    const bb = await createService(boosted).service.applyCorrections(GW, [correction(boosted, 13, line(0, 3))]);
    assert.deepEqual(bb.squadAdjustments.map((a) => [a.squadId, a.delta]), [["S1", 3]]);
  });

  it("rolls back every change atomically on a concurrent score update", async () => {
    const db = createDb();
    const { service, notifications } = createService(db);
    const s1 = score(db, "S1");
    const realUpdate = db.squadGameweekScore.updateMany;
    // Another process recalculated S2 between detection and commit
    db.squadGameweekScore.updateMany = async (args: any) => {
      if (args.where.squadId === "S2") db.state.scores.find((s: any) => s.squadId === "S2").points += 1;
      return realUpdate(args);
    };

    await assert.rejects(
      service.applyCorrections(GW, [correction(db, 2, line(90, 5, { bonus: 3 }))]),
      ScoreAdjustmentConflictError
    );
    assert.equal(score(db, "S1"), s1, "S1 was updated inside the transaction and rolled back");
    assert.equal(db.state.stats.find((s: any) => s.playerId === 2).bonus, 0);
    assert.equal(member(db, "m1").totalPoints, 100);
    assert.equal(db.state.logs.length, 0);
    assert.equal(notifications.length, 0);
  });

  it("is a no-op without corrections", async () => {
    const db = createDb();
    const { service, notifications } = createService(db, liveFrom(db, {}));
    const report = await service.detectAndApply(GW);
    assert.equal(report.applied, false);
    assert.equal(report.appliedAt, null);
    assert.equal(db.state.logs.length, 0);
    assert.equal(notifications.length, 0);
  });

  it("records stats FPL reports for fixtures the platform never stored", async () => {
    const db = createDb();
    db.state.stats = db.state.stats.filter((s: any) => s.playerId !== 18);
    const live = liveFrom(db, {});
    live.push({ id: 1018, stats: {}, explain: [{ fixture: FIXTURE_FPL, stats: [{ identifier: "minutes", points: 1, value: 20 }] }] });
    const { service } = createService(db, live);
    const [found] = await service.detectStatCorrections(GW);
    assert.equal(found.playerId, 18);
    assert.equal(found.previous, null);
    assert.equal(found.next.minutes, 20);
  });

  it("rejects unknown gameweeks", async () => {
    const { service } = createService(createDb());
    await assert.rejects(service.detectStatCorrections(999), ScoreAdjustmentNotFoundError);
  });
});
