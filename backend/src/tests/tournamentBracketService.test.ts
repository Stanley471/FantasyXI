import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TournamentBracketService,
  TournamentValidationError,
} from "../services/league/tournamentService.js";

describe("TournamentBracketService (Issue #231)", () => {
  describe("Round-Robin Pairing Generation", () => {
    it("generates balanced round-robin pairings where every manager plays every other manager equally without duplicate matchups in a round", () => {
      const members = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
      const gameweeks = [1, 2, 3, 4, 5, 6, 7]; // 1 full cycle of N-1 = 7 rounds

      const schedule = TournamentBracketService.generateRoundRobinSchedule(
        members,
        gameweeks
      );

      // 8 members => 4 matches per gameweek * 7 gameweeks = 28 matches total
      assert.equal(schedule.length, 28);

      // Verify no manager appears more than once in the same gameweek round
      for (const gw of gameweeks) {
        const gwMatches = schedule.filter((m) => m.gameweekId === gw);
        assert.equal(gwMatches.length, 4);
        const seenInRound = new Set<string>();
        for (const m of gwMatches) {
          assert.equal(seenInRound.has(m.homeMemberId), false, `Duplicate home ${m.homeMemberId} in GW ${gw}`);
          seenInRound.add(m.homeMemberId);
          assert.ok(m.awayMemberId !== null);
          assert.equal(seenInRound.has(m.awayMemberId!), false, `Duplicate away ${m.awayMemberId} in GW ${gw}`);
          seenInRound.add(m.awayMemberId!);
        }
        assert.equal(seenInRound.size, 8);
      }

      // Verify every unique pair of managers meets exactly once across the 7-round cycle
      const pairCounts = new Map<string, number>();
      for (const m of schedule) {
        const key = [m.homeMemberId, m.awayMemberId!].sort().join(":");
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
      assert.equal(pairCounts.size, 28);
      for (const count of pairCounts.values()) {
        assert.equal(count, 1);
      }
    });

    it("supports odd participant counts by adding an Average (null) bye slot", () => {
      const members = ["m1", "m2", "m3", "m4", "m5"];
      const gameweeks = [1, 2, 3, 4, 5];
      const schedule = TournamentBracketService.generateRoundRobinSchedule(members, gameweeks);

      // 5 members + 1 null => 3 matches per round * 5 rounds = 15 fixtures
      assert.equal(schedule.length, 15);
      const averageMatches = schedule.filter((m) => m.awayMemberId === null);
      assert.equal(averageMatches.length, 5);
    });
  });

  describe("Single-Elimination Knockout Brackets (8, 16, 32, 64)", () => {
    it("supports 8, 16, 32, and 64 participant brackets and rejects invalid counts", () => {
      for (const size of [8, 16, 32, 64] as const) {
        const seeds = Array.from({ length: size }, (_, i) => `seed_${i + 1}`);
        const bracket = TournamentBracketService.generateKnockoutBracket({
          leagueId: `league_${size}`,
          seededMemberIds: seeds,
          startGameweekId: 30,
        });
        assert.equal(bracket.bracketSize, size);
        assert.equal(bracket.totalRounds, Math.log2(size));
        assert.equal(bracket.rounds[0].matches.length, size / 2);
      }

      assert.throws(
        () =>
          TournamentBracketService.generateKnockoutBracket({
            leagueId: "invalid",
            seededMemberIds: ["m1", "m2", "m3", "m4", "m5", "m6"],
            startGameweekId: 35,
          }),
        TournamentValidationError
      );
    });
  });

  describe("FPL Tie-Breaking Hierarchy", () => {
    it("resolves tied scores by (1) most goals scored, (2) fewest goals conceded, (3) deterministic virtual coin toss", () => {
      // 1. Most goals scored in the gameweek wins
      const byGoalsScored = TournamentBracketService.resolveMatchWithTieBreaker({
        homeMemberId: "manager_home",
        awayMemberId: "manager_away",
        homeScore: 62,
        awayScore: 62,
        homeGoalsScored: 3,
        awayGoalsScored: 5,
        homeGoalsConceded: 2,
        awayGoalsConceded: 4,
      });
      assert.equal(byGoalsScored.winnerMemberId, "manager_away");
      assert.equal(byGoalsScored.method, "GOALS_SCORED");

      // 2. When goals scored are equal, fewest goals conceded wins
      const byGoalsConceded = TournamentBracketService.resolveMatchWithTieBreaker({
        homeMemberId: "manager_home",
        awayMemberId: "manager_away",
        homeScore: 62,
        awayScore: 62,
        homeGoalsScored: 4,
        awayGoalsScored: 4,
        homeGoalsConceded: 5,
        awayGoalsConceded: 2,
      });
      assert.equal(byGoalsConceded.winnerMemberId, "manager_away");
      assert.equal(byGoalsConceded.method, "GOALS_CONCEDED");

      // 3. When score, goals scored, and goals conceded are all equal, virtual coin toss decides deterministically
      const byCoinToss1 = TournamentBracketService.resolveMatchWithTieBreaker({
        homeMemberId: "manager_home",
        awayMemberId: "manager_away",
        homeScore: 62,
        awayScore: 62,
        homeGoalsScored: 4,
        awayGoalsScored: 4,
        homeGoalsConceded: 2,
        awayGoalsConceded: 2,
        fixtureKey: "final_match_1",
      });
      const byCoinToss2 = TournamentBracketService.resolveMatchWithTieBreaker({
        homeMemberId: "manager_home",
        awayMemberId: "manager_away",
        homeScore: 62,
        awayScore: 62,
        homeGoalsScored: 4,
        awayGoalsScored: 4,
        homeGoalsConceded: 2,
        awayGoalsConceded: 2,
        fixtureKey: "final_match_1",
      });
      assert.equal(byCoinToss1.method, "COIN_TOSS");
      assert.equal(byCoinToss1.winnerMemberId, byCoinToss2.winnerMemberId);
      assert.ok(["manager_home", "manager_away"].includes(byCoinToss1.winnerMemberId));
    });
  });

  describe("Bracket Progression from Round of 16 to Final", () => {
    it("progresses a 16-player knockout tournament from Round of 16 -> Quarter-Finals -> Semi-Finals -> Final and crowns champion", () => {
      const seeds = Array.from({ length: 16 }, (_, i) => `seed_${i + 1}`);
      let bracket = TournamentBracketService.generateKnockoutBracket({
        leagueId: "cup_16",
        seededMemberIds: seeds,
        startGameweekId: 35,
      });

      assert.equal(bracket.rounds[0].roundName, "Round of 16");
      assert.equal(bracket.rounds[1].roundName, "Quarter-Finals");
      assert.equal(bracket.rounds[2].roundName, "Semi-Finals");
      assert.equal(bracket.rounds[3].roundName, "Final");

      // Round 1 (Round of 16): higher seed (homeMemberId) wins all 8 matches
      const r1 = TournamentBracketService.progressBracketRound({
        bracket,
        round: 1,
        results: Array.from({ length: 8 }, (_, slot) => ({
          slot,
          homeScore: 70,
          awayScore: 55,
        })),
      });
      bracket = r1.bracket;
      assert.equal(r1.championMemberId, null);
      assert.equal(r1.nextRound?.roundName, "Quarter-Finals");
      assert.equal(r1.nextRound?.matches.length, 4);
      // Slot 0 of Quarter-Finals should pair seed_1 vs seed_8
      assert.equal(r1.nextRound?.matches[0].homeMemberId, "seed_1");
      assert.equal(r1.nextRound?.matches[0].awayMemberId, "seed_8");

      // Round 2 (Quarter-Finals): include a tie resolved by goals scored
      const r2 = TournamentBracketService.progressBracketRound({
        bracket,
        round: 2,
        results: [
          { slot: 0, homeScore: 65, awayScore: 65, homeGoalsScored: 4, awayGoalsScored: 2 }, // seed_1 wins on goals scored
          { slot: 1, homeScore: 58, awayScore: 64 }, // away (seed_5) wins
          { slot: 2, homeScore: 72, awayScore: 60 }, // home (seed_2) wins
          { slot: 3, homeScore: 61, awayScore: 61, homeGoalsScored: 2, awayGoalsScored: 2, homeGoalsConceded: 1, awayGoalsConceded: 3 }, // home (seed_3) wins on fewest goals conceded
        ],
      });
      bracket = r2.bracket;
      assert.equal(r2.nextRound?.roundName, "Semi-Finals");
      assert.deepEqual(
        r2.nextRound?.matches.map((m) => [m.homeMemberId, m.awayMemberId]),
        [
          ["seed_1", "seed_5"],
          ["seed_2", "seed_3"],
        ]
      );

      // Round 3 (Semi-Finals): seed_1 and seed_2 advance to Final
      const r3 = TournamentBracketService.progressBracketRound({
        bracket,
        round: 3,
        results: [
          { slot: 0, homeScore: 80, awayScore: 66 },
          { slot: 1, homeScore: 75, awayScore: 70 },
        ],
      });
      bracket = r3.bracket;
      assert.equal(r3.nextRound?.roundName, "Final");
      assert.equal(r3.nextRound?.matches.length, 1);
      assert.equal(r3.nextRound?.matches[0].homeMemberId, "seed_1");
      assert.equal(r3.nextRound?.matches[0].awayMemberId, "seed_2");

      // Round 4 (Final): seed_2 wins 88 - 82
      const r4 = TournamentBracketService.progressBracketRound({
        bracket,
        round: 4,
        results: [{ slot: 0, homeScore: 82, awayScore: 88 }],
      });
      assert.equal(r4.championMemberId, "seed_2");
      assert.equal(r4.nextRound, null);
    });
  });
});
