import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveProvisionalLeaderboardService,
  LeaderboardDeltaBroadcast,
} from "../services/leaderboard/liveProvisionalLeaderboardService.js";

test("LiveProvisionalLeaderboardService: updates 1,000 squads in real-time, computes rank deltas, and deduplicates events", () => {
  const broadcasts: LeaderboardDeltaBroadcast[] = [];
  const service = new LiveProvisionalLeaderboardService({
    onBroadcast: (payload) => broadcasts.push(payload),
  });

  // Create 1,000 squads in league-1
  const squads = Array.from({ length: 1000 }, (_, i) => {
    const id = `squad-${String(i + 1).padStart(4, "0")}`;
    // Squad 1000 starts at the bottom (baseline 100 pts) but Triple-Captains player 99
    if (i === 999) {
      return {
        squadId: id,
        userId: `user-${i + 1}`,
        baselinePoints: 100,
        lineup: [{ playerId: 99, isStarter: true, multiplier: 3 }],
      };
    }
    return {
      squadId: id,
      userId: `user-${i + 1}`,
      baselinePoints: 105 + (i % 10),
      lineup: [{ playerId: (i % 20) + 1, isStarter: true, multiplier: 1 }],
    };
  });

  service.registerLeagueSquads("league-1", squads);

  const before = service.getLeagueStandings("league-1");
  const bottomBefore = before.find((s) => s.squadId === "squad-1000")!;
  assert.equal(bottomBefore.rank, 1000);

  // Player 99 scores two goals (+10 raw points => +30 points for Triple Captain squad-1000 -> total 130 pts -> Rank 1!)
  const startMs = performance.now();
  const result = service.ingestLiveEvent({
    eventId: "evt-goal-99-1",
    fixtureId: 501,
    gameweekId: 22,
    playerId: 99,
    eventType: "GOAL",
    pointsDelta: 10,
    occurredAtMs: Date.now(),
  });
  const elapsedMs = performance.now() - startMs;

  assert.ok(elapsedMs < 100, `Expected sub-100ms live update for 1,000 squads, took ${elapsedMs}ms`);
  assert.equal(result.length, 1);
  assert.equal(broadcasts.length, 1);

  const after = service.getLeagueStandings("league-1");
  const topAfter = after[0];
  assert.equal(topAfter.squadId, "squad-1000");
  assert.equal(topAfter.liveGameweekPoints, 30);
  assert.equal(topAfter.totalProvisionalPoints, 130);
  assert.equal(topAfter.rank, 1);
  assert.equal(topAfter.previousRank, 1000);
  assert.equal(topAfter.rankDelta, 999);

  // Replaying the same eventId is ignored
  const duplicateResult = service.ingestLiveEvent({
    eventId: "evt-goal-99-1",
    fixtureId: 501,
    gameweekId: 22,
    playerId: 99,
    eventType: "GOAL",
    pointsDelta: 10,
    occurredAtMs: Date.now(),
  });
  assert.equal(duplicateResult.length, 0);
});

test("LiveProvisionalLeaderboardService: reconciles provisional live scores with official post-gameweek scores", () => {
  const service = new LiveProvisionalLeaderboardService();
  service.registerLeagueSquads("league-reconcile", [
    {
      squadId: "sq-a",
      userId: "u-a",
      baselinePoints: 200,
      lineup: [{ playerId: 10, isStarter: true, multiplier: 2 }],
    },
    {
      squadId: "sq-b",
      userId: "u-b",
      baselinePoints: 200,
      lineup: [{ playerId: 11, isStarter: true, multiplier: 1 }],
    },
  ]);

  service.ingestLiveEvent({
    eventId: "evt-1",
    fixtureId: 1,
    gameweekId: 5,
    playerId: 10,
    eventType: "GOAL",
    pointsDelta: 5, // sq-a gets +10 -> liveGameweekPoints = 10
    occurredAtMs: Date.now(),
  });

  // Official post-GW calculation includes +6 auto-sub points for sq-b and +3 bonus for sq-a
  const officialScores = new Map<string, number>([
    ["sq-a", 16],
    ["sq-b", 6],
  ]);

  const summary = service.reconcileWithOfficialScores(
    "league-reconcile",
    5,
    officialScores
  );

  assert.equal(summary.checkedSquads, 2);
  assert.equal(summary.driftedSquads.length, 2);

  const standings = service.getLeagueStandings("league-reconcile");
  assert.equal(standings[0].squadId, "sq-a");
  assert.equal(standings[0].liveGameweekPoints, 16);
  assert.equal(standings[1].squadId, "sq-b");
  assert.equal(standings[1].liveGameweekPoints, 6);
});
