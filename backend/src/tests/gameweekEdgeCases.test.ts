import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { ScoringService, AutoSubstitutionEngine } from "../services/scoring/scoringService.js";
import { LeagueService } from "../services/league/leagueService.js";
import { normalizeFixture, normalizePlayerStats } from "../services/fpl/fplNormalizer.js";
import { isGameweekReadyForSettlement } from "../jobs/gameweekSettlement.js";
import { ChipType, MembershipStatus, Position } from "../types/index.js";
import {
  BLANK_GAMEWEEK_SCENARIOS,
  CAPTAIN_ID,
  DOUBLE_GAMEWEEK_SCENARIOS,
  POSTPONEMENT_SCENARIOS,
  RAW_DGW_LIVE_ELEMENT,
  RAW_POSTPONED_FIXTURE,
  RAW_RESCHEDULED_FIXTURE,
  ScoringScenario,
  UNUSUAL_SCORE_SCENARIOS,
  buildLineup,
  buildStats,
  type PlayerStatLine,
} from "./fixtures/gameweekEdgeCases.js";

/**
 * Regression suite for historical FPL gameweek edge cases: double gameweeks,
 * blank gameweeks, postponed / rescheduled fixtures and late stat corrections.
 * Scenario data and hand-verified expectations live in ./fixtures/gameweekEdgeCases.ts.
 */

function runScenario(scenario: ScoringScenario) {
  return ScoringService.calculateLineupScore(
    buildLineup(),
    buildStats(scenario.overrides, scenario.absent),
    scenario.options
  );
}

function assertScenario(scenario: ScoringScenario) {
  const result = runScenario(scenario);
  const { expected } = scenario;
  const ids = (flag: "subbedIn" | "subbedOut") =>
    result.details.filter((d) => d[flag]).map((d) => d.playerId).sort((a, b) => a - b);

  assert.equal(result.startingPoints, expected.startingPoints, "startingPoints");
  assert.equal(result.benchPoints, expected.benchPoints, "benchPoints");
  assert.equal(result.captainPoints, expected.captainPoints, "captainPoints");
  assert.equal(result.transferCost, expected.transferCost, "transferCost");
  assert.equal(result.totalPoints, expected.totalPoints, "totalPoints");
  assert.deepEqual(ids("subbedIn"), [...expected.subbedIn].sort((a, b) => a - b), "subbedIn");
  assert.deepEqual(ids("subbedOut"), [...expected.subbedOut].sort((a, b) => a - b), "subbedOut");
  // Every squad player is always reported exactly once, in positionOrder
  assert.deepEqual(result.details.map((d) => d.playerId), buildLineup().map((p) => p.playerId));
}

function describeScenarios(title: string, scenarios: ScoringScenario[]) {
  describe(title, () => {
    for (const scenario of scenarios) {
      it(`${scenario.name} — ${scenario.context}`, () => assertScenario(scenario));
    }
  });
}

describe("Gameweek edge-case regression suite", () => {
  describeScenarios("Double gameweeks", DOUBLE_GAMEWEEK_SCENARIOS);
  describeScenarios("Blank gameweeks", BLANK_GAMEWEEK_SCENARIOS);
  describeScenarios("Postponed fixtures", POSTPONEMENT_SCENARIOS);
  describeScenarios("Unusual scores", UNUSUAL_SCORE_SCENARIOS);

  describe("Scoring invariants across every scenario", () => {
    const all = [
      ...DOUBLE_GAMEWEEK_SCENARIOS,
      ...BLANK_GAMEWEEK_SCENARIOS,
      ...POSTPONEMENT_SCENARIOS,
      ...UNUSUAL_SCORE_SCENARIOS,
    ];

    it("never fields more than 11 scoring players or an invalid formation", () => {
      for (const scenario of all) {
        const { details } = runScenario(scenario);
        const fielded = details.filter((d) => (d.isStarter && !d.subbedOut) || d.subbedIn);
        assert.equal(fielded.length, 11, scenario.name);
        assert.equal(fielded.filter((d) => d.position === "GKP").length, 1, scenario.name);
        assert.ok(fielded.filter((d) => d.position === "DEF").length >= 3, scenario.name);
        assert.ok(fielded.filter((d) => d.position === "MID").length >= 2, scenario.name);
        assert.ok(fielded.filter((d) => d.position === "FWD").length >= 1, scenario.name);
      }
    });

    it("applies the captaincy multiplier to at most one fielded player", () => {
      for (const scenario of all) {
        const { details } = runScenario(scenario);
        const multiplied = details.filter(
          (d) => d.multiplier > 1 && ((d.isStarter && !d.subbedOut) || d.subbedIn)
        );
        assert.ok(multiplied.length <= 1, scenario.name);
        for (const player of multiplied) {
          assert.ok(player.isCaptain || player.isViceCaptain, scenario.name);
        }
      }
    });

    it("is deterministic: rescoring the same inputs gives the same result", () => {
      for (const scenario of all) {
        assert.deepEqual(runScenario(scenario), runScenario(scenario), scenario.name);
      }
    });

    it("does not depend on the order players are supplied in", () => {
      for (const scenario of all) {
        const reversed = ScoringService.calculateLineupScore(
          buildLineup().reverse(),
          buildStats(scenario.overrides, scenario.absent),
          scenario.options
        );
        assert.deepEqual(reversed, runScenario(scenario), scenario.name);
      }
    });
  });

  describe("FPL feed normalization", () => {
    it("keeps double gameweek stats aggregated across both fixtures", () => {
      const stats = normalizePlayerStats(RAW_DGW_LIVE_ELEMENT);
      assert.equal(stats.minutes, 180);
      assert.equal(stats.goals, 3);
      assert.equal(stats.bonus, 5);
      assert.equal(stats.totalPoints, 24);
      // Two clean sheets in one gameweek still map to the boolean flag
      assert.equal(stats.cleanSheet, true);
    });

    it("detaches a postponed fixture from its gameweek", () => {
      const fixture = normalizeFixture(RAW_POSTPONED_FIXTURE);
      assert.equal(fixture.gameweekFplId, null);
      assert.equal(fixture.kickoffTime, null);
      assert.equal(fixture.finished, false);
    });

    it("reattaches a rescheduled fixture to its new gameweek", () => {
      const fixture = normalizeFixture(RAW_RESCHEDULED_FIXTURE);
      assert.equal(fixture.fplId, RAW_POSTPONED_FIXTURE.id);
      assert.equal(fixture.gameweekFplId, 34);
      assert.equal(fixture.kickoffTime?.toISOString(), "2026-04-22T18:45:00.000Z");
    });
  });

  describe("Settlement readiness", () => {
    const done = { finished: true };
    const pending = { finished: false };

    it("settles a normal gameweek once every fixture is finished", () => {
      assert.equal(isGameweekReadyForSettlement(Array(10).fill(done)), true);
    });

    it("waits for the second fixture of a double gameweek", () => {
      assert.equal(isGameweekReadyForSettlement([...Array(10).fill(done), pending]), false);
    });

    it("waits while a postponed fixture is still attached to the gameweek", () => {
      // Between the postponement and FPL detaching it (event: null) the fixture is unfinished
      assert.equal(isGameweekReadyForSettlement([...Array(9).fill(done), pending]), false);
    });

    it("settles a blank gameweek once the postponed fixture has been detached", () => {
      assert.equal(isGameweekReadyForSettlement(Array(8).fill(done)), true);
    });

    it("never settles a gameweek with no fixtures", () => {
      assert.equal(isGameweekReadyForSettlement([]), false);
    });
  });
});

// ============================================================
// Persistence: rescoring, late corrections and season totals
// ============================================================

interface ScoreRow {
  squadId: string;
  gameweekId: number;
  points: number;
  benchPoints: number;
  captainPoints: number;
  transferCost: number;
}

function createScoringDb() {
  const lineup = buildLineup();
  const state = {
    squadTotal: 0,
    stats: new Map<number, Map<number, PlayerStatLine>>(),
    chips: new Map<number, ChipType>(),
    scores: [] as ScoreRow[],
  };
  const findScore = (squadId: string, gameweekId: number) =>
    state.scores.find((s) => s.squadId === squadId && s.gameweekId === gameweekId) ?? null;

  const db = {
    squad: {
      findUnique: async () => ({
        id: "squad_1",
        players: lineup.map((p) => ({ ...p, player: { position: p.position } })),
      }),
      update: async ({ data }: any) => {
        state.squadTotal = data.totalPoints;
      },
    },
    playerGameweekStats: {
      findMany: async ({ where }: any) =>
        [...(state.stats.get(where.gameweekId) ?? new Map()).entries()]
          .filter(([playerId]) => where.playerId.in.includes(playerId))
          .map(([playerId, line]) => ({ playerId, ...line })),
    },
    squadChipUsage: {
      findUnique: async ({ where }: any) => {
        const chipType = state.chips.get(where.squadId_gameweekId.gameweekId);
        return chipType ? { chipType } : null;
      },
    },
    squadGameweekScore: {
      findUnique: async ({ where }: any) =>
        findScore(where.squadId_gameweekId.squadId, where.squadId_gameweekId.gameweekId),
      upsert: async ({ where, update, create }: any) => {
        const existing = findScore(where.squadId_gameweekId.squadId, where.squadId_gameweekId.gameweekId);
        if (existing) return Object.assign(existing, update);
        state.scores.push({ ...create });
        return create;
      },
      findMany: async ({ where }: any) =>
        state.scores.filter(
          (s) =>
            s.squadId === where.squadId &&
            (where.gameweekId?.gte === undefined || s.gameweekId >= where.gameweekId.gte) &&
            (where.gameweekId?.lte === undefined || s.gameweekId <= where.gameweekId.lte)
        ),
    },
  };

  return { db: db as unknown as PrismaClient, state };
}

describe("Gameweek edge cases — score persistence", () => {
  it("rescoring a gameweek is idempotent (no duplicate rows, no double counting)", async () => {
    const { db, state } = createScoringDb();
    state.stats.set(1, buildStats());
    const service = new ScoringService(db);

    const first = await service.calculateAndPersistSquadScore("squad_1", 1);
    const second = await service.calculateAndPersistSquadScore("squad_1", 1);

    assert.equal(first.totalPoints, 24);
    assert.deepEqual(second, first);
    assert.equal(state.scores.length, 1);
    assert.equal(state.squadTotal, 24);
  });

  it("applies late bonus-point corrections from the second leg of a double gameweek", async () => {
    const { db, state } = createScoringDb();
    const service = new ScoringService(db);

    // Provisional: captain's first fixture is final, second fixture awaiting bonus
    state.stats.set(30, buildStats({ [CAPTAIN_ID]: { minutes: 180, totalPoints: 16 } }));
    assert.equal((await service.calculateAndPersistSquadScore("squad_1", 30)).totalPoints, 52);

    // FPL confirms 3 bonus points for the second fixture
    state.stats.set(30, buildStats({ [CAPTAIN_ID]: { minutes: 180, totalPoints: 19 } }));
    const corrected = await service.calculateAndPersistSquadScore("squad_1", 30);

    assert.equal(corrected.totalPoints, 58);
    assert.equal(corrected.captainPoints, 19);
    assert.equal(state.scores.length, 1);
    assert.equal(state.squadTotal, 58);
  });

  it("keeps the transfer hit recorded before the deadline when rescoring", async () => {
    const { db, state } = createScoringDb();
    state.stats.set(2, buildStats());
    state.scores.push({ squadId: "squad_1", gameweekId: 2, points: 0, benchPoints: 0, captainPoints: 0, transferCost: 8 });
    const service = new ScoringService(db);

    const result = await service.calculateAndPersistSquadScore("squad_1", 2);
    const rescored = await service.calculateAndPersistSquadScore("squad_1", 2);

    assert.equal(result.transferCost, 8);
    assert.equal(result.totalPoints, 16);
    assert.equal(rescored.totalPoints, 16);
    assert.equal(state.squadTotal, 16);
  });

  it("reads the chip played for the gameweek from storage", async () => {
    const { db, state } = createScoringDb();
    state.stats.set(34, buildStats({ [CAPTAIN_ID]: { minutes: 180, totalPoints: 19 } }));
    state.chips.set(34, ChipType.TRIPLE_CAPTAIN);
    const service = new ScoringService(db);

    const result = await service.calculateAndPersistSquadScore("squad_1", 34);

    assert.equal(result.chip, ChipType.TRIPLE_CAPTAIN);
    assert.equal(result.totalPoints, 77);
  });

  it("totals a season where a postponed fixture is replayed in a later double gameweek", async () => {
    const { db, state } = createScoringDb();
    const service = new ScoringService(db);

    // GW30: DEF 4 and 5 have their fixture postponed (no stats rows)
    state.stats.set(30, buildStats({}, [4, 5]));
    // GW31: ordinary gameweek
    state.stats.set(31, buildStats());
    // GW34: the rescheduled match makes it a double gameweek for DEF 4 and 5
    state.stats.set(
      34,
      buildStats({ 4: { minutes: 180, totalPoints: 12 }, 5: { minutes: 180, totalPoints: 9 } })
    );

    const gw30 = await service.calculateAndPersistSquadScore("squad_1", 30);
    const gw31 = await service.calculateAndPersistSquadScore("squad_1", 31);
    const gw34 = await service.calculateAndPersistSquadScore("squad_1", 34);

    // GW30: DEF 13 replaces DEF 4, which keeps 4 defenders so MID 14 may replace DEF 5
    assert.deepEqual(
      gw30.lineupDetails.filter((d) => d.subbedIn).map((d) => d.playerId),
      [13, 14]
    );
    assert.equal(gw30.totalPoints, 4 + 8 * 2 + 1 + 1);
    assert.equal(gw31.totalPoints, 24);
    assert.equal(gw34.totalPoints, 4 + 8 * 2 + 12 + 9);
    assert.equal(state.squadTotal, gw30.totalPoints + gw31.totalPoints + gw34.totalPoints);
    assert.equal(await service.getSquadScoreAcrossGameweeks("squad_1", 31, 34), gw31.totalPoints + gw34.totalPoints);
  });
});

// ============================================================
// Head-to-head settlement in unusual gameweeks
// ============================================================

describe("Gameweek edge cases — head-to-head settlement", () => {
  function createH2HDb(scores: Array<{ squadId: string; points: number }>, awayMemberId: string | null) {
    const members = new Map<string, any>(
      ["m1", "m2"].map((id, i) => [
        id,
        {
          id,
          squadId: `s${i + 1}`,
          userId: `u${i + 1}`,
          status: MembershipStatus.ACTIVE,
          matchesWon: 0,
          matchesDrawn: 0,
          matchesLost: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          h2hPoints: 0,
          rank: null,
        },
      ])
    );
    const fixtures: any[] = [
      { id: "f1", leagueId: "L", gameweekId: 30, homeMemberId: "m1", awayMemberId, isFinished: false },
    ];
    const db: any = {
      leagueFixture: {
        findMany: async ({ where }: any) => fixtures.filter((f) => f.isFinished === where.isFinished),
        update: async ({ where, data }: any) => Object.assign(fixtures.find((f) => f.id === where.id), data),
      },
      leagueMember: {
        findMany: async () => [...members.values()],
        update: async ({ where, data }: any) => {
          const member = members.get(where.id);
          for (const [key, value] of Object.entries<any>(data)) {
            member[key] = typeof value === "object" ? member[key] + value.increment : value;
          }
        },
      },
      squadGameweekScore: { findMany: async () => scores },
      $transaction: async (fn: any) => fn(db),
    };
    return { db, members, fixtures };
  }

  it("treats a manager with no score row (fully blanked squad never scored) as 0", async () => {
    const { db, members, fixtures } = createH2HDb([{ squadId: "s1", points: 41 }], "m2");

    await new LeagueService(db).settleH2HGameweek("L", 30);

    assert.deepEqual([fixtures[0].homeScore, fixtures[0].awayScore], [41, 0]);
    assert.equal(members.get("m1").matchesWon, 1);
    assert.equal(members.get("m2").matchesLost, 1);
  });

  it("scores a draw when both managers' double gameweeks finish level", async () => {
    const { db, members } = createH2HDb(
      [
        { squadId: "s1", points: 96 },
        { squadId: "s2", points: 96 },
      ],
      "m2"
    );

    await new LeagueService(db).settleH2HGameweek("L", 30);

    assert.equal(members.get("m1").h2hPoints, 1);
    assert.equal(members.get("m2").h2hPoints, 1);
  });

  it("compares negative scores after heavy transfer hits correctly", async () => {
    const { db, members } = createH2HDb(
      [
        { squadId: "s1", points: -4 },
        { squadId: "s2", points: -8 },
      ],
      "m2"
    );

    await new LeagueService(db).settleH2HGameweek("L", 30);

    assert.equal(members.get("m1").h2hPoints, 3);
    assert.equal(members.get("m1").pointsFor, -4);
    assert.equal(members.get("m2").pointsAgainst, -4);
  });

  it("does not resettle a gameweek when the settlement job is retried", async () => {
    const { db, members } = createH2HDb([{ squadId: "s1", points: 50 }, { squadId: "s2", points: 40 }], null);
    const service = new LeagueService(db);

    assert.deepEqual(await service.settleH2HGameweek("L", 30), { settled: 1 });
    assert.deepEqual(await service.settleH2HGameweek("L", 30), { settled: 0 });
    // Against the league Average (mean of 50 and 40 = 45) m1 wins exactly once
    assert.equal(members.get("m1").matchesWon, 1);
    assert.equal(members.get("m1").pointsAgainst, 45);
  });
});

// ============================================================
// Dynamic formation constraint-satisfaction solver (Issue #226)
// ============================================================

describe("Dynamic formation solver — multi-player DGW/BGW auto-substitution matrix", () => {
  function buildFormationLineup(
    starterPositions: [number, number, number], // [DEF, MID, FWD]
    benchOutfieldPositions: [Position, Position, Position]
  ) {
    const [defCount, midCount, fwdCount] = starterPositions;
    const starterList: Position[] = [
      Position.GKP,
      ...Array(defCount).fill(Position.DEF),
      ...Array(midCount).fill(Position.MID),
      ...Array(fwdCount).fill(Position.FWD),
    ];

    const starters = starterList.map((position, idx) => ({
      playerId: idx + 1,
      position,
      isStarter: true,
      isCaptain: idx + 1 === 11,
      isViceCaptain: idx + 1 === 6,
      positionOrder: idx + 1,
    }));

    const bench = [
      {
        playerId: 12,
        position: Position.GKP,
        isStarter: false,
        isCaptain: false,
        isViceCaptain: false,
        positionOrder: 12,
      },
      ...benchOutfieldPositions.map((position, idx) => ({
        playerId: 13 + idx,
        position,
        isStarter: false,
        isCaptain: false,
        isViceCaptain: false,
        positionOrder: 13 + idx,
      })),
    ];

    return [...starters, ...bench];
  }

  it("solves coupled 3-starter blank in 3-4-3 where 1-for-1 DEF swap would violate min-DEF without paired FWD/DEF swap", () => {
    // 3-4-3 starters: 1 GKP | 2,3,4 DEF | 5,6,7,8 MID | 9,10,11 FWD
    // Bench: 12 GKP | 13 FWD | 14 MID | 15 DEF
    const lineup = buildFormationLineup(
      [3, 4, 3],
      [Position.FWD, Position.MID, Position.DEF]
    );
    const stats = buildStats(
      {
        13: { minutes: 180, totalPoints: 14 },
        14: { minutes: 180, totalPoints: 10 },
        15: { minutes: 180, totalPoints: 8 },
      },
      [2, 5, 9] // DEF 2, MID 5, FWD 9 all blank (0 minutes)
    );

    const result = ScoringService.calculateLineupScore(lineup, stats);
    const subbedIn = result.details.filter((d) => d.subbedIn).map((d) => d.playerId);
    const subbedOut = result.details.filter((d) => d.subbedOut).map((d) => d.playerId);

    // All 3 bench outfielders come on globally, preserving 3-4-3
    assert.deepEqual(subbedIn, [13, 14, 15]);
    assert.deepEqual(subbedOut, [2, 5, 9]);

    const fielded = result.details.filter((d) => (d.isStarter && !d.subbedOut) || d.subbedIn);
    const counts = AutoSubstitutionEngine.countFormation(fielded);
    assert.equal(AutoSubstitutionEngine.isFormationValid(counts), true);
    assert.deepEqual(counts, { gkp: 1, def: 3, mid: 4, fwd: 3 });
  });

  it("prevents illegal 4-forward formation in 4-3-3 when DEF + FWD blank and only bench FWD played", () => {
    // 4-3-3 starters: 1 GKP | 2,3,4,5 DEF | 6,7,8 MID | 9,10,11 FWD
    // Bench: 12 GKP | 13 FWD (played) | 14 DEF (0m) | 15 MID (0m)
    const lineup = buildFormationLineup(
      [4, 3, 3],
      [Position.FWD, Position.DEF, Position.MID]
    );
    const stats = buildStats(
      {
        13: { minutes: 180, totalPoints: 12 },
        14: { minutes: 0, totalPoints: 0 },
        15: { minutes: 0, totalPoints: 0 },
      },
      [2, 10] // DEF 2 and FWD 10 both blank
    );

    const result = ScoringService.calculateLineupScore(lineup, stats);
    const subbedIn = result.details.filter((d) => d.subbedIn).map((d) => d.playerId);
    const subbedOut = result.details.filter((d) => d.subbedOut).map((d) => d.playerId);

    // Bench FWD 13 must replace FWD 10 (keeping 4-3-3), NOT DEF 2 (which would create illegal 3-3-4)
    assert.deepEqual(subbedIn, [13]);
    assert.deepEqual(subbedOut, [10]);

    const fielded = result.details.filter((d) => (d.isStarter && !d.subbedOut) || d.subbedIn);
    const counts = AutoSubstitutionEngine.countFormation(fielded);
    assert.equal(AutoSubstitutionEngine.isFormationValid(counts), true);
    assert.deepEqual(counts, { gkp: 1, def: 4, mid: 3, fwd: 3 });
  });

  it("handles 4 simultaneous missing starters across GKP, DEF, MID, and FWD in 5-2-3", () => {
    // 5-2-3 starters: 1 GKP | 2,3,4,5,6 DEF | 7,8 MID | 9,10,11 FWD
    // Bench: 12 GKP | 13 MID | 14 MID | 15 MID
    const lineup = buildFormationLineup(
      [5, 2, 3],
      [Position.MID, Position.MID, Position.MID]
    );
    const stats = buildStats(
      {
        12: { minutes: 180, totalPoints: 9 },
        13: { minutes: 180, totalPoints: 11 },
        14: { minutes: 180, totalPoints: 7 },
        15: { minutes: 180, totalPoints: 6 },
      },
      [1, 2, 7, 9] // GKP 1, DEF 2, MID 7, FWD 9 all miss out
    );

    const result = ScoringService.calculateLineupScore(lineup, stats);
    const subbedIn = result.details.filter((d) => d.subbedIn).map((d) => d.playerId);
    const subbedOut = result.details.filter((d) => d.subbedOut).map((d) => d.playerId);

    // GKP 12 replaces GKP 1; MID 13, 14, 15 replace DEF 2, MID 7, FWD 9 -> transitions 5-2-3 to valid 4-4-2
    assert.deepEqual(subbedIn, [12, 13, 14, 15]);
    assert.deepEqual(subbedOut, [1, 2, 7, 9]);

    const fielded = result.details.filter((d) => (d.isStarter && !d.subbedOut) || d.subbedIn);
    const counts = AutoSubstitutionEngine.countFormation(fielded);
    assert.equal(AutoSubstitutionEngine.isFormationValid(counts), true);
    assert.deepEqual(counts, { gkp: 1, def: 4, mid: 4, fwd: 2 });
  });

  it("handles 4 missing outfield starters by replacing the optimal valid 3-starter subset in 3-5-2", () => {
    // 3-5-2 starters: 1 GKP | 2,3,4 DEF | 5,6,7,8,9 MID | 10,11 FWD
    // Bench: 12 GKP | 13 FWD | 14 DEF | 15 DEF
    const lineup = buildFormationLineup(
      [3, 5, 2],
      [Position.FWD, Position.DEF, Position.DEF]
    );
    const stats = buildStats(
      {
        13: { minutes: 90, totalPoints: 8 },
        14: { minutes: 90, totalPoints: 6 },
        15: { minutes: 0, totalPoints: 0 }, // 3rd bench outfielder blanked
      },
      [2, 5, 6, 10] // DEF 2, MID 5, MID 6, FWD 10 all blank (4 outfield starters)
    );

    const result = ScoringService.calculateLineupScore(lineup, stats);
    const subbedIn = result.details.filter((d) => d.subbedIn).map((d) => d.playerId);
    const subbedOut = result.details.filter((d) => d.subbedOut).map((d) => d.playerId);

    // Bench 13 (FWD) and 14 (DEF) both come on for DEF 2 and MID 5 -> valid 3-4-3
    assert.deepEqual(subbedIn, [13, 14]);
    assert.deepEqual(subbedOut, [2, 5]);

    const fielded = result.details.filter((d) => (d.isStarter && !d.subbedOut) || d.subbedIn);
    const counts = AutoSubstitutionEngine.countFormation(fielded);
    assert.equal(AutoSubstitutionEngine.isFormationValid(counts), true);
    assert.deepEqual(counts, { gkp: 1, def: 3, mid: 4, fwd: 3 });
  });

  it("exhaustively validates all 8 legal formations under 3+ missing starters without violating formation rules", () => {
    const formationMatrix: Array<{
      name: string;
      starters: [number, number, number];
      bench: [Position, Position, Position];
      absentStarters: number[];
      absentBench?: number[];
      expectedSubbedIn: number[];
      expectedFormation: { def: number; mid: number; fwd: number };
    }> = [
      {
        name: "3-5-2 -> 4-4-2 with 3 missing starters",
        starters: [3, 5, 2],
        bench: [Position.DEF, Position.DEF, Position.FWD],
        absentStarters: [2, 5, 10], // DEF 2, MID 5, FWD 10
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 4, mid: 4, fwd: 2 },
      },
      {
        name: "3-4-3 -> 4-4-2 with 3 missing starters",
        starters: [3, 4, 3],
        bench: [Position.DEF, Position.DEF, Position.MID],
        absentStarters: [2, 5, 9], // DEF 2, MID 5, FWD 9
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 4, mid: 4, fwd: 2 },
      },
      {
        name: "4-4-2 -> 3-5-2 with 3 missing starters",
        starters: [4, 4, 2],
        bench: [Position.MID, Position.DEF, Position.FWD],
        absentStarters: [2, 3, 10], // DEF 2, DEF 3, FWD 10
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 3, mid: 5, fwd: 2 },
      },
      {
        name: "4-3-3 -> 4-5-1 with 3 missing starters",
        starters: [4, 3, 3],
        bench: [Position.MID, Position.MID, Position.DEF],
        absentStarters: [2, 9, 10], // DEF 2, FWD 9, FWD 10
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 4, mid: 5, fwd: 1 },
      },
      {
        name: "5-3-2 -> 3-5-2 with 3 missing starters",
        starters: [5, 3, 2],
        bench: [Position.MID, Position.MID, Position.FWD],
        absentStarters: [2, 3, 10], // DEF 2, DEF 3, FWD 10
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 3, mid: 5, fwd: 2 },
      },
      {
        name: "5-4-1 -> 3-4-3 with 3 missing starters",
        starters: [5, 4, 1],
        bench: [Position.FWD, Position.FWD, Position.MID],
        absentStarters: [2, 3, 7], // DEF 2, DEF 3, MID 7
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 3, mid: 4, fwd: 3 },
      },
      {
        name: "4-5-1 -> 3-4-3 with 3 missing starters",
        starters: [4, 5, 1],
        bench: [Position.FWD, Position.DEF, Position.FWD],
        absentStarters: [2, 3, 6], // DEF 2, DEF 3, MID 6
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 3, mid: 4, fwd: 3 },
      },
      {
        name: "5-2-3 -> 3-5-2 with 3 missing starters",
        starters: [5, 2, 3],
        bench: [Position.MID, Position.MID, Position.MID],
        absentStarters: [2, 3, 9], // DEF 2, DEF 3, FWD 9
        expectedSubbedIn: [13, 14, 15],
        expectedFormation: { def: 3, mid: 5, fwd: 2 },
      },
    ];

    for (const tc of formationMatrix) {
      const lineup = buildFormationLineup(tc.starters, tc.bench);
      const stats = buildStats({}, [...tc.absentStarters, ...(tc.absentBench ?? [])]);
      const result = ScoringService.calculateLineupScore(lineup, stats);
      const subbedIn = result.details.filter((d) => d.subbedIn).map((d) => d.playerId);
      const fielded = result.details.filter((d) => (d.isStarter && !d.subbedOut) || d.subbedIn);
      const counts = AutoSubstitutionEngine.countFormation(fielded);

      assert.deepEqual(subbedIn, tc.expectedSubbedIn, `${tc.name}: subbedIn`);
      assert.equal(AutoSubstitutionEngine.isFormationValid(counts), true, `${tc.name}: isFormationValid`);
      assert.deepEqual(
        { def: counts.def, mid: counts.mid, fwd: counts.fwd },
        tc.expectedFormation,
        `${tc.name}: formation`
      );
    }
  });
});
