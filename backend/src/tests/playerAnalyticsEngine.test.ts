import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYTICS_CONFIG,
  computeExpectedPoints,
  computeFixtureDifficulty,
  computeMinutesProbability,
  computeSeasonBaseline,
  computeWeightedForm,
  fdrFromStrengthGap,
  MatchRecord,
  PlayerAnalyticsEngine,
  PlayerNotFoundError,
  TeamStrengths,
} from "../services/analytics/playerAnalyticsEngine.js";

// Benchmark team strengths shaped like FPL bootstrap-static data.
const ELITE: TeamStrengths = {
  id: 1, shortName: "ELT",
  strengthOverallHome: 1340, strengthOverallAway: 1350,
  strengthAttackHome: 1350, strengthAttackAway: 1360,
  strengthDefenceHome: 1330, strengthDefenceAway: 1340,
};
const STRONG: TeamStrengths = {
  id: 2, shortName: "STR",
  strengthOverallHome: 1290, strengthOverallAway: 1310,
  strengthAttackHome: 1280, strengthAttackAway: 1300,
  strengthDefenceHome: 1300, strengthDefenceAway: 1320,
};
const MID: TeamStrengths = {
  id: 3, shortName: "MID",
  strengthOverallHome: 1150, strengthOverallAway: 1150,
  strengthAttackHome: 1150, strengthAttackAway: 1150,
  strengthDefenceHome: 1150, strengthDefenceAway: 1150,
};
const WEAK: TeamStrengths = {
  id: 4, shortName: "WEK",
  strengthOverallHome: 1040, strengthOverallAway: 1000,
  strengthAttackHome: 1050, strengthAttackAway: 1010,
  strengthDefenceHome: 1030, strengthDefenceAway: 1000,
};

const games = (points: number[], minutes = 90): MatchRecord[] =>
  points.map((totalPoints, i) => ({ gameweekId: 30 - i, minutes, totalPoints }));

// Elite forward: recent hauls plus a strong full-season record (~7.4 PPG).
const ELITE_FWD_HISTORY = [
  ...games([13, 2, 9, 16, 6]),
  ...games([8, 2, 13, 7, 5, 2, 9, 14, 6, 2, 8, 6, 12, 5, 7]),
];

describe("Fixture difficulty rating (#232)", () => {
  it("maps strength gaps onto the 1-5 scale", () => {
    assert.equal(fdrFromStrengthGap(-300), 1);
    assert.equal(fdrFromStrengthGap(-201), 1);
    assert.equal(fdrFromStrengthGap(-200), 2);
    assert.equal(fdrFromStrengthGap(-100), 2);
    assert.equal(fdrFromStrengthGap(0), 3);
    assert.equal(fdrFromStrengthGap(100), 4);
    assert.equal(fdrFromStrengthGap(175), 5);
    assert.equal(fdrFromStrengthGap(300), 5);
  });

  it("rates elite-at-home vs weak as easiest and weak-away vs elite as hardest", () => {
    const easy = computeFixtureDifficulty(ELITE, WEAK, true);
    assert.deepEqual(easy, { fdr: 1, attackFdr: 1, defenceFdr: 1 });
    const hard = computeFixtureDifficulty(WEAK, ELITE, false);
    assert.deepEqual(hard, { fdr: 5, attackFdr: 5, defenceFdr: 5 });
    assert.equal(computeFixtureDifficulty(MID, MID, true).fdr, 3);
  });

  it("increases monotonically with opponent strength", () => {
    const opponents = [WEAK, MID, STRONG, ELITE];
    const ratings = opponents.map((opp) => computeFixtureDifficulty(MID, opp, true).fdr);
    for (let i = 1; i < ratings.length; i++) assert.ok(ratings[i] >= ratings[i - 1], `${ratings}`);
    assert.equal(ratings[0], 2);
    assert.equal(ratings[3], 5);
  });

  it("uses venue-specific strengths", () => {
    const team: TeamStrengths = { id: 9, strengthOverallHome: 1250, strengthOverallAway: 1100 };
    const opp: TeamStrengths = { id: 10, strengthOverallHome: 1200, strengthOverallAway: 1200 };
    assert.equal(computeFixtureDifficulty(team, opp, true).fdr, 3); // -50 gap
    assert.equal(computeFixtureDifficulty(team, opp, false).fdr, 4); // +100 gap
  });

  it("falls back to the coarse FPL strength when detailed values are missing", () => {
    const strong = { id: 11, strength: 5 };
    const weak = { id: 12, strength: 2 };
    assert.equal(computeFixtureDifficulty(weak, strong, true).fdr, 5);
    assert.equal(computeFixtureDifficulty(strong, weak, true).fdr, 1);
    assert.equal(computeFixtureDifficulty({ id: 13 }, { id: 14 }, true).fdr, 3);
  });
});

describe("Form, baseline and minutes (#232)", () => {
  it("weights the last 5 appearances 5:4:3:2:1, most recent first", () => {
    assert.deepEqual(ANALYTICS_CONFIG.formWeights, [5, 4, 3, 2, 1]);
    // (10*5 + 0*4 + 0*3 + 0*2 + 0*1) / 15
    assert.equal(computeWeightedForm(games([10, 0, 0, 0, 0])), 10 / 3);
    assert.equal(computeWeightedForm(games([0, 0, 0, 0, 10])), 10 / 15);
    assert.equal(computeWeightedForm(games([6, 6, 6, 6, 6, 20, 20])), 6, "only 5 matches count");
  });

  it("skips matches the player did not feature in", () => {
    const history = [
      { gameweekId: 10, minutes: 0, totalPoints: 0 },
      ...games([8, 4]),
    ];
    assert.equal(computeWeightedForm(history), (8 * 5 + 4 * 4) / 9);
    assert.equal(computeWeightedForm([{ gameweekId: 1, minutes: 0, totalPoints: 0 }]), null);
  });

  it("shrinks small samples towards the position prior", () => {
    assert.equal(computeSeasonBaseline([], "FORWARD"), ANALYTICS_CONFIG.positionPrior.FORWARD);
    const one = computeSeasonBaseline(games([15]), "FORWARD");
    assert.ok(one > 4 && one < 6, `one big haul should not dominate (${one})`);
    const many = computeSeasonBaseline(games(Array(30).fill(7)), "FORWARD");
    assert.ok(many > 6.2 && many < 7, `${many}`);
  });

  it("derives minutes probability from availability and recent minutes", () => {
    assert.deepEqual(computeMinutesProbability({ recentFirst: games([5, 5, 5, 5, 5]) }), { pPlay: 1, p60: 1 });
    assert.deepEqual(
      computeMinutesProbability({ recentFirst: games([5, 5, 5, 5, 5]), chanceOfPlaying: 75 }),
      { pPlay: 0.75, p60: 1 }
    );
    assert.equal(
      computeMinutesProbability({ recentFirst: games([5]), status: "i", chanceOfPlaying: 0 }).pPlay,
      0
    );
    const rotation = computeMinutesProbability({
      recentFirst: [
        { gameweekId: 5, minutes: 90, totalPoints: 2 },
        { gameweekId: 4, minutes: 0, totalPoints: 0 },
        { gameweekId: 3, minutes: 25, totalPoints: 1 },
        { gameweekId: 2, minutes: 0, totalPoints: 0 },
      ],
    });
    assert.deepEqual(rotation, { pPlay: 0.5, p60: 0.5 });
  });
});

function xpFor(
  history: MatchRecord[],
  position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD",
  team: TeamStrengths,
  opponent: TeamStrengths,
  isHome: boolean,
  extra: { chanceOfPlaying?: number | null; status?: string } = {}
) {
  return computeExpectedPoints({
    position,
    form: computeWeightedForm(history),
    seasonBaseline: computeSeasonBaseline(history, position),
    minutes: computeMinutesProbability({ recentFirst: history, ...extra }),
    difficulty: computeFixtureDifficulty(team, opponent, isHome),
    isHome,
  });
}

describe("Expected points benchmarks (#232)", () => {
  it("puts an elite forward with an easy home fixture at 6.5-8.5 xP", () => {
    const { xP } = xpFor(ELITE_FWD_HISTORY, "FORWARD", ELITE, WEAK, true);
    assert.ok(xP >= 6.5 && xP <= 8.5, `xP was ${xP}`);
  });

  it("lowers xP as the opponent gets harder", () => {
    const easy = xpFor(ELITE_FWD_HISTORY, "FORWARD", ELITE, WEAK, true).xP;
    const medium = xpFor(ELITE_FWD_HISTORY, "FORWARD", ELITE, MID, true).xP;
    const hard = xpFor(ELITE_FWD_HISTORY, "FORWARD", ELITE, STRONG, false).xP;
    assert.ok(easy > medium && medium > hard, `${easy} > ${medium} > ${hard}`);
    assert.ok(hard > 4.5, `an elite player is still a strong pick away at a top side (${hard})`);
  });

  it("gives home fixtures a small edge over the same fixture away", () => {
    const home = xpFor(ELITE_FWD_HISTORY, "FORWARD", MID, MID, true).xP;
    const away = xpFor(ELITE_FWD_HISTORY, "FORWARD", MID, MID, false).xP;
    assert.ok(home > away);
    assert.ok(home - away < 0.6);
  });

  it("puts an average defender in a realistic 2.5-5 band", () => {
    const history = games([2, 6, 1, 2, 7, 2, 1, 6, 2, 3]);
    const easy = xpFor(history, "DEFENDER", MID, WEAK, true).xP;
    const hard = xpFor(history, "DEFENDER", MID, ELITE, false).xP;
    for (const x of [easy, hard]) assert.ok(x >= 2.5 && x <= 5, `${x}`);
    assert.ok(easy > hard);
  });

  it("weights defenders by defensive difficulty and forwards by attacking difficulty", () => {
    // Opponent with a leaky defence but a dangerous attack.
    const leaky: TeamStrengths = {
      id: 20, strengthOverallHome: 1150, strengthOverallAway: 1150,
      strengthAttackAway: 1350, strengthDefenceAway: 1000,
    };
    const fwd = computeExpectedPoints({
      position: "FORWARD", form: 6, seasonBaseline: 6, minutes: { pPlay: 1, p60: 1 },
      difficulty: computeFixtureDifficulty(MID, leaky, true), isHome: true,
    });
    const def = computeExpectedPoints({
      position: "DEFENDER", form: 6, seasonBaseline: 6, minutes: { pPlay: 1, p60: 1 },
      difficulty: computeFixtureDifficulty(MID, leaky, true), isHome: true,
    });
    assert.ok(fwd.difficultyMultiplier > 1, "forwards benefit from a weak defence");
    assert.ok(def.difficultyMultiplier < 1, "defenders suffer against a strong attack");
  });

  it("scores benched and injured players near zero", () => {
    const benchWarmer = xpFor(
      [...games([1, 1], 15), ...games([0, 0, 0], 0)],
      "MIDFIELDER", MID, WEAK, true
    ).xP;
    assert.ok(benchWarmer < 1.5, `${benchWarmer}`);
    const injured = xpFor(ELITE_FWD_HISTORY, "FORWARD", ELITE, WEAK, true, { status: "i", chanceOfPlaying: 0 }).xP;
    assert.equal(injured, 0);
  });

  it("stays within FPL-plausible bounds for extreme inputs", () => {
    for (const fdr of [1, 2, 3, 4, 5] as const) {
      const r = computeExpectedPoints({
        position: "FORWARD", form: 20, seasonBaseline: 12, minutes: { pPlay: 1, p60: 1 },
        difficulty: { fdr, attackFdr: fdr, defenceFdr: fdr }, isHome: true,
      });
      assert.ok(r.xP >= 0 && r.xP <= 20, `${r.xP}`);
      const zero = computeExpectedPoints({
        position: "GOALKEEPER", form: 0, seasonBaseline: 0, minutes: { pPlay: 1, p60: 1 },
        difficulty: { fdr, attackFdr: fdr, defenceFdr: fdr }, isHome: false,
      });
      assert.ok(zero.xP >= 0 && zero.xP <= 2, `${zero.xP}`);
    }
  });
});

// Minimal Prisma-like fake for the engine.
function fakeDb(overrides: { fixtures?: any[]; history?: MatchRecord[]; player?: any } = {}) {
  const calls = { player: 0 };
  const player = overrides.player === undefined
    ? {
        id: 7, displayName: "Striker", position: "FORWARD", teamId: ELITE.id,
        chanceOfPlayingNextRound: null, status: "a", team: ELITE,
      }
    : overrides.player;
  return {
    calls,
    player: { findUnique: async () => { calls.player++; return player; } },
    playerGameweekStats: { findMany: async () => overrides.history ?? ELITE_FWD_HISTORY },
    gameweek: { findMany: async () => [{ id: 31 }, { id: 32 }, { id: 33 }] },
    fixture: {
      findMany: async () => overrides.fixtures ?? [
        { id: 100, gameweekId: 31, homeTeamId: ELITE.id, awayTeamId: WEAK.id, homeTeam: ELITE, awayTeam: WEAK, kickoffTime: null },
        { id: 101, gameweekId: 32, homeTeamId: STRONG.id, awayTeamId: ELITE.id, homeTeam: STRONG, awayTeam: ELITE, kickoffTime: null },
        { id: 102, gameweekId: 32, homeTeamId: ELITE.id, awayTeamId: MID.id, homeTeam: ELITE, awayTeam: MID, kickoffTime: null },
      ],
    },
  };
}

function fakeRedis() {
  const store = new Map<string, string>();
  const sets: unknown[][] = [];
  return {
    store,
    sets,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => { store.set(k, v); sets.push([k, ...args]); return "OK"; },
    del: async (...keys: string[]) => keys.filter((k) => store.delete(k)).length,
    keys: async (pattern: string) => [...store.keys()].filter((k) => k.startsWith(pattern.replace("*", ""))),
  };
}

describe("PlayerAnalyticsEngine service (#232)", () => {
  it("returns per-gameweek xP including blank and double gameweeks", async () => {
    const engine = new PlayerAnalyticsEngine({ db: fakeDb(), cache: null });
    const result = await engine.getPlayerAnalytics(7, 3);
    assert.deepEqual(result.gameweeks.map((g) => g.fixtures.length), [1, 2, 0]);
    assert.equal(result.gameweeks[2].xP, 0, "blank gameweek");
    assert.ok(result.gameweeks[1].xP > result.gameweeks[0].xP, "double gameweek beats a single");
    assert.equal(result.gameweeks[0].fixtures[0].fdr, 1);
    assert.equal(result.gameweeks[1].fixtures[0].isHome, false);
    assert.equal(
      result.totalXP,
      Math.round(result.gameweeks.reduce((s, g) => s + g.xP, 0) * 100) / 100
    );
  });

  it("caches results in Redis with a TTL and serves repeat calls from cache", async () => {
    const db = fakeDb();
    const redis = fakeRedis();
    const engine = new PlayerAnalyticsEngine({ db, cache: redis as any, cacheTtlSeconds: 600 });
    const first = await engine.getPlayerAnalytics(7, 3);
    const second = await engine.getPlayerAnalytics(7, 3);
    assert.deepEqual(second, first);
    assert.equal(db.calls.player, 1);
    assert.deepEqual(redis.sets[0], [PlayerAnalyticsEngine.cacheKey(7, 3), "EX", 600]);

    await engine.invalidate(7);
    await engine.getPlayerAnalytics(7, 3);
    assert.equal(db.calls.player, 2);
  });

  it("keeps working when Redis fails", async () => {
    const broken = {
      get: async () => { throw new Error("down"); },
      set: async () => { throw new Error("down"); },
      del: async () => 0,
      keys: async () => [],
    };
    const engine = new PlayerAnalyticsEngine({ db: fakeDb(), cache: broken as any });
    const result = await engine.getPlayerAnalytics(7, 3);
    assert.equal(result.playerId, 7);
  });

  it("throws PlayerNotFoundError for unknown players", async () => {
    const engine = new PlayerAnalyticsEngine({ db: fakeDb({ player: null }), cache: null });
    await assert.rejects(() => engine.getPlayerAnalytics(999), PlayerNotFoundError);
  });
});
