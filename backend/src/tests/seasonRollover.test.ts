import test from "node:test";
import assert from "node:assert/strict";
import {
  SeasonRolloverService,
  RolloverLeagueState,
} from "../services/league/seasonRolloverService.js";

function sampleCompletedLeague(): RolloverLeagueState {
  return {
    id: "league-premier-1",
    name: "Stellar Champions Cup",
    inviteCode: "STLR99",
    adminId: "user-1",
    seasonKey: "2025/26",
    status: "COMPLETED",
    startGameweekId: 1,
    endGameweekId: 38,
    prizePool: 5000,
    h2hScheduleCount: 380,
    members: [
      {
        userId: "user-1",
        username: "Alice",
        squadId: "sq-1",
        squadName: "Alice XI",
        totalPoints: 2380,
        rank: 2,
        prizeWon: 1500,
        highestGameweekPoints: 112,
        highestGameweekId: 19,
        h2hWins: 24,
        h2hDraws: 4,
        h2hLosses: 10,
        h2hPoints: 76,
      },
      {
        userId: "user-2",
        username: "Bob",
        squadId: "sq-2",
        squadName: "Bob Rovers",
        totalPoints: 2495,
        rank: 1,
        prizeWon: 3000,
        highestGameweekPoints: 98,
        highestGameweekId: 12,
        h2hWins: 28,
        h2hDraws: 3,
        h2hLosses: 7,
        h2hPoints: 87,
      },
      {
        userId: "user-3",
        username: "Charlie",
        squadId: "sq-3",
        squadName: "Charlie FC",
        totalPoints: 2210,
        rank: 3,
        prizeWon: 500,
        highestGameweekPoints: 95,
        highestGameweekId: 7,
        h2hWins: 20,
        h2hDraws: 5,
        h2hLosses: 13,
        h2hPoints: 65,
      },
      {
        userId: "user-4",
        username: "Diana",
        squadId: "sq-4",
        squadName: "Diana Athletic",
        totalPoints: 2050,
        rank: 4,
        prizeWon: 0,
        highestGameweekPoints: 89,
        highestGameweekId: 3,
        h2hWins: 14,
        h2hDraws: 4,
        h2hLosses: 20,
        h2hPoints: 46,
      },
    ],
  };
}

test("SeasonRolloverService: archives completed season, awards trophies, and resets league for next campaign", () => {
  const service = new SeasonRolloverService();
  service.registerLeagueState(sampleCompletedLeague());

  const result = service.rolloverLeagueSeason("league-premier-1", {
    newStartGameweekId: 1,
    newEndGameweekId: 38,
    retainMembers: true,
  });

  // 1. Verify immutable archive
  assert.equal(result.archive.seasonKey, "2025/26");
  assert.equal(result.archive.championUserId, "user-2");
  assert.equal(result.archive.championUsername, "Bob");
  assert.equal(result.archive.highestSingleGwScore.userId, "user-1");
  assert.equal(result.archive.highestSingleGwScore.points, 112);
  assert.equal(result.archive.finalStandings.length, 4);
  assert.equal(result.archive.finalStandings[0].userId, "user-2");
  assert.equal(result.archive.finalStandings[0].rank, 1);

  // 2. Verify trophies awarded (Gold, Silver, Bronze + Highest GW Scorer)
  assert.equal(result.trophies.length, 4);
  const bobTrophies = service.getUserTrophyCabinet("user-2");
  assert.equal(bobTrophies.length, 1);
  assert.equal(bobTrophies[0].trophyType, "GOLD_CHAMPION");

  const aliceTrophies = service.getUserTrophyCabinet("user-1");
  assert.equal(aliceTrophies.length, 2); // SILVER_RUNNER_UP + HIGHEST_GW_SCORER
  assert.ok(aliceTrophies.some((t) => t.trophyType === "SILVER_RUNNER_UP"));
  assert.ok(aliceTrophies.some((t) => t.trophyType === "HIGHEST_GW_SCORER"));

  // 3. Verify updated league state for new season
  const updated = service.getLeagueState("league-premier-1");
  assert.equal(updated.seasonKey, "2026/27");
  assert.equal(updated.status, "OPEN");
  assert.equal(updated.inviteCode, "STLR99"); // preserved!
  assert.equal(updated.adminId, "user-1"); // preserved!
  assert.equal(updated.prizePool, 0);
  assert.equal(updated.h2hScheduleCount, 0);
  assert.equal(updated.members.length, 4);
  for (const m of updated.members) {
    assert.equal(m.totalPoints, 0);
    assert.equal(m.rank, null);
    assert.equal(m.prizeWon, 0);
    assert.equal(m.h2hPoints, 0);
  }
});

test("SeasonRolloverService: rolls back atomically on mid-pipeline failure without corrupting state", () => {
  const service = new SeasonRolloverService();
  service.registerLeagueState(sampleCompletedLeague());

  assert.throws(
    () =>
      service.rolloverLeagueSeason("league-premier-1", {
        newStartGameweekId: 1,
        newEndGameweekId: 38,
        beforeCommitHook: () => {
          throw new Error("Simulated database crash before commit");
        },
      }),
    /Simulated database crash before commit/
  );

  // Original league state must be completely untouched
  const afterFailure = service.getLeagueState("league-premier-1");
  assert.equal(afterFailure.status, "COMPLETED");
  assert.equal(afterFailure.seasonKey, "2025/26");
  assert.equal(afterFailure.prizePool, 5000);
  assert.equal(afterFailure.members[1].totalPoints, 2495);

  // No partial archive or trophy records should exist
  assert.equal(service.getLeagueHistory("league-premier-1").length, 0);
  assert.equal(service.getUserTrophyCabinet("user-2").length, 0);
});
