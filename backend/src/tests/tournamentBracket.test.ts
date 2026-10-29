import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateKnockoutFirstRound,
  generateRoundRobin,
  knockoutBracketSize,
  knockoutRoundName,
  nextRoundPairings,
  resolveKnockoutMatch,
  standardSeedOrder,
  TieBreakStats,
  TournamentBracketService,
  TournamentValidationError,
  validateRoundRobin,
  virtualCoinToss,
} from "../services/league/tournamentService.js";

const managers = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}`);

describe("Round-robin generation (#231)", () => {
  for (const n of [2, 3, 4, 7, 8, 10, 20]) {
    it(`gives ${n} managers a balanced schedule with no duplicate match-ups per round`, () => {
      const ids = managers(n);
      const rounds = generateRoundRobin(ids);
      assert.equal(rounds.length, n % 2 === 0 ? n - 1 : n);
      assert.deepEqual(validateRoundRobin(ids, rounds), []);
      const games = new Map(ids.map((id) => [id, 0]));
      for (const round of rounds) {
        for (const m of round) {
          if (m.away === null) continue;
          games.set(m.home, games.get(m.home)! + 1);
          games.set(m.away, games.get(m.away)! + 1);
        }
      }
      assert.ok([...games.values()].every((g) => g === n - 1), "everyone plays everyone once");
    });
  }

  it("gives each manager at most one bye with an odd field", () => {
    const rounds = generateRoundRobin(managers(5));
    const byes = rounds.flatMap((r) => r.filter((m) => m.away === null).map((m) => m.home));
    assert.equal(byes.length, 5);
    assert.equal(new Set(byes).size, 5);
  });

  it("reverses home and away in the second leg and balances home games", () => {
    const ids = managers(6);
    const rounds = generateRoundRobin(ids, 2);
    assert.equal(rounds.length, 10);
    assert.deepEqual(validateRoundRobin(ids, rounds, 2), []);
    for (let r = 0; r < 5; r++) {
      rounds[r].forEach((m, i) => {
        assert.equal(rounds[r + 5][i].home, m.away);
        assert.equal(rounds[r + 5][i].away, m.home);
      });
    }
    const homeGames = new Map(ids.map((id) => [id, 0]));
    rounds.flat().forEach((m) => homeGames.set(m.home, homeGames.get(m.home)! + 1));
    assert.ok([...homeGames.values()].every((h) => h === 5));
  });

  it("detects broken schedules", () => {
    const problems = validateRoundRobin(["a", "b", "c"], [[{ home: "a", away: "b" }, { home: "a", away: "c" }]]);
    assert.ok(problems.some((p) => p.includes("plays twice")));
    assert.ok(problems.some((p) => p.includes("b|c meet 0 times")));
  });

  it("rejects duplicate participants", () => {
    assert.throws(() => generateRoundRobin(["a", "a"]), TournamentValidationError);
  });
});

describe("Knockout bracket generation (#231)", () => {
  it("uses the standard seed order so the top seeds are kept apart", () => {
    assert.deepEqual(standardSeedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    const order16 = standardSeedOrder(16);
    assert.deepEqual(order16.slice(0, 4), [1, 16, 8, 9]);
    // Seed 1 is in the top half, seed 2 in the bottom half: they can only meet in the final.
    assert.ok(order16.indexOf(1) < 8 && order16.indexOf(2) >= 8);
  });

  for (const size of [8, 16, 32, 64]) {
    it(`builds a seeded ${size}-team bracket`, () => {
      const pairings = generateKnockoutFirstRound(managers(size));
      assert.equal(pairings.length, size / 2);
      for (const p of pairings) {
        assert.equal(p.homeSeed + (p.awaySeed ?? 0), size + 1, "seed s plays seed n+1-s");
        assert.ok(p.homeSeed < p.awaySeed!, "the better seed is at home");
      }
      const everyone = pairings.flatMap((p) => [p.home, p.away]);
      assert.equal(new Set(everyone).size, size);
    });
  }

  it("gives byes to the top seeds when the field is not a power of two", () => {
    const pairings = generateKnockoutFirstRound(managers(13));
    assert.equal(knockoutBracketSize(13), 16);
    const byes = pairings.filter((p) => p.away === null).map((p) => p.homeSeed).sort((a, b) => a - b);
    assert.deepEqual(byes, [1, 2, 3]);
  });

  it("rejects brackets that are too small or too large", () => {
    assert.throws(() => generateKnockoutFirstRound(["solo"]), TournamentValidationError);
    assert.throws(() => generateKnockoutFirstRound(managers(65)), TournamentValidationError);
  });

  it("names rounds from the final backwards", () => {
    assert.deepEqual([1, 2, 3, 4].map((r) => knockoutRoundName(r, 4)), [
      "Round of 16", "Quarter-final", "Semi-final", "Final",
    ]);
  });

  it("pairs winners of adjacent slots in the next round", () => {
    assert.deepEqual(nextRoundPairings(["a", "b", "c", "d"]), [
      { slot: 0, home: "a", away: "b" },
      { slot: 1, home: "c", away: "d" },
    ]);
    assert.throws(() => nextRoundPairings(["a", "b", "c"]), TournamentValidationError);
  });
});

describe("FPL tie-break rules (#231)", () => {
  const base = { home: "h", away: "a", coinTossSeed: "L:30" };

  it("uses the gameweek score first", () => {
    assert.deepEqual(resolveKnockoutMatch({ ...base, homeScore: 60, awayScore: 61 }), {
      winner: "a", loser: "h", reason: "score",
    });
  });

  it("breaks a level score on goals scored", () => {
    const r = resolveKnockoutMatch({
      ...base, homeScore: 50, awayScore: 50,
      homeStats: { goalsScored: 2, goalsConceded: 0 },
      awayStats: { goalsScored: 3, goalsConceded: 5 },
    });
    assert.deepEqual(r, { winner: "a", loser: "h", reason: "goals_scored" });
  });

  it("then on fewest goals conceded", () => {
    const r = resolveKnockoutMatch({
      ...base, homeScore: 50, awayScore: 50,
      homeStats: { goalsScored: 2, goalsConceded: 1 },
      awayStats: { goalsScored: 2, goalsConceded: 4 },
    });
    assert.deepEqual(r, { winner: "h", loser: "a", reason: "goals_conceded" });
  });

  it("then on a deterministic virtual coin toss", () => {
    const stats = { goalsScored: 1, goalsConceded: 1 };
    const r1 = resolveKnockoutMatch({ ...base, homeScore: 40, awayScore: 40, homeStats: stats, awayStats: stats });
    const swapped = resolveKnockoutMatch({
      home: "a", away: "h", coinTossSeed: "L:30", homeScore: 40, awayScore: 40, homeStats: stats, awayStats: stats,
    });
    assert.equal(r1.reason, "coin_toss");
    assert.equal(r1.winner, swapped.winner, "independent of home/away order");
    assert.equal(virtualCoinToss("L:30", "h", "a"), r1.winner);

    const winners = new Set(
      Array.from({ length: 64 }, (_, i) => virtualCoinToss(`L:${i}`, "x", "y"))
    );
    assert.equal(winners.size, 2, "both sides can win the toss");
  });

  it("advances the home manager on a bye", () => {
    assert.deepEqual(resolveKnockoutMatch({ ...base, away: null, homeScore: 0, awayScore: 0 }), {
      winner: "h", loser: null, reason: "bye",
    });
  });
});

/** In-memory stand-in for the Prisma calls TournamentBracketService makes. */
function createDb(memberCount: number, league = { id: "L", startGameweekId: 1, endGameweekId: 38 }) {
  const members = managers(memberCount).map((id, i) => ({ id, squadId: `s_${id}`, h2hPoints: 100 - i }));
  const fixtures: any[] = [];
  const scores = new Map<string, number>(); // `${squadId}:${gw}` -> points
  const match = (f: any, where: any) =>
    Object.entries(where).every(([k, v]) => (k === "id" && typeof v === "object" ? (v as any).in.includes(f[k]) : f[k] === v));
  const db: any = {
    fixtures,
    scores,
    league: { findUnique: async () => league },
    leagueMember: {
      findMany: async ({ where }: any) =>
        where.id ? members.filter((m) => where.id.in.includes(m.id)) : members,
    },
    leagueFixture: {
      createMany: async ({ data }: any) => {
        for (const d of data) {
          if (fixtures.some((f) => f.leagueId === d.leagueId && f.gameweekId === d.gameweekId && f.homeMemberId === d.homeMemberId && f.isCup === d.isCup)) {
            throw new Error("unique constraint");
          }
          fixtures.push({ id: `f${fixtures.length}`, isFinished: false, homeScore: null, awayScore: null, winnerMemberId: null, ...d });
        }
        return { count: data.length };
      },
      findMany: async ({ where }: any) => fixtures.filter((f) => match(f, where)),
      count: async ({ where }: any) => fixtures.filter((f) => match(f, where)).length,
      update: async ({ where, data }: any) => Object.assign(fixtures.find((f) => f.id === where.id), data),
    },
    squadGameweekScore: {
      findMany: async ({ where }: any) =>
        where.squadId.in.map((squadId: string) => ({ squadId, points: scores.get(`${squadId}:${where.gameweekId}`) ?? 0 })),
    },
    $transaction: async (fn: any) => fn(db),
  };
  return db;
}

/** Sets this gameweek's scores so the better seed (lower number) always wins. */
function scoreRound(db: any, gameweekId: number, override: Record<string, number> = {}) {
  for (const f of db.fixtures.filter((x: any) => x.gameweekId === gameweekId && x.isCup)) {
    for (const id of [f.homeMemberId, f.awayMemberId].filter(Boolean)) {
      db.scores.set(`s_${id}:${gameweekId}`, override[id] ?? 200 - Number(id.slice(1)));
    }
  }
}

describe("Knockout progression with TournamentBracketService (#231)", () => {
  it("runs a 16-team cup from the round of 16 to the final", async () => {
    const db = createDb(16);
    const service = new TournamentBracketService(db, async () => new Map());
    const created = await service.createKnockoutCup("L", { startGameweekId: 30 });
    assert.equal(created.bracketSize, 16);
    assert.equal(created.rounds, 4);
    assert.equal(created.finalGameweekId, 33);

    const names: string[] = [];
    let champion: string | undefined;
    for (let gw = 30; gw <= 33; gw++) {
      scoreRound(db, gw);
      const bracket = await service.getKnockoutBracket("L");
      names.push((bracket.rounds as any[]).at(-1).name);
      const result = await service.settleKnockoutGameweek("L", gw);
      assert.equal(result.settled, 16 / 2 ** (gw - 29));
      if (gw < 33) {
        assert.equal(result.nextRound!.gameweekId, gw + 1);
        assert.equal(result.nextRound!.round, gw - 28);
      }
      champion = result.champion ?? champion;
    }

    assert.deepEqual(names, ["Round of 16", "Quarter-final", "Semi-final", "Final"]);
    assert.equal(champion, "m1");
    const final = db.fixtures.find((f: any) => f.playoffRound === 4);
    assert.deepEqual([final.homeMemberId, final.awayMemberId], ["m1", "m2"], "top two seeds meet in the final");
    const qf = db.fixtures.filter((f: any) => f.playoffRound === 2).map((f: any) => [f.homeMemberId, f.awayMemberId]);
    assert.deepEqual(qf, [["m1", "m8"], ["m4", "m5"], ["m2", "m7"], ["m3", "m6"]]);
    assert.equal((await service.getKnockoutBracket("L")).champion, "m1");
  });

  it("advances upset winners into the correct bracket slot", async () => {
    const db = createDb(8);
    const service = new TournamentBracketService(db, async () => new Map());
    await service.createKnockoutCup("L", { startGameweekId: 10 });
    scoreRound(db, 10, { m8: 500 }); // seed 8 knocks out seed 1
    const result = await service.settleKnockoutGameweek("L", 10);
    assert.deepEqual(result.nextRound!.pairings[0], { slot: 0, home: "m8", away: "m4" });
  });

  it("resolves level scores with goals scored, goals conceded, then the coin toss", async () => {
    const db = createDb(4);
    const stats = new Map<string, TieBreakStats>([
      ["s_m1", { goalsScored: 1, goalsConceded: 2 }],
      ["s_m4", { goalsScored: 3, goalsConceded: 0 }],
      ["s_m2", { goalsScored: 2, goalsConceded: 3 }],
      ["s_m3", { goalsScored: 2, goalsConceded: 1 }],
    ]);
    const service = new TournamentBracketService(db, async () => stats);
    await service.createKnockoutCup("L", { startGameweekId: 5 });
    scoreRound(db, 5, { m1: 50, m4: 50, m2: 60, m3: 60 });
    const result = await service.settleKnockoutGameweek("L", 5);

    const [sf1, sf2] = db.fixtures.filter((f: any) => f.playoffRound === 1).sort((a: any, b: any) => a.playoffSlot - b.playoffSlot);
    assert.equal(sf1.winnerMemberId, "m4");
    assert.equal(sf1.tiebreakReason, "goals_scored");
    assert.equal(sf2.winnerMemberId, "m3");
    assert.equal(sf2.tiebreakReason, "goals_conceded");
    assert.deepEqual(result.nextRound!.pairings, [{ slot: 0, home: "m4", away: "m3" }]);

    scoreRound(db, 6, { m4: 70, m3: 70 });
    stats.set("s_m4", { goalsScored: 1, goalsConceded: 1 });
    stats.set("s_m3", { goalsScored: 1, goalsConceded: 1 });
    const final = await service.settleKnockoutGameweek("L", 6);
    assert.equal(final.champion, virtualCoinToss("L:6", "m4", "m3"));
    assert.equal(db.fixtures.find((f: any) => f.playoffRound === 2).tiebreakReason, "coin_toss");
  });

  it("passes byes straight through to the next round", async () => {
    const db = createDb(6);
    const service = new TournamentBracketService(db, async () => new Map());
    const created = await service.createKnockoutCup("L", { startGameweekId: 20 });
    assert.equal(created.bracketSize, 8);
    scoreRound(db, 20);
    const result = await service.settleKnockoutGameweek("L", 20);
    const byeFixtures = db.fixtures.filter((f: any) => f.tiebreakReason === "bye");
    assert.deepEqual(byeFixtures.map((f: any) => f.homeMemberId).sort(), ["m1", "m2"]);
    assert.deepEqual(result.nextRound!.pairings.map((p) => [p.home, p.away]), [["m1", "m4"], ["m2", "m3"]]);
  });

  it("is idempotent: settling the same gameweek twice changes nothing", async () => {
    const db = createDb(4);
    const service = new TournamentBracketService(db, async () => new Map());
    await service.createKnockoutCup("L", { startGameweekId: 5 });
    scoreRound(db, 5);
    await service.settleKnockoutGameweek("L", 5);
    const before = db.fixtures.length;
    assert.deepEqual(await service.settleKnockoutGameweek("L", 5), { settled: 0 });
    assert.equal(db.fixtures.length, before);
  });

  it("does nothing for leagues without a cup", async () => {
    const service = new TournamentBracketService(createDb(4), async () => new Map());
    assert.deepEqual(await service.settleKnockoutGameweek("L", 1), { settled: 0 });
  });

  it("refuses a cup that would run past the league's last gameweek", async () => {
    const service = new TournamentBracketService(createDb(16), async () => new Map());
    await assert.rejects(
      () => service.createKnockoutCup("L", { startGameweekId: 36 }),
      /does not fit/
    );
  });

  it("refuses unknown members in a custom seeding and a second cup", async () => {
    const db = createDb(8);
    const service = new TournamentBracketService(db, async () => new Map());
    await assert.rejects(
      () => service.createKnockoutCup("L", { startGameweekId: 5, seededMemberIds: ["m1", "ghost"] }),
      /ghost/
    );
    await service.createKnockoutCup("L", { startGameweekId: 5, seededMemberIds: ["m8", "m7", "m6", "m5"] });
    assert.equal(db.fixtures[0].homeMemberId, "m8", "custom seeding is respected");
    await assert.rejects(() => service.createKnockoutCup("L", { startGameweekId: 5 }), /already has/);
  });
});
