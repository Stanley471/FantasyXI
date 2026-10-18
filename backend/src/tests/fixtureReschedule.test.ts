import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Position } from "../types/index.js";
import { ScoringService } from "../services/scoring/scoringService.js";
import {
  AbandonedMatchPolicy,
  FixtureRescheduleService,
  type FixtureChange,
  type FixtureSnapshot,
} from "../services/fpl/fixtureRescheduleService.js";

/**
 * Fixture reschedule & anomaly handling (issue #269): detection, stat
 * re-homing, abandoned-match policy and rescoring through the real scoring
 * engine for blank and double gameweeks.
 */

const NOW = new Date("2026-04-20T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function stored(overrides: Partial<FixtureSnapshot> & { fplId: number }): FixtureSnapshot {
  return {
    id: overrides.fplId + 1000,
    gameweekId: 33,
    homeTeamId: 1,
    awayTeamId: 2,
    kickoffTime: new Date("2026-04-18T14:00:00Z"),
    started: false,
    finished: false,
    ...overrides,
  };
}

interface StatRow {
  playerId: number;
  gameweekId: number;
  fixtureId: number;
  minutes: number;
  totalPoints: number;
}

/**
 * In-memory Prisma stand-in with one squad (15 players). Players 1-11 start;
 * player 9 (team 1) is captain, player 10 (team 3) vice-captain.
 * Teams: 1 and 2 meet in fixture 1001, team 1 also plays fixture 1002.
 */
function createWorld(options: { settled?: number[] } = {}) {
  const lineup = [
    { playerId: 1, position: Position.GKP, teamId: 3 },
    { playerId: 2, position: Position.DEF, teamId: 3 },
    { playerId: 3, position: Position.DEF, teamId: 4 },
    { playerId: 4, position: Position.DEF, teamId: 4 },
    { playerId: 5, position: Position.DEF, teamId: 5 },
    { playerId: 6, position: Position.MID, teamId: 2 }, // blanks with fixture 1001
    { playerId: 7, position: Position.MID, teamId: 5 },
    { playerId: 8, position: Position.MID, teamId: 6 },
    { playerId: 9, position: Position.MID, teamId: 1 }, // captain, blanks with fixture 1001
    { playerId: 10, position: Position.FWD, teamId: 3 }, // vice-captain
    { playerId: 11, position: Position.FWD, teamId: 6 },
    { playerId: 12, position: Position.GKP, teamId: 7 },
    { playerId: 13, position: Position.MID, teamId: 7 }, // first bench outfield
    { playerId: 14, position: Position.DEF, teamId: 8 },
    { playerId: 15, position: Position.FWD, teamId: 8 },
  ].map((p, i) => ({
    ...p,
    isStarter: i < 11,
    isCaptain: p.playerId === 9,
    isViceCaptain: p.playerId === 10,
    positionOrder: i + 1,
  }));

  const state = {
    stats: [] as StatRow[],
    scores: [] as Array<{ squadId: string; gameweekId: number; points: number; transferCost: number; [k: string]: any }>,
    rescoreCalls: [] as Array<[string, number]>,
  };
  const teamOf = new Map(lineup.map((p) => [p.playerId, p.teamId]));
  const settled = new Set(options.settled ?? []);

  const db: any = {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    playerGameweekStats: {
      deleteMany: async ({ where }: any) => {
        const before = state.stats.length;
        state.stats = state.stats.filter((s) => s.fixtureId !== where.fixtureId);
        return { count: before - state.stats.length };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = state.stats.filter((s) => s.fixtureId === where.fixtureId);
        rows.forEach((r) => (r.gameweekId = data.gameweekId));
        return { count: rows.length };
      },
      findMany: async ({ where }: any) =>
        state.stats.filter((s) => s.gameweekId === where.gameweekId && where.playerId.in.includes(s.playerId)),
    },
    gameweek: {
      findMany: async ({ where }: any) =>
        where.id.in.map((id: number) => ({ id, settledAt: settled.has(id) ? new Date("2026-04-01") : null })),
    },
    squad: {
      findUnique: async () => ({
        id: "sq1",
        players: lineup.map((p) => ({ ...p, player: { position: p.position, teamId: p.teamId } })),
      }),
      update: async () => undefined,
    },
    squadChipUsage: { findUnique: async () => null },
    squadGameweekScore: {
      findUnique: async ({ where }: any) =>
        state.scores.find(
          (s) => s.squadId === where.squadId_gameweekId.squadId && s.gameweekId === where.squadId_gameweekId.gameweekId
        ) ?? null,
      upsert: async ({ where, update, create }: any) => {
        const existing = state.scores.find(
          (s) => s.squadId === where.squadId_gameweekId.squadId && s.gameweekId === where.squadId_gameweekId.gameweekId
        );
        if (existing) return Object.assign(existing, update);
        state.scores.push({ ...create });
        return create;
      },
      findMany: async ({ where }: any) => {
        if (where.squad) {
          const teams: number[] = where.squad.players.some.player.teamId.in;
          const ownsTeam = lineup.some((p) => teams.includes(p.teamId));
          return state.scores.filter((s) => s.gameweekId === where.gameweekId && ownsTeam);
        }
        return state.scores.filter((s) => s.squadId === where.squadId);
      },
    },
  };

  const scoring = new ScoringService(db);
  const trackedScoring = {
    calculateAndPersistSquadScore: async (squadId: string, gameweekId: number) => {
      state.rescoreCalls.push([squadId, gameweekId]);
      return scoring.calculateAndPersistSquadScore(squadId, gameweekId);
    },
  };

  /** Every player plays 90 minutes and scores 2 in the given fixture (captain scores `captainPoints`). */
  const playFixture = (gameweekId: number, fixtureId: number, teams: number[], captainPoints = 2) => {
    for (const p of lineup) {
      if (teams.includes(p.teamId)) {
        state.stats.push({
          playerId: p.playerId,
          gameweekId,
          fixtureId,
          minutes: 90,
          totalPoints: p.playerId === 9 ? captainPoints : 2,
        });
      }
    }
  };

  const service = (policy?: AbandonedMatchPolicy) =>
    new FixtureRescheduleService(db, trackedScoring, { abandonedPolicy: policy, now: () => NOW });

  return { db, state, lineup, teamOf, scoring, playFixture, service };
}

/** Everyone except teams 1 and 2 plays a regular fixture (2000) in the gameweek. */
function playRestOfGameweek(world: ReturnType<typeof createWorld>, gameweekId: number) {
  world.playFixture(gameweekId, 2000 + gameweekId, [3, 4, 5, 6, 7, 8]);
}

describe("FixtureRescheduleService (issue #269)", () => {
  describe("change detection", () => {
    const service = new FixtureRescheduleService({}, { calculateAndPersistSquadScore: async () => ({}) as any }, {
      now: () => NOW,
    });
    const detect = (prev: FixtureSnapshot, next: Partial<FixtureSnapshot>) =>
      service.detectChanges([prev], [{ ...prev, id: undefined, ...next }]);

    it("flags a fixture unscheduled before kickoff as POSTPONED", () => {
      const [change] = detect(stored({ fplId: 1 }), { gameweekId: null, kickoffTime: null });
      assert.equal(change.type, "POSTPONED");
      assert.equal(change.fromGameweekId, 33);
      assert.equal(change.toGameweekId, null);
      assert.equal(change.fixtureId, 1001);
    });

    it("flags a move between gameweeks before kickoff as RESCHEDULED", () => {
      const [change] = detect(stored({ fplId: 1 }), { gameweekId: 36 });
      assert.equal(change.type, "RESCHEDULED");
      assert.equal(change.toGameweekId, 36);
    });

    it("flags an unscheduled fixture given a gameweek as REINSTATED", () => {
      const [change] = detect(stored({ fplId: 1, gameweekId: null }), { gameweekId: 34 });
      assert.equal(change.type, "REINSTATED");
    });

    it("flags a started, unfinished fixture that moves or is unscheduled as ABANDONED", () => {
      const prev = stored({ fplId: 1, started: true, minutes: 55 });
      assert.equal(detect(prev, { gameweekId: null, started: false })[0].type, "ABANDONED");
      assert.equal(detect(prev, { gameweekId: 37, started: false })[0].type, "ABANDONED");
    });

    it("reports a long-stalled live fixture as SUSPECTED_ABANDONMENT without moving it", () => {
      const prev = stored({ fplId: 1, started: true, kickoffTime: hoursAgo(7) });
      assert.equal(detect(prev, {})[0].type, "SUSPECTED_ABANDONMENT");
      assert.deepEqual(detect({ ...prev, kickoffTime: hoursAgo(2) }, { kickoffTime: hoursAgo(2) }), []);
    });

    it("reports kick-off changes within the same gameweek", () => {
      const [change] = detect(stored({ fplId: 1 }), { kickoffTime: new Date("2026-04-19T16:30:00Z") });
      assert.equal(change.type, "KICKOFF_CHANGED");
    });

    it("ignores unchanged and brand-new fixtures", () => {
      const prev = stored({ fplId: 1 });
      assert.deepEqual(service.detectChanges([prev], [{ ...prev }]), []);
      assert.deepEqual(service.detectChanges([], [stored({ fplId: 2 })]), []);
    });
  });

  describe("stat migration", () => {
    const change = (type: FixtureChange["type"], to: number | null = null): FixtureChange => ({
      type,
      fplId: 1,
      fixtureId: 1001,
      homeTeamId: 1,
      awayTeamId: 2,
      fromGameweekId: 33,
      toGameweekId: to,
      previousKickoff: null,
      kickoffTime: null,
    });

    it("deletes ghost stats of a postponed fixture", async () => {
      const world = createWorld();
      world.playFixture(33, 1001, [1, 2]);
      playRestOfGameweek(world, 33);
      const result = await world.service().migrateStats([change("POSTPONED")]);
      assert.equal(result.statsDeleted, 2);
      assert.ok(world.state.stats.every((s) => s.fixtureId !== 1001));
      assert.deepEqual(result.affectedGameweekIds, [33]);
    });

    it("moves stats of a rescheduled fixture into the new gameweek bucket", async () => {
      const world = createWorld();
      world.playFixture(33, 1001, [1, 2]);
      const result = await world.service().migrateStats([change("RESCHEDULED", 36)]);
      assert.equal(result.statsMoved, 2);
      assert.ok(world.state.stats.filter((s) => s.fixtureId === 1001).every((s) => s.gameweekId === 36));
      assert.deepEqual(result.affectedGameweekIds, [33, 36]);
    });

    it("voids partial points of an abandoned match by default", async () => {
      const world = createWorld();
      world.playFixture(33, 1001, [1, 2]);
      const service = world.service();
      assert.equal(service.getAbandonedPolicy(), AbandonedMatchPolicy.VOID_AND_REPLAY);
      const result = await service.migrateStats([change("ABANDONED", 37)]);
      assert.equal(result.statsDeleted, 2);
      assert.deepEqual(result.affectedGameweekIds, [33, 37]);
    });

    it("keeps partial points where the result stands", async () => {
      const world = createWorld();
      world.playFixture(33, 1001, [1, 2]);
      const result = await world.service(AbandonedMatchPolicy.RESULT_STANDS).migrateStats([change("ABANDONED")]);
      assert.equal(result.statsDeleted, 0);
      assert.equal(world.state.stats.length, 2);
      assert.deepEqual(result.affectedGameweekIds, []);
    });

    it("reads the abandoned-match policy from the environment", () => {
      const previous = process.env.FPL_ABANDONED_MATCH_POLICY;
      process.env.FPL_ABANDONED_MATCH_POLICY = "RESULT_STANDS";
      try {
        const service = new FixtureRescheduleService({}, { calculateAndPersistSquadScore: async () => ({}) as any });
        assert.equal(service.getAbandonedPolicy(), AbandonedMatchPolicy.RESULT_STANDS);
      } finally {
        if (previous === undefined) delete process.env.FPL_ABANDONED_MATCH_POLICY;
        else process.env.FPL_ABANDONED_MATCH_POLICY = previous;
      }
    });

    it("leaves informational changes alone", async () => {
      const world = createWorld();
      world.playFixture(33, 1001, [1, 2]);
      const result = await world.service().migrateStats([change("KICKOFF_CHANGED", 33), change("SUSPECTED_ABANDONMENT", 33)]);
      assert.deepEqual(result, { statsMoved: 0, statsDeleted: 0, affectedGameweekIds: [], requiresManualReview: [] });
    });

    it("never moves or deletes stats in a settled gameweek", async () => {
      const world = createWorld({ settled: [33] });
      world.playFixture(33, 1001, [1, 2]);
      const result = await world.service().migrateStats([change("POSTPONED"), change("RESCHEDULED", 36)]);
      assert.deepEqual(result, { statsMoved: 0, statsDeleted: 0, affectedGameweekIds: [], requiresManualReview: [33] });
      assert.equal(world.state.stats.length, 2);
    });
  });

  describe("rescoring", () => {
    it("never rewrites settled gameweeks and flags them for review", async () => {
      const world = createWorld({ settled: [33] });
      world.state.scores.push({ squadId: "sq1", gameweekId: 33, points: 50, transferCost: 0 });
      const changes = world.service().detectChanges(
        [stored({ fplId: 1 })],
        [{ ...stored({ fplId: 1 }), id: undefined, gameweekId: null }]
      );
      const migration = await world.service().migrateStats(changes);
      assert.deepEqual(migration.requiresManualReview, [33]);
      assert.deepEqual(migration.affectedGameweekIds, []);

      // Even when asked directly, rescoring leaves a settled gameweek alone
      const result = await world.service().rescoreAffected(changes, [33]);
      assert.deepEqual(result.requiresManualReview, [33]);
      assert.deepEqual(world.state.rescoreCalls, []);
    });

    it("only rescores squads that already have a score in the gameweek", async () => {
      const world = createWorld();
      const changes = world.service().detectChanges([stored({ fplId: 1 })], [{ ...stored({ fplId: 1 }), id: undefined, gameweekId: 36 }]);
      const result = await world.service().rescoreAffected(changes, [33, 36]);
      assert.deepEqual(result.rescored, []);
      assert.deepEqual(world.state.rescoreCalls, []);
    });
  });

  describe("mid-week postponement followed by a double gameweek (integration)", () => {
    it("removes ghost points, auto-subs the blank, then scores both DGW fixtures with captaincy", async () => {
      const world = createWorld();
      const service = world.service();

      // --- GW33 is played and scored with fixture 1001 still attached (captain 9 scores 10)
      world.playFixture(33, 1001, [1, 2], 10);
      playRestOfGameweek(world, 33);
      const before = await world.scoring.calculateAndPersistSquadScore("sq1", 33);
      // 11 starters x 2 + captain extra (10 raw -> 20): 10 starters*2 + 20 = 40
      assert.equal(before.totalPoints, 40);

      // --- FPL later reports fixture 1001 as postponed (data correction mid-week)
      const fixture1001 = stored({ fplId: 1 });
      const changes = service.detectChanges([fixture1001], [{ ...fixture1001, id: undefined, gameweekId: null, kickoffTime: null }]);
      assert.equal(changes[0].type, "POSTPONED");
      const migration = await service.migrateStats(changes);
      const rescore = await service.rescoreAffected(changes, migration.affectedGameweekIds);
      assert.deepEqual(rescore.rescored, [{ gameweekId: 33, squadIds: ["sq1"] }]);

      const gw33 = world.state.scores.find((s) => s.gameweekId === 33)!;
      // Blank: players 6 (team 2) and 9 (team 1) have no fixture. Bench MID 13 replaces 6,
      // bench DEF 14 replaces 9 (formation stays valid). Vice-captain 10 takes the armband.
      // Starters: 9 players x 2 + two subs x 2 = 22, + vice-captain bonus 2 = 24
      assert.equal(gw33.points, 24);
      assert.equal(gw33.captainPoints, 2);

      // --- The fixture is reinstated into GW34, giving teams 1 and 2 a double gameweek
      const unscheduled = { ...fixture1001, gameweekId: null, kickoffTime: null };
      const reinstated = service.detectChanges([unscheduled], [{ ...unscheduled, id: undefined, gameweekId: 34 }]);
      assert.equal(reinstated[0].type, "REINSTATED");
      await service.migrateStats(reinstated);

      // Live sync records both of team 1's fixtures in GW34 (captain scores 6 and 5)
      world.playFixture(34, 1002, [1], 6);
      world.playFixture(34, 1001, [1, 2], 5);
      playRestOfGameweek(world, 34);
      const gw34 = await world.scoring.calculateAndPersistSquadScore("sq1", 34);

      const captain = gw34.lineupDetails.find((d) => d.playerId === 9)!;
      assert.equal(captain.rawPoints, 11, "captain accrues points from both fixtures");
      assert.equal(captain.minutesPlayed, 180);
      assert.equal(captain.multiplier, 2);
      assert.equal(captain.effectivePoints, 22);
      // Player 6 (team 2) only plays the rescheduled fixture: 2. Others 2 each.
      // 9 other starters x 2 = 18, + player 6: 2, + captain 22 = 42
      assert.equal(gw34.totalPoints, 42);
      assert.ok(gw34.lineupDetails.every((d) => !d.subbedIn), "no auto-subs needed in the DGW");
    });

    it("moves already-recorded stats when a fixture is rescheduled across gameweeks", async () => {
      const world = createWorld();
      const service = world.service();
      // Zero-minute placeholder rows created by a live sync before the move
      world.state.stats.push({ playerId: 9, gameweekId: 33, fixtureId: 1001, minutes: 0, totalPoints: 0 });
      playRestOfGameweek(world, 33);
      world.state.scores.push({ squadId: "sq1", gameweekId: 33, points: 0, transferCost: 0 });

      const fixture = stored({ fplId: 1 });
      const changes = service.detectChanges([fixture], [{ ...fixture, id: undefined, gameweekId: 34 }]);
      const migration = await service.migrateStats(changes);
      assert.equal(migration.statsMoved, 1);
      await service.rescoreAffected(changes, migration.affectedGameweekIds);

      assert.ok(world.state.stats.filter((s) => s.fixtureId === 1001).every((s) => s.gameweekId === 34));
      assert.deepEqual(world.state.rescoreCalls, [["sq1", 33]], "GW34 has no score yet, so only GW33 is rescored");
    });
  });
});
