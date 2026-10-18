import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SwissMatchRecord,
  computeSwissStandings,
  generateSwissPairings,
  pairKey,
  recommendedSwissRounds,
  resolveSwissResult,
} from "../services/league/swissPairingEngine.js";
import {
  SwissTournamentError,
  SwissTournamentPairingService,
} from "../services/league/swissTournamentService.js";
import { createInMemoryPrisma } from "./helpers/inMemoryPrisma.js";

/** Deterministic PRNG so simulations are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `m${String(i + 1).padStart(2, "0")}`);
}

/** Plays a whole tournament through the engine, asserting pairing rules every round. */
function simulate(playerCount: number, rounds: number, seed: number) {
  const players = ids(playerCount);
  const random = rng(seed);
  const matches: SwissMatchRecord[] = [];
  let rematches = 0;

  for (let round = 1; round <= rounds; round++) {
    const standings = computeSwissStandings(players, matches);
    const plan = generateSwissPairings(standings, matches);

    const seated = plan.pairings.flatMap((p) => [p.playerAId, p.playerBId]).filter(Boolean);
    assert.deepEqual([...seated].sort(), [...players].sort(), `round ${round}: everyone plays exactly once`);
    assert.equal(plan.pairings.filter((p) => p.playerBId === null).length, playerCount % 2, "one bye only for odd fields");

    for (const pairing of plan.pairings) {
      if (pairing.isRematch) rematches++;
      if (pairing.playerBId === null) {
        matches.push({ round, playerAId: pairing.playerAId, playerBId: null, scoreA: 40, scoreB: null, result: "BYE" });
        continue;
      }
      const scoreA = Math.floor(random() * 60) + 20;
      const scoreB = Math.floor(random() * 60) + 20;
      matches.push({ round, playerAId: pairing.playerAId, playerBId: pairing.playerBId, scoreA, scoreB, result: resolveSwissResult(scoreA, scoreB) });
    }
  }
  return { players, matches, rematches, standings: computeSwissStandings(players, matches) };
}

describe("Swiss engine: standings and tie-breakers", () => {
  // Round 1: A beats B, C draws D. Round 2: A beats C, B beats D.
  const matches: SwissMatchRecord[] = [
    { round: 1, playerAId: "A", playerBId: "B", scoreA: 60, scoreB: 40, result: "A_WIN" },
    { round: 1, playerAId: "C", playerBId: "D", scoreA: 50, scoreB: 50, result: "DRAW" },
    { round: 2, playerAId: "A", playerBId: "C", scoreA: 70, scoreB: 30, result: "A_WIN" },
    { round: 2, playerAId: "B", playerBId: "D", scoreA: 45, scoreB: 44, result: "A_WIN" },
  ];

  it("calculates match points, Buchholz and Sonneborn-Berger", () => {
    const table = new Map(computeSwissStandings(["A", "B", "C", "D"], matches).map((s) => [s.memberId, s]));
    // Match points: A 6, B 3, C 1, D 1
    assert.deepEqual(["A", "B", "C", "D"].map((id) => table.get(id)!.matchPoints), [6, 3, 1, 1]);
    // Buchholz = opponents' match points: A (B3 + C1) = 4, B (A6 + D1) = 7, C (D1 + A6) = 7, D (C1 + B3) = 4
    assert.deepEqual(["A", "B", "C", "D"].map((id) => table.get(id)!.buchholz), [4, 7, 7, 4]);
    // SB: A beat B(3) and C(1) = 4; B beat D(1) = 1; C drew D = 0.5; D drew C = 0.5
    assert.deepEqual(["A", "B", "C", "D"].map((id) => table.get(id)!.sonnebornBerger), [4, 1, 0.5, 0.5]);
    assert.equal(table.get("A")!.pointsDifferential, 60);
    assert.equal(table.get("D")!.pointsDifferential, -1);
  });

  it("orders ties by Buchholz, then Sonneborn-Berger, then points differential", () => {
    const order = computeSwissStandings(["A", "B", "C", "D"], matches).map((s) => s.memberId);
    // C and D both have 1 match point: C has the higher Buchholz (7 vs 4)
    assert.deepEqual(order, ["A", "B", "C", "D"]);

    const tied: SwissMatchRecord[] = [
      { round: 1, playerAId: "W", playerBId: "X", scoreA: 80, scoreB: 20, result: "A_WIN" },
      { round: 1, playerAId: "Y", playerBId: "Z", scoreA: 41, scoreB: 40, result: "A_WIN" },
    ];
    // W and Y: 3 points, Buchholz 0, SB 0 each -> differential +60 beats +1
    assert.deepEqual(computeSwissStandings(["Y", "W", "Z", "X"], tied).map((s) => s.memberId), ["W", "Y", "Z", "X"]);
  });

  it("scores a bye as a win without feeding opponents' tie-breaks", () => {
    const withBye: SwissMatchRecord[] = [
      { round: 1, playerAId: "A", playerBId: "B", scoreA: 50, scoreB: 40, result: "A_WIN" },
      { round: 1, playerAId: "C", playerBId: null, scoreA: 35, scoreB: null, result: "BYE" },
    ];
    const c = computeSwissStandings(["A", "B", "C"], withBye).find((s) => s.memberId === "C")!;
    assert.equal(c.matchPoints, 3);
    assert.equal(c.byes, 1);
    assert.equal(c.wins, 0);
    assert.equal(c.buchholz, 0);
    assert.equal(c.pointsDifferential, 0, "a bye does not distort the head-to-head differential");
    assert.equal(c.totalSquadScore, 35, "but the squad score still counts toward total squad score");
  });

  it("ignores pending pairings", () => {
    const pending: SwissMatchRecord[] = [{ round: 1, playerAId: "A", playerBId: "B", scoreA: null, scoreB: null, result: "PENDING" }];
    assert.ok(computeSwissStandings(["A", "B"], pending).every((s) => s.matchPoints === 0));
  });

  it("recommends ceil(log2(n)) rounds", () => {
    assert.equal(recommendedSwissRounds(8), 3);
    assert.equal(recommendedSwissRounds(9), 4);
    assert.equal(recommendedSwissRounds(64), 6);
    assert.equal(recommendedSwissRounds(1), 0);
  });
});

describe("Swiss engine: pairings", () => {
  it("pairs players with the closest-ranked opponent in round order", () => {
    const plan = generateSwissPairings(ids(8).map((memberId) => ({ memberId })), []);
    assert.deepEqual(
      plan.pairings.map((p) => [p.tableNumber, p.playerAId, p.playerBId]),
      [[1, "m01", "m02"], [2, "m03", "m04"], [3, "m05", "m06"], [4, "m07", "m08"]]
    );
  });

  it("gives the bye to the lowest-ranked player who has not had one", () => {
    const players = ids(5).map((memberId) => ({ memberId }));
    const first = generateSwissPairings(players, []);
    assert.equal(first.byeMemberId, "m05");

    const second = generateSwissPairings(players, [{ playerAId: "m05", playerBId: null }]);
    assert.equal(second.byeMemberId, "m04", "m05 already had a bye");
    const byeSlot = second.pairings[second.pairings.length - 1];
    assert.deepEqual([byeSlot.playerAId, byeSlot.playerBId], ["m04", null]);
  });

  it("avoids rematches while a rematch-free pairing exists", () => {
    const players = ids(4).map((memberId) => ({ memberId }));
    const plan = generateSwissPairings(players, [
      { playerAId: "m01", playerBId: "m02" },
      { playerAId: "m03", playerBId: "m04" },
    ]);
    assert.ok(plan.pairings.every((p) => !p.isRematch));
    assert.equal(plan.usedRematchFallback, false);
    assert.deepEqual(plan.pairings.map((p) => pairKey(p.playerAId, p.playerBId!)), ["m01|m03", "m02|m04"]);
  });

  it("falls back to a flagged rematch only when one is unavoidable", () => {
    const players = ids(4).map((memberId) => ({ memberId }));
    // Every pair of 4 players has already met (3 rounds of a full round-robin)
    const history = [
      ["m01", "m02"], ["m03", "m04"],
      ["m01", "m03"], ["m02", "m04"],
      ["m01", "m04"], ["m02", "m03"],
    ].map(([playerAId, playerBId]) => ({ playerAId, playerBId }));
    const plan = generateSwissPairings(players, history);
    assert.equal(plan.usedRematchFallback, true);
    assert.equal(plan.pairings.length, 2);
    assert.ok(plan.pairings.every((p) => p.isRematch));
  });

  it("still produces a complete pairing when the search budget is exhausted", () => {
    const plan = generateSwissPairings(ids(16).map((memberId) => ({ memberId })), [], { stepBudget: 1 });
    assert.equal(plan.pairings.length, 8);
  });

  for (const playerCount of [8, 16, 64]) {
    it(`runs a full 5-round tournament for ${playerCount} players without rematches`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const { matches, rematches, standings } = simulate(playerCount, 5, seed * 31 + playerCount);
        assert.equal(rematches, 0, `seed ${seed}`);
        const pairs = matches.filter((m) => m.playerBId).map((m) => pairKey(m.playerAId, m.playerBId!));
        assert.equal(new Set(pairs).size, pairs.length, "no pair meets twice");

        // Match points are conserved: 3 per decisive game, 2 per draw
        const decisive = matches.filter((m) => m.result === "A_WIN" || m.result === "B_WIN").length;
        const draws = matches.filter((m) => m.result === "DRAW").length;
        assert.equal(standings.reduce((sum, s) => sum + s.matchPoints, 0), decisive * 3 + draws * 2);
        assert.deepEqual(standings.map((s) => s.rank), standings.map((_, i) => i + 1));
        for (let i = 1; i < standings.length; i++) {
          assert.ok(standings[i - 1].matchPoints >= standings[i].matchPoints, "ranked by match points first");
        }
      }
    });
  }

  it("never repeats a bye across a 5-round tournament with an odd field", () => {
    for (const playerCount of [7, 9, 15, 63]) {
      const { matches } = simulate(playerCount, 5, playerCount);
      const byes = matches.filter((m) => m.playerBId === null).map((m) => m.playerAId);
      assert.equal(byes.length, 5);
      assert.equal(new Set(byes).size, 5, `${playerCount} players`);
    }
  });
});

// ============================================================
// Service with an in-memory database
// ============================================================

function swissDb(playerCount: number, gameweekCount = 5) {
  const db = createInMemoryPrisma({
    uniques: {
      swissTournament: [["leagueId", "seasonNumber"]],
      swissPairing: [["tournamentId", "round", "playerAId"], ["tournamentId", "round", "tableNumber"]],
      swissRoundStanding: [["tournamentId", "round", "memberId"]],
      squadGameweekScore: [["squadId", "gameweekId"]],
    },
    relations: {
      leagueMember: {
        user: { model: "user", foreignKey: "userId" },
        squad: { model: "squad", foreignKey: "squadId" },
      },
    },
    defaults: {
      swissTournament: () => ({ currentRound: 0, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() }),
      swissPairing: () => ({ result: "PENDING", scoreA: null, scoreB: null, isRematch: false, settledAt: null }),
    },
  });
  db.$seed("league", [{ id: "L1", scoringType: "SWISS", seasonNumber: 1, startGameweekId: 1, endGameweekId: gameweekCount, status: "ACTIVE" }]);
  db.$seed("gameweek", Array.from({ length: gameweekCount }, (_, i) => ({ id: i + 1 })));
  db.$seed("user", ids(playerCount).map((id) => ({ id: `u-${id}`, username: `user-${id}` })));
  db.$seed("squad", ids(playerCount).map((id) => ({ id: `s-${id}`, name: `Squad ${id}` })));
  db.$seed(
    "leagueMember",
    ids(playerCount).map((id, i) => ({
      id,
      leagueId: "L1",
      userId: `u-${id}`,
      squadId: `s-${id}`,
      status: "ACTIVE",
      joinedAt: new Date(2026, 7, 1, 0, i),
      rank: null,
      totalPoints: 0,
      matchesWon: 0,
      matchesDrawn: 0,
      matchesLost: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      h2hPoints: 0,
    }))
  );
  return db;
}

function seedScores(db: any, playerCount: number, gameweekId: number, random: () => number) {
  db.$seed(
    "squadGameweekScore",
    ids(playerCount).map((id) => ({ squadId: `s-${id}`, gameweekId, points: Math.floor(random() * 80) }))
  );
}

describe("SwissTournamentPairingService", () => {
  it("creates the tournament and pairs round 1 on activation, idempotently", async () => {
    const db = swissDb(8);
    const service = new SwissTournamentPairingService(db);
    const tournament = await service.startTournament("L1");
    assert.equal(tournament.totalRounds, 5);
    assert.equal(tournament.currentRound, 1);

    const again = await service.startTournament("L1");
    assert.equal(again.id, tournament.id);
    assert.equal(db.$tables().swissPairing.length, 4);
    assert.ok(db.$tables().swissPairing.every((p: any) => p.gameweekId === 1 && p.round === 1));
  });

  it("rejects leagues that do not use Swiss scoring", async () => {
    const db = swissDb(4);
    db.$tables().league[0].scoringType = "HEAD_TO_HEAD";
    await assert.rejects(new SwissTournamentPairingService(db).startTournament("L1"), SwissTournamentError);
  });

  it("settles a round from squad scores, snapshots standings and pairs the next gameweek", async () => {
    const db = swissDb(4);
    const service = new SwissTournamentPairingService(db);
    await service.startTournament("L1");
    db.$seed("squadGameweekScore", [
      { squadId: "s-m01", gameweekId: 1, points: 70 },
      { squadId: "s-m02", gameweekId: 1, points: 50 },
      { squadId: "s-m03", gameweekId: 1, points: 40 },
      { squadId: "s-m04", gameweekId: 1, points: 40 },
    ]);

    const result = await service.processGameweek("L1", 1);
    assert.deepEqual(result, { settled: 2, nextRound: 2 });

    const round1 = db.$tables().swissPairing.filter((p: any) => p.round === 1);
    assert.deepEqual(round1.map((p: any) => p.result).sort(), ["A_WIN", "DRAW"]);

    const snapshot = db.$tables().swissRoundStanding.filter((s: any) => s.round === 1);
    assert.equal(snapshot.length, 4);
    assert.equal(snapshot.find((s: any) => s.memberId === "m01").rank, 1);

    const m01 = db.$tables().leagueMember.find((m: any) => m.id === "m01");
    assert.equal(m01.h2hPoints, 3);
    assert.equal(m01.matchesWon, 1);

    const round2 = db.$tables().swissPairing.filter((p: any) => p.round === 2);
    assert.equal(round2.length, 2);
    assert.ok(round2.every((p: any) => p.gameweekId === 2 && !p.isRematch));
    // Winner meets the other 1-point-or-better player, not their round-1 opponent
    assert.ok(!round2.some((p: any) => pairKey(p.playerAId, p.playerBId) === "m01|m02"));

    // Retried settlement job: nothing is settled or paired twice
    assert.deepEqual(await service.processGameweek("L1", 1), { settled: 0, nextRound: null });
    assert.equal(db.$tables().swissPairing.length, 4);
    assert.equal(db.$tables().swissRoundStanding.length, 4);
  });

  it("runs a 5-gameweek season for 9 players: rotating byes, no rematches, completed tournament", async () => {
    const db = swissDb(9);
    const service = new SwissTournamentPairingService(db);
    const random = rng(2026);
    await service.startTournament("L1");

    for (let gameweek = 1; gameweek <= 5; gameweek++) {
      seedScores(db, 9, gameweek, random);
      await service.processGameweek("L1", gameweek);
    }

    const pairings = db.$tables().swissPairing;
    assert.equal(pairings.length, 5 * 5, "4 boards + 1 bye per round");
    assert.ok(pairings.every((p: any) => p.result !== "PENDING"));
    const byes = pairings.filter((p: any) => p.playerBId === null).map((p: any) => p.playerAId);
    assert.equal(new Set(byes).size, 5, "no repeat byes");
    const pairs = pairings.filter((p: any) => p.playerBId).map((p: any) => pairKey(p.playerAId, p.playerBId));
    assert.equal(new Set(pairs).size, pairs.length, "no rematches");

    const tournament = db.$tables().swissTournament[0];
    assert.equal(tournament.status, "COMPLETED");
    assert.equal(tournament.currentRound, 5);
    assert.equal(db.$tables().swissRoundStanding.length, 5 * 9, "a standings snapshot per round");

    const { standings } = await service.getStandings("L1");
    assert.equal(standings.length, 9);
    assert.equal(standings[0].rank, 1);
    assert.ok(standings[0].username.startsWith("user-"));
    assert.equal(standings.reduce((sum, s) => sum + s.byes, 0), 5);
  });

  it("returns pairings for one round", async () => {
    const db = swissDb(6);
    const service = new SwissTournamentPairingService(db);
    await service.startTournament("L1");
    const round1 = await service.getPairings("L1", 1);
    assert.equal(round1.length, 3);
    assert.deepEqual(await service.getPairings("L1", 2), []);
  });
});
