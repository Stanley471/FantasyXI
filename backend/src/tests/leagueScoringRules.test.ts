import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import {
  LeagueScoringConfig,
  SCORING_PRESETS,
  ScoringConfigValidationError,
  resolveScoringConfig,
  validateScoringConfig,
} from "../models/leagueScoringConfig.js";
import {
  ScoringEventStats,
  compileScoringRules,
  compiledScoringRulesCacheSize,
} from "../services/scoring/scoringRuleEngine.js";
import { PlayerFixtureStats, ScoringService } from "../services/scoring/scoringService.js";
import {
  LeagueForbiddenError,
  LeagueService,
  LeagueValidationError,
} from "../services/league/leagueService.js";
import { LeagueStatus, Position, ScoringType } from "../types/index.js";

const ZERO: ScoringEventStats = {
  minutes: 0,
  goals: 0,
  assists: 0,
  cleanSheet: false,
  goalsConceded: 0,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bonus: 0,
};
const ev = (overrides: Partial<ScoringEventStats>): ScoringEventStats => ({ ...ZERO, ...overrides });

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

describe("LeagueScoringConfig validation (#272)", () => {
  it("accepts every built-in preset", () => {
    for (const preset of Object.values(SCORING_PRESETS)) {
      assert.deepEqual(validateScoringConfig(preset), []);
    }
  });

  it("rejects negative points for goals", () => {
    assert.throws(
      () => resolveScoringConfig({ rules: { goal: { FWD: -4 } } }),
      (err: unknown) =>
        err instanceof ScoringConfigValidationError &&
        err.issues.some((i) => i.startsWith("goal.FWD"))
    );
  });

  it("rejects zero points for goals, but allows zero for other rewards", () => {
    assert.throws(() => resolveScoringConfig({ rules: { goal: { MID: 0 } } }), ScoringConfigValidationError);
    assert.equal(resolveScoringConfig({ rules: { assist: 0 } }).assist, 0);
  });

  it("rejects rewards for punishable events", () => {
    for (const rules of [
      { redCard: 3 },
      { yellowCard: 1 },
      { ownGoal: 2 },
      { penaltyMiss: 1 },
      { goalsConcededPer2: { DEF: 1 } },
    ]) {
      assert.throws(() => resolveScoringConfig({ rules }), ScoringConfigValidationError, JSON.stringify(rules));
    }
  });

  it("rejects non-integers, out-of-range values and unknown rules or positions", () => {
    for (const rules of [
      { assist: 2.5 },
      { assist: "3" },
      { savesPer3: 21 },
      { redCard: -21 },
      { bonusMultiplier: 4 },
      { bonusMultiplier: -1 },
      { hatTrickBonus: 5 },
      { goal: { STRIKER: 5 } },
    ]) {
      assert.throws(() => resolveScoringConfig({ rules }), ScoringConfigValidationError, JSON.stringify(rules));
    }
  });

  it("rejects inconsistent rule combinations", () => {
    assert.throws(() => resolveScoringConfig({ rules: { appearance: 3, appearance60: 2 } }), ScoringConfigValidationError);
    assert.throws(() => resolveScoringConfig({ rules: { yellowCard: -3, redCard: -1 } }), ScoringConfigValidationError);
  });

  it("rejects an unknown preset", () => {
    assert.throws(() => resolveScoringConfig({ preset: "MOON_BALL" }), ScoringConfigValidationError);
  });

  it("merges positional overrides per position and marks the result CUSTOM", () => {
    const config = resolveScoringConfig({ preset: "ALL_ATTACK", rules: { goal: { GKP: 15 } } });
    assert.deepEqual(config.goal, { ...SCORING_PRESETS.ALL_ATTACK.goal, GKP: 15 });
    assert.equal(config.preset, "CUSTOM");
    assert.equal(resolveScoringConfig({ preset: "ALL_ATTACK" }).preset, "ALL_ATTACK");
  });

  it("never mutates the shared preset objects", () => {
    resolveScoringConfig({ rules: { goal: { GKP: 20 }, assist: 9 } });
    assert.equal(SCORING_PRESETS.CLASSIC_FPL.goal.GKP, 10);
    assert.equal(SCORING_PRESETS.CLASSIC_FPL.assist, 3);
  });
});

// ---------------------------------------------------------------------------
// Compiled rule engine
// ---------------------------------------------------------------------------

describe("Scoring rule engine (#272)", () => {
  const classic = compileScoringRules(SCORING_PRESETS.CLASSIC_FPL);

  it("CLASSIC_FPL reproduces official FPL points for standard events", () => {
    // Defender, 90 mins, goal, clean sheet, 1 bonus: 2 + 6 + 4 + 1 = 13
    assert.equal(classic.score(ev({ minutes: 90, goals: 1, cleanSheet: true, bonus: 1 }), "DEF"), 13);
    // Goalkeeper, 90 mins, 7 saves, penalty save, conceded 3: 2 + 2 + 5 - 1 = 8
    assert.equal(classic.score(ev({ minutes: 90, saves: 7, penaltiesSaved: 1, goalsConceded: 3 }), "GKP"), 8);
    // Forward, 70 mins, 2 goals, assist, yellow: 2 + 8 + 3 - 1 = 12
    assert.equal(classic.score(ev({ minutes: 70, goals: 2, assists: 1, yellowCards: 1 }), "FWD"), 12);
    // Midfielder, 30 mins, own goal, missed penalty, red: 1 - 2 - 2 - 3 = -6
    assert.equal(classic.score(ev({ minutes: 30, ownGoals: 1, penaltiesMissed: 1, redCards: 1 }), "MID"), -6);
  });

  it("clean sheets need 60+ minutes and unused players score nothing", () => {
    assert.equal(classic.score(ev({ minutes: 59, cleanSheet: true }), "DEF"), 1);
    assert.equal(classic.score(ev({ minutes: 0, goals: 1, yellowCards: 1 }), "FWD"), 0);
  });

  it("applies position-specific weights from custom rules", () => {
    const rules = compileScoringRules(resolveScoringConfig({ rules: { goal: { GKP: 20, FWD: 4 } } }));
    const goal = ev({ minutes: 90, goals: 1 });
    assert.equal(rules.score(goal, "GKP"), 22);
    assert.equal(rules.score(goal, "FWD"), 6);
  });

  it("bonus multiplier scales or disables bonus points", () => {
    const tripled = compileScoringRules(resolveScoringConfig({ rules: { bonusMultiplier: 3 } }));
    const none = compileScoringRules(resolveScoringConfig({ rules: { bonusMultiplier: 0 } }));
    const stats = ev({ minutes: 90, bonus: 3 });
    assert.equal(tripled.score(stats, "MID"), 2 + 9);
    assert.equal(none.score(stats, "MID"), 2);
  });

  it("caches compiled rules: equal configs share one compilation regardless of key order", () => {
    const a = resolveScoringConfig({ preset: "DEFENSIVE_MASTERMIND", rules: { assist: 4 } });
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())));
    const before = compiledScoringRulesCacheSize();
    const first = compileScoringRules(a);
    const second = compileScoringRules(reordered);
    assert.equal(first, second);
    assert.ok(compiledScoringRulesCacheSize() <= before + 1);
  });

  it("refuses to compile an invalid stored config", () => {
    assert.throws(
      () => compileScoringRules({ ...SCORING_PRESETS.CLASSIC_FPL, goal: { GKP: -1, DEF: 6, MID: 5, FWD: 4 } }),
      ScoringConfigValidationError
    );
  });
});

// ---------------------------------------------------------------------------
// ScoringService integration
// ---------------------------------------------------------------------------

const LINEUP = [
  { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 1 },
  { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 2 },
  { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
  { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
  { playerId: 5, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 },
  { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 6 },
  { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
  { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
  { playerId: 9, position: Position.FWD, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 9 },
  { playerId: 10, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
  { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },
  { playerId: 12, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
  { playerId: 13, position: Position.DEF, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 },
  { playerId: 14, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 },
  { playerId: 15, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 },
];

function fixtureRow(playerId: number, events: Partial<ScoringEventStats>, totalPoints: number): PlayerFixtureStats {
  return { playerId, totalPoints, ...ev(events) };
}

// Every starter plays 90; GKP + DEF keep a clean sheet; the captain (FWD 9) scores twice
const STATS: PlayerFixtureStats[] = [
  fixtureRow(1, { minutes: 90, cleanSheet: true, saves: 3 }, 7),
  fixtureRow(2, { minutes: 90, cleanSheet: true }, 6),
  fixtureRow(3, { minutes: 90, cleanSheet: true, assists: 1 }, 9),
  fixtureRow(4, { minutes: 90, cleanSheet: true, yellowCards: 1 }, 5),
  fixtureRow(5, { minutes: 90, goals: 1 }, 7),
  fixtureRow(6, { minutes: 90 }, 2),
  fixtureRow(7, { minutes: 90 }, 2),
  fixtureRow(8, { minutes: 90 }, 2),
  fixtureRow(9, { minutes: 90, goals: 2, bonus: 3 }, 13),
  fixtureRow(10, { minutes: 90 }, 2),
  fixtureRow(11, { minutes: 90 }, 2),
  fixtureRow(12, { minutes: 0 }, 0),
];
const POSITIONS = new Map(LINEUP.map((p) => [p.playerId, p.position]));

describe("ScoringService custom league scoring (#272)", () => {
  it("default path sums official totalPoints exactly as before", () => {
    const map = ScoringService.buildStatsMap(STATS);
    assert.deepEqual(map.get(9), { minutes: 90, totalPoints: 13 });
    const result = ScoringService.calculateLineupScore(LINEUP, map);
    // 7+6+9+5+7+2+2+2+(13*2)+2+2
    assert.equal(result.totalPoints, 70);
  });

  it("double gameweek fixtures are summed under custom rules too", () => {
    const rules = compileScoringRules(SCORING_PRESETS.CLASSIC_FPL);
    const map = ScoringService.buildStatsMap(
      [fixtureRow(9, { minutes: 90, goals: 1 }, 6), fixtureRow(9, { minutes: 45, goals: 1 }, 5)],
      POSITIONS,
      rules
    );
    assert.deepEqual(map.get(9), { minutes: 135, totalPoints: 6 + 5 });
  });

  it("scores the same squad differently across parallel leagues, with captaincy applied", () => {
    const totals = Object.fromEntries(
      (["CLASSIC_FPL", "ALL_ATTACK", "DEFENSIVE_MASTERMIND"] as const).map((preset) => {
        const rules = compileScoringRules(SCORING_PRESETS[preset]);
        const map = ScoringService.buildStatsMap(STATS, POSITIONS, rules);
        return [preset, ScoringService.calculateLineupScore(LINEUP, map).totalPoints];
      })
    );

    // CLASSIC_FPL re-derived from events matches the official total
    assert.equal(totals.CLASSIC_FPL, 70);
    // ALL_ATTACK: GKP 2+2+1=5, DEF 4,7,3, MID 2+7=9, 2,2,2, FWD 2+12+3=17 (x2), 2, 2
    assert.equal(totals.ALL_ATTACK, 5 + 4 + 9 + 3 + 9 + 2 + 2 + 2 + 34 + 2 + 2);
    // DEFENSIVE_MASTERMIND: GKP 2+6+2=10, DEF 8,11,6, MID 6,2,2,2, FWD 2+6+3=11 (x2), 2, 2
    assert.equal(totals.DEFENSIVE_MASTERMIND, 10 + 8 + 11 + 6 + 6 + 2 + 2 + 2 + 22 + 2 + 2);
  });

  it("persists one score per custom league member and skips default and invalid leagues", async () => {
    const upserts: any[] = [];
    let squadLoads = 0;
    const db: any = {
      league: {
        findMany: async () => [
          { id: "classic", scoringConfig: null, members: [{ squadId: "sq1" }] },
          { id: "attack", scoringConfig: SCORING_PRESETS.ALL_ATTACK, members: [{ squadId: "sq1" }, { squadId: "sq2" }] },
          { id: "defence", scoringConfig: SCORING_PRESETS.DEFENSIVE_MASTERMIND, members: [{ squadId: "sq1" }] },
          { id: "broken", scoringConfig: { goal: "lots" }, members: [{ squadId: "sq2" }] },
        ],
      },
      squad: {
        findUnique: async ({ where }: any) => {
          squadLoads++;
          return {
            id: where.id,
            players: LINEUP.map((p) => ({ ...p, player: { position: p.position } })),
          };
        },
      },
      playerGameweekStats: { findMany: async () => STATS },
      squadChipUsage: { findUnique: async () => null },
      squadGameweekScore: { findUnique: async () => ({ transferCost: 4 }) },
      leagueSquadGameweekScore: {
        upsert: async (args: any) => {
          upserts.push(args);
          return args.create;
        },
      },
    };

    const result = await new ScoringService(db).calculateCustomLeagueScores(7);
    assert.deepEqual(result, { leaguesScored: 2, scoresWritten: 3 });
    // sq1 is in two custom leagues but its lineup is loaded once
    assert.equal(squadLoads, 2);

    const byKey = new Map(upserts.map((u) => [`${u.create.leagueId}:${u.create.squadId}`, u.create.points]));
    assert.equal(byKey.has("classic:sq1"), false);
    assert.equal(byKey.has("broken:sq2"), false);
    // Transfer cost (-4) applies under custom rules as well
    assert.equal(byKey.get("attack:sq1"), 74 - 4);
    assert.equal(byKey.get("defence:sq1"), 73 - 4);
    assert.deepEqual(upserts[0].where, {
      leagueId_squadId_gameweekId: { leagueId: "attack", squadId: "sq1", gameweekId: 7 },
    });
  });

  it("benchmark: compiled custom scoring keeps pace with the default path", () => {
    const rows: PlayerFixtureStats[] = [];
    const positions = new Map<number, Position>();
    const order = [Position.GKP, Position.DEF, Position.MID, Position.FWD];
    for (let id = 1; id <= 700; id++) {
      positions.set(id, order[id % 4]);
      rows.push(fixtureRow(id, { minutes: 90, goals: id % 3, assists: id % 2, cleanSheet: id % 5 === 0, saves: id % 7, bonus: id % 4 }, 5));
    }
    const leagues = Object.values(SCORING_PRESETS).map((c) => compileScoringRules(c));

    const time = (fn: () => void) => {
      for (let i = 0; i < 20; i++) fn();
      const start = performance.now();
      for (let i = 0; i < 200; i++) fn();
      return (performance.now() - start) / 200;
    };
    const defaultMs = time(() => ScoringService.buildStatsMap(rows));
    const customMs = time(() => {
      for (const rules of leagues) ScoringService.buildStatsMap(rows, positions, rules);
    });

    // 700 players under three rule sets in well under a millisecond-scale budget
    assert.ok(customMs < 10, `custom scoring took ${customMs.toFixed(3)}ms for 2,100 player evaluations`);
    assert.ok(defaultMs < 5, `default path took ${defaultMs.toFixed(3)}ms`);
  });
});

// ---------------------------------------------------------------------------
// League service: configuration lifecycle and standings
// ---------------------------------------------------------------------------

function leagueDb(league: Record<string, unknown> | null) {
  const updates: any[] = [];
  const db: any = {
    league: {
      findUnique: async () => league,
      update: async (args: any) => {
        updates.push(args);
        return { ...league, ...args.data };
      },
    },
  };
  return { db, updates };
}

describe("LeagueService scoring configuration (#272)", () => {
  const upcomingPrivate = { id: "L1", creatorId: "creator", status: LeagueStatus.UPCOMING, isPrivate: true };

  it("creator can apply a preset with overrides to a private upcoming league", async () => {
    const { db, updates } = leagueDb(upcomingPrivate);
    const result = await new LeagueService(db).updateScoringConfig("L1", "creator", {
      preset: "DEFENSIVE_MASTERMIND",
      rules: { penaltySave: 10 },
    });
    assert.equal(result.isCustom, true);
    assert.equal(result.config.penaltySave, 10);
    assert.equal((updates[0].data.scoringConfig as LeagueScoringConfig).penaltySave, 10);
  });

  it("invalid rules are rejected at configuration time with a validation error", async () => {
    const { db, updates } = leagueDb(upcomingPrivate);
    await assert.rejects(
      () => new LeagueService(db).updateScoringConfig("L1", "creator", { rules: { goal: { FWD: -5 } } }),
      LeagueValidationError
    );
    assert.equal(updates.length, 0);
  });

  it("only the creator may change rules", async () => {
    const { db } = leagueDb(upcomingPrivate);
    await assert.rejects(
      () => new LeagueService(db).updateScoringConfig("L1", "intruder", { preset: "ALL_ATTACK" }),
      LeagueForbiddenError
    );
  });

  it("rules are locked once the league has started", async () => {
    const { db } = leagueDb({ ...upcomingPrivate, status: LeagueStatus.ACTIVE });
    await assert.rejects(
      () => new LeagueService(db).updateScoringConfig("L1", "creator", { preset: "ALL_ATTACK" }),
      /locked/
    );
  });

  it("public leagues keep official scoring", async () => {
    const { db } = leagueDb({ ...upcomingPrivate, isPrivate: false });
    await assert.rejects(
      () => new LeagueService(db).updateScoringConfig("L1", "creator", { preset: "ALL_ATTACK" }),
      /private leagues/
    );
  });

  it("resetting clears the column back to official scoring", async () => {
    const { db, updates } = leagueDb(upcomingPrivate);
    const result = await new LeagueService(db).updateScoringConfig("L1", "creator", null);
    assert.equal(result.isCustom, false);
    assert.equal(updates[0].data.scoringConfig, Prisma.DbNull);
  });

  it("reports official FPL rules for leagues without a custom config", async () => {
    const { db } = leagueDb({ id: "L1", scoringConfig: null });
    const result = await new LeagueService(db).getScoringConfig("L1");
    assert.equal(result.isCustom, false);
    assert.deepEqual(result.config, SCORING_PRESETS.CLASSIC_FPL);
  });

  it("lists presets with descriptions", () => {
    const presets = LeagueService.listScoringPresets();
    assert.deepEqual(presets.map((p) => p.name), ["CLASSIC_FPL", "ALL_ATTACK", "DEFENSIVE_MASTERMIND"]);
    assert.ok(presets.every((p) => p.description.length > 0));
  });

  it("standings rank custom leagues on their own scores and classic leagues on official scores", async () => {
    const joined = new Date("2026-01-01T00:00:00Z");
    const member = (id: string, leagueId: string, squadId: string, scoringConfig: unknown) => ({
      id,
      leagueId,
      squadId,
      joinedAt: joined,
      league: { scoringConfig },
    });
    let rawValues: any[] = [];
    const db: any = {
      squadGameweekScore: {
        groupBy: async () => [
          { squadId: "sqA", _sum: { points: 100 } },
          { squadId: "sqB", _sum: { points: 80 } },
        ],
      },
      leagueSquadGameweekScore: {
        groupBy: async ({ where }: any) => {
          assert.deepEqual(where.leagueId, { in: ["custom"] });
          return [
            { leagueId: "custom", squadId: "sqA", _sum: { points: 50 } },
            { leagueId: "custom", squadId: "sqB", _sum: { points: 90 } },
          ];
        },
      },
      leagueMember: {
        findMany: async () => [
          member("c1", "classic", "sqA", null),
          member("c2", "classic", "sqB", null),
          member("x1", "custom", "sqA", SCORING_PRESETS.ALL_ATTACK),
          member("x2", "custom", "sqB", SCORING_PRESETS.ALL_ATTACK),
        ],
      },
      $executeRaw: async (_s: TemplateStringsArray, ...values: any[]) => {
        rawValues = values;
        return values[0].length;
      },
    };

    await new LeagueService(db).recalculateClassicStandings(10);
    const [ids, points, ranks] = rawValues;
    const row = (id: string) => ({ points: points[ids.indexOf(id)], rank: ranks[ids.indexOf(id)] });
    assert.deepEqual(row("c1"), { points: 100, rank: 1 });
    assert.deepEqual(row("c2"), { points: 80, rank: 2 });
    // Same squads, reversed order under the league's custom rules
    assert.deepEqual(row("x2"), { points: 90, rank: 1 });
    assert.deepEqual(row("x1"), { points: 50, rank: 2 });
  });

  it("H2H settlement reads per-league scores when the league has custom rules", async () => {
    const reads: string[] = [];
    const db: any = {
      leagueFixture: { findMany: async () => [] },
    };
    // No unfinished fixtures: returns early without reading scores in either mode
    assert.deepEqual(await new LeagueService(db).settleH2HGameweek("L1", 3, { customScoring: true }), { settled: 0 });

    db.leagueFixture.findMany = async () => [
      { id: "f1", homeMemberId: "m1", awayMemberId: "m2", isPlayoff: false },
    ];
    db.leagueMember = {
      findMany: async () => [
        { id: "m1", squadId: "sq1" },
        { id: "m2", squadId: "sq2" },
      ],
      update: async () => ({}),
    };
    db.leagueSquadGameweekScore = {
      findMany: async () => {
        reads.push("league");
        return [
          { squadId: "sq1", points: 40 },
          { squadId: "sq2", points: 55 },
        ];
      },
    };
    db.squadGameweekScore = {
      findMany: async () => {
        reads.push("official");
        return [];
      },
    };
    db.$transaction = async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(db));
    db.leagueFixture.update = async () => ({});

    await new LeagueService(db).settleH2HGameweek("L1", 3, { customScoring: true }).catch(() => undefined);
    assert.deepEqual(reads, ["league"]);
  });

  it("createLeague rejects custom rules on a public league", async () => {
    await assert.rejects(
      () =>
        new LeagueService({} as any).createLeague("u1", {
          name: "Public",
          entryFee: 0,
          startGameweekId: 1,
          endGameweekId: 2,
          squadId: "sq1",
          scoringType: ScoringType.CLASSIC,
          scoringConfig: { preset: "ALL_ATTACK" },
        }),
      /private leagues/
    );
  });

  it("createLeague rejects invalid custom rules before touching the database", async () => {
    await assert.rejects(
      () =>
        new LeagueService({} as any).createLeague("u1", {
          name: "Private",
          entryFee: 0,
          startGameweekId: 1,
          endGameweekId: 2,
          squadId: "sq1",
          isPrivate: true,
          scoringConfig: { rules: { redCard: 5 } },
        }),
      LeagueValidationError
    );
  });
});
