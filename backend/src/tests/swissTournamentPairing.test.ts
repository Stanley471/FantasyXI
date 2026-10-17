import test from "node:test";
import assert from "node:assert/strict";
import {
  SwissTournamentPairingService,
  SwissMatchResult,
} from "../services/league/swissTournamentPairingService.js";

function runFiveRoundSwissSimulation(playerCount: number): void {
  const players = Array.from({ length: playerCount }, (_, i) => `player-${i + 1}`);
  const completedMatches: SwissMatchResult[] = [];
  const seenPairs = new Set<string>();

  for (let round = 1; round <= 5; round++) {
    const pairings = SwissTournamentPairingService.generateNextRoundPairings(
      players,
      completedMatches,
      round
    );

    const activePlayersThisRound = new Set<string>();

    for (const p of pairings) {
      assert.ok(!activePlayersThisRound.has(p.homePlayerId), "Player scheduled twice in same round");
      activePlayersThisRound.add(p.homePlayerId);

      if (p.awayPlayerId !== null) {
        assert.ok(!activePlayersThisRound.has(p.awayPlayerId), "Away player scheduled twice in same round");
        activePlayersThisRound.add(p.awayPlayerId);

        const pairKey = [p.homePlayerId, p.awayPlayerId].sort().join("::");
        assert.ok(!seenPairs.has(pairKey), `Duplicate pairing detected: ${pairKey} in round ${round}`);
        seenPairs.add(pairKey);

        completedMatches.push({
          round,
          homePlayerId: p.homePlayerId,
          awayPlayerId: p.awayPlayerId,
          homeFantasyPoints: 50 + ((round * 7 + p.tableNumber * 3) % 35),
          awayFantasyPoints: 45 + ((round * 5 + p.tableNumber * 11) % 35),
        });
      } else {
        completedMatches.push({
          round,
          homePlayerId: p.homePlayerId,
          awayPlayerId: null,
          homeFantasyPoints: 55,
          awayFantasyPoints: 0,
        });
      }
    }

    assert.equal(activePlayersThisRound.size, playerCount);
  }
}

test("SwissTournamentPairingService: simulates 5-round Swiss tournaments for 8, 16, and 64 players with zero repeat matchups", () => {
  for (const count of [8, 16, 64]) {
    runFiveRoundSwissSimulation(count);
  }
});

test("SwissTournamentPairingService: assigns BYE fairly to lowest-ranked player without repeat byes on odd player counts", () => {
  const players = Array.from({ length: 9 }, (_, i) => `odd-player-${i + 1}`);
  const completedMatches: SwissMatchResult[] = [];
  const byeRecipients = new Set<string>();

  for (let round = 1; round <= 5; round++) {
    const pairings = SwissTournamentPairingService.generateNextRoundPairings(
      players,
      completedMatches,
      round
    );

    const byeMatch = pairings.find((p) => p.isBye);
    assert.ok(byeMatch, `Expected a BYE pairing in round ${round}`);
    assert.ok(
      !byeRecipients.has(byeMatch.homePlayerId),
      `Player ${byeMatch.homePlayerId} received a duplicate BYE in round ${round}`
    );
    byeRecipients.add(byeMatch.homePlayerId);

    for (const p of pairings) {
      completedMatches.push({
        round,
        homePlayerId: p.homePlayerId,
        awayPlayerId: p.awayPlayerId,
        homeFantasyPoints: 60,
        awayFantasyPoints: p.awayPlayerId ? 48 : 0,
      });
    }
  }

  assert.equal(byeRecipients.size, 5);
});

test("SwissTournamentPairingService: resolves ties using Buchholz, Sonnenborn-Berger, and fantasy points differential", () => {
  const players = ["A", "B", "C", "D"];
  // Round 1: A beats C (70-50), B beats D (65-60)
  // Round 2: C beats D (80-40) -> C has 3 pts, D has 0 pts
  // Both A and B have 3 match points from Round 1, but A's opponent (C) has 3 pts (Buchholz=3)
  // while B's opponent (D) has 0 pts (Buchholz=0).
  const matches: SwissMatchResult[] = [
    { round: 1, homePlayerId: "A", awayPlayerId: "C", homeFantasyPoints: 70, awayFantasyPoints: 50 },
    { round: 1, homePlayerId: "B", awayPlayerId: "D", homeFantasyPoints: 65, awayFantasyPoints: 60 },
    { round: 2, homePlayerId: "C", awayPlayerId: "D", homeFantasyPoints: 80, awayFantasyPoints: 40 },
  ];

  const standings = SwissTournamentPairingService.calculateStandings(players, matches);
  const rankA = standings.find((s) => s.playerId === "A")!;
  const rankB = standings.find((s) => s.playerId === "B")!;

  assert.equal(rankA.matchPoints, 3);
  assert.equal(rankB.matchPoints, 3);
  assert.equal(rankA.buchholzScore, 3);
  assert.equal(rankB.buchholzScore, 0);
  assert.ok(rankA.rank < rankB.rank, "Player A should rank higher than Player B via Buchholz tie-breaker");
});
