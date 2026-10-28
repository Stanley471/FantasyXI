import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SwissTournamentEngine,
  SwissParticipant,
} from "../services/league/swissTournamentEngine.js";
import { SwissTournamentService } from "../services/league/swissTournamentService.js";

describe("Swiss-System Tournament Engine (Issue #341)", () => {
  it("initializes tournament with calculated rounds based on participant count", () => {
    const participants = Array.from({ length: 16 }, (_, i) => ({
      id: `p-${i + 1}`,
      name: `Player ${i + 1}`,
      seed: i + 1,
    }));

    const engine = new SwissTournamentEngine({
      leagueId: "league-16",
      participants,
    });

    const state = engine.getState();
    assert.equal(state.status, "CREATED");
    assert.equal(state.totalRounds, 4); // log2(16) = 4
    assert.equal(state.currentRound, 0);
    assert.equal(Object.keys(state.participants).length, 16);
  });

  it("pairs Round 1 using top-half versus bottom-half seeding", () => {
    const participants = Array.from({ length: 8 }, (_, i) => ({
      id: `p-${i + 1}`,
      name: `Player ${i + 1}`,
      seed: i + 1,
    }));

    const engine = new SwissTournamentEngine({
      leagueId: "league-8",
      participants,
    });

    const round1 = engine.generateNextRound(1);
    assert.equal(round1.roundNumber, 1);
    assert.equal(round1.matchups.length, 4);

    // p1 vs p5, p2 vs p6, p3 vs p7, p4 vs p8
    assert.deepEqual(
      round1.matchups.map((m) => [m.homeParticipantId, m.awayParticipantId]),
      [
        ["p-1", "p-5"],
        ["p-2", "p-6"],
        ["p-3", "p-7"],
        ["p-4", "p-8"],
      ]
    );
  });

  it("handles odd number of participants with deterministic non-duplicate byes", () => {
    const participants = Array.from({ length: 7 }, (_, i) => ({
      id: `p-${i + 1}`,
      seed: i + 1,
    }));

    const engine = new SwissTournamentEngine({
      leagueId: "league-7",
      participants,
      totalRounds: 3,
    });

    // Round 1
    const r1 = engine.generateNextRound(1);
    const bye1 = r1.matchups.find((m) => m.awayParticipantId === null);
    assert.ok(bye1);
    assert.equal(bye1.homeParticipantId, "p-7"); // lowest-seeded player gets bye in R1
    assert.equal(bye1.isFinished, true);

    // Complete R1 matches
    engine.submitRoundResults(1, [
      { homeParticipantId: "p-1", awayParticipantId: "p-4", homeScore: 50, awayScore: 40 },
      { homeParticipantId: "p-2", awayParticipantId: "p-5", homeScore: 60, awayScore: 30 },
      { homeParticipantId: "p-3", awayParticipantId: "p-6", homeScore: 45, awayScore: 45 },
    ]);

    // Round 2
    const r2 = engine.generateNextRound(2);
    const bye2 = r2.matchups.find((m) => m.awayParticipantId === null);
    assert.ok(bye2);
    assert.notEqual(bye2.homeParticipantId, "p-7"); // p-7 should NOT get a duplicate bye

    // Verify p-7 has exactly 1 bye and 3 match points from bye
    const p7 = engine.getState().participants["p-7"];
    assert.equal(p7.byes, 1);
    assert.equal(p7.matchPoints, 3);
  });

  it("accurately computes Buchholz and Sonneborn-Berger tie-break metrics", () => {
    // 4 players, 2 rounds
    const participants = [
      { id: "A", name: "Alice", seed: 1 },
      { id: "B", name: "Bob", seed: 2 },
      { id: "C", name: "Charlie", seed: 3 },
      { id: "D", name: "David", seed: 4 },
    ];

    const engine = new SwissTournamentEngine({
      leagueId: "league-tie-break",
      participants,
      totalRounds: 2,
    });

    // Round 1: A vs C, B vs D
    engine.generateNextRound(1);
    // A beats C (A: 3pts, C: 0pts)
    // B draws with D (B: 1pt, D: 1pt)
    engine.submitRoundResults(1, [
      { homeParticipantId: "A", awayParticipantId: "C", homeScore: 60, awayScore: 40 },
      { homeParticipantId: "B", awayParticipantId: "D", homeScore: 50, awayScore: 50 },
    ]);

    // Round 2: A vs B, C vs D
    engine.generateNextRound(2);
    // A beats B (A: 6pts, B: 1pt)
    // C beats D (C: 3pts, D: 1pt)
    engine.submitRoundResults(2, [
      { homeParticipantId: "A", awayParticipantId: "B", homeScore: 70, awayScore: 55 },
      { homeParticipantId: "C", awayParticipantId: "D", homeScore: 48, awayScore: 40 },
    ]);

    const standings = engine.getStandings();
    const alice = standings.find((p) => p.id === "A")!;
    const charlie = standings.find((p) => p.id === "C")!;
    const bob = standings.find((p) => p.id === "B")!;
    const david = standings.find((p) => p.id === "D")!;

    // Alice opponents faced: C (3 pts) and B (1 pt)
    // Alice Buchholz = 3 + 1 = 4
    // Alice beat both, so Sonneborn-Berger = 3 + 1 = 4
    assert.equal(alice.matchPoints, 6);
    assert.equal(alice.buchholzScore, 4);
    assert.equal(alice.sonnebornBergerScore, 4);

    // Charlie opponents faced: A (6 pts) and D (1 pt)
    // Charlie Buchholz = 6 + 1 = 7
    // Charlie beat D (1 pt), lost to A => Sonneborn-Berger = 1
    assert.equal(charlie.matchPoints, 3);
    assert.equal(charlie.buchholzScore, 7);
    assert.equal(charlie.sonnebornBergerScore, 1);

    // Bob opponents faced: D (1 pt) and A (6 pts)
    // Bob Buchholz = 7
    // Bob drew with D (1 pt * 0.5 = 0.5), lost to A => Sonneborn-Berger = 0.5
    assert.equal(bob.matchPoints, 1);
    assert.equal(bob.buchholzScore, 7);
    assert.equal(bob.sonnebornBergerScore, 0.5);

    // David opponents faced: B (1 pt) and C (3 pts)
    // David Buchholz = 4
    // David drew with B (1 pt * 0.5 = 0.5), lost to C => Sonneborn-Berger = 0.5
    assert.equal(david.matchPoints, 1);
    assert.equal(david.buchholzScore, 4);
    assert.equal(david.sonnebornBergerScore, 0.5);

    // Bob ranks ahead of David due to higher Buchholz (7 vs 4)
    assert.ok(bob.rank < david.rank);
  });

  it("strictly prevents repeat matchups across multi-round simulations (32 players)", () => {
    const playerCount = 32;
    const totalRounds = 5;

    const participants = Array.from({ length: playerCount }, (_, i) => ({
      id: `manager-${i + 1}`,
      seed: i + 1,
    }));

    const engine = new SwissTournamentEngine({
      leagueId: "sim-32",
      participants,
      totalRounds,
    });

    const matchupHistory = new Set<string>();

    for (let round = 1; round <= totalRounds; round++) {
      const swissRound = engine.generateNextRound(round);

      const roundResults: any[] = [];
      for (const m of swissRound.matchups) {
        if (!m.awayParticipantId) continue;

        // Key independent of home/away order
        const pairKey = [m.homeParticipantId, m.awayParticipantId].sort().join("::");
        assert.equal(
          matchupHistory.has(pairKey),
          false,
          `Repeat matchup detected in round ${round}: ${pairKey}`
        );
        matchupHistory.add(pairKey);

        const score1 = ((round * 17 + Number(m.homeParticipantId.split("-")[1]) * 7) % 80) + 20;
        const score2 = ((round * 13 + Number(m.awayParticipantId.split("-")[1]) * 11) % 80) + 20;
        roundResults.push({
          homeParticipantId: m.homeParticipantId,
          awayParticipantId: m.awayParticipantId,
          homeScore: score1,
          awayScore: score2,
        });
      }

      engine.submitRoundResults(round, roundResults);
    }

    assert.equal(engine.getState().status, "TOURNAMENT_COMPLETED");
  });

  it("requires a complete, unique, valid result set before resolving a round", () => {
    const engine = new SwissTournamentEngine({
      leagueId: "validated-results",
      participants: Array.from({ length: 4 }, (_, i) => ({ id: `p-${i + 1}` })),
      totalRounds: 2,
    });
    const round = engine.generateNextRound(1);
    const [first, second] = round.matchups;
    const firstResult = {
      homeParticipantId: first.homeParticipantId,
      awayParticipantId: first.awayParticipantId!,
      homeScore: 40,
      awayScore: 30,
    };
    const secondResult = {
      homeParticipantId: second.homeParticipantId,
      awayParticipantId: second.awayParticipantId!,
      homeScore: 20,
      awayScore: 10,
    };

    assert.throws(() => engine.submitRoundResults(1, [firstResult]), /every non-bye matchup/);
    assert.equal(engine.getState().participants[first.homeParticipantId].matchPoints, 0);
    assert.throws(
      () => engine.submitRoundResults(1, [firstResult, firstResult]),
      /only be submitted once/
    );
    assert.throws(
      () => engine.submitRoundResults(1, [firstResult, { ...secondResult, homeScore: -1 }]),
      /finite, non-negative/
    );

    engine.submitRoundResults(1, [firstResult, secondResult]);
    const pointsAfterResolution = engine.getState().participants[first.homeParticipantId].matchPoints;
    assert.throws(() => engine.submitRoundResults(1, [firstResult, secondResult]), /active round/);
    assert.equal(engine.getState().participants[first.homeParticipantId].matchPoints, pointsAfterResolution);
  });

  it("completes five-round 8, 16, and 64-player tournaments without repeats or duplicate byes", () => {
    for (const playerCount of [8, 16, 64]) {
      const engine = new SwissTournamentEngine({
        leagueId: `acceptance-${playerCount}`,
        participants: Array.from({ length: playerCount }, (_, index) => ({
          id: `player-${index + 1}`,
          seed: index + 1,
        })),
        totalRounds: 5,
      });
      const opponents = new Set<string>();
      const byeRecipients = new Set<string>();

      for (let round = 1; round <= 5; round++) {
        const pairing = engine.generateNextRound(round);
        const results = [];
        for (const matchup of pairing.matchups) {
          if (matchup.awayParticipantId === null) {
            assert.equal(byeRecipients.has(matchup.homeParticipantId), false);
            byeRecipients.add(matchup.homeParticipantId);
            continue;
          }
          const key = [matchup.homeParticipantId, matchup.awayParticipantId].sort().join("::");
          assert.equal(opponents.has(key), false, `repeat pairing in ${playerCount}-player round ${round}`);
          opponents.add(key);
          results.push({
            homeParticipantId: matchup.homeParticipantId,
            awayParticipantId: matchup.awayParticipantId,
            homeScore: round * 10 + Number(matchup.homeParticipantId.split("-")[1]),
            awayScore: round * 10 + Number(matchup.awayParticipantId.split("-")[1]),
          });
        }
        engine.submitRoundResults(round, results);
      }

      assert.equal(engine.getState().status, "TOURNAMENT_COMPLETED");
      assert.equal(engine.getStandings().length, playerCount);
    }
  });

  it("enforces state machine round lifecycle and guards against invalid transitions", () => {
    const participants = Array.from({ length: 4 }, (_, i) => ({
      id: `p-${i + 1}`,
    }));

    const engine = new SwissTournamentEngine({
      leagueId: "sm-test",
      participants,
      totalRounds: 2,
    });

    assert.equal(engine.getState().status, "CREATED");

    // Start round 1
    engine.generateNextRound(1);
    assert.equal(engine.getState().status, "ROUND_ACTIVE");

    // Cannot advance while round is unfinished
    assert.throws(
      () => engine.generateNextRound(2),
      /Current round has unfinished matches/
    );

    // Submit results
    engine.submitRoundResults(1, [
      { homeParticipantId: "p-1", awayParticipantId: "p-3", homeScore: 50, awayScore: 40 },
      { homeParticipantId: "p-2", awayParticipantId: "p-4", homeScore: 30, awayScore: 60 },
    ]);
    assert.equal(engine.getState().status, "ROUND_COMPLETED");

    // Start round 2
    engine.generateNextRound(2);
    assert.equal(engine.getState().status, "ROUND_ACTIVE");

    // Submit results for final round
    engine.submitRoundResults(2, [
      { homeParticipantId: "p-1", awayParticipantId: "p-4", homeScore: 70, awayScore: 65 },
      { homeParticipantId: "p-2", awayParticipantId: "p-3", homeScore: 40, awayScore: 45 },
    ]);
    assert.equal(engine.getState().status, "TOURNAMENT_COMPLETED");

    // Cannot advance beyond total rounds
    assert.throws(
      () => engine.generateNextRound(3),
      /Tournament is already completed/
    );
  });

  it("executes matchmaking within acceptable timeouts for 512 players", () => {
    const playerCount = 512;
    const participants = Array.from({ length: playerCount }, (_, i) => ({
      id: `usr-${i + 1}`,
      seed: i + 1,
    }));

    const startInit = performance.now();
    const engine = new SwissTournamentEngine({
      leagueId: "perf-512",
      participants,
      totalRounds: 5,
    });
    const round1 = engine.generateNextRound(1);
    const duration = performance.now() - startInit;

    assert.equal(round1.matchups.length, 256);
    assert.ok(duration < 200, `Pairing 512 players took ${duration}ms, expected < 200ms`);
  });

  it("SwissTournamentService coordinates league lifecycle", () => {
    SwissTournamentService.clearStore();

    const participants = [
      { id: "m1", name: "Manager 1" },
      { id: "m2", name: "Manager 2" },
      { id: "m3", name: "Manager 3" },
      { id: "m4", name: "Manager 4" },
    ];

    const state = SwissTournamentService.createTournament("league-service-test", participants, 2);
    assert.equal(state.leagueId, "league-service-test");

    const r1 = SwissTournamentService.startOrAdvanceRound("league-service-test", 10);
    assert.equal(r1.roundNumber, 1);
    assert.equal(r1.gameweekId, 10);

    const standings = SwissTournamentService.getStandings("league-service-test");
    assert.equal(standings.length, 4);
  });
});
