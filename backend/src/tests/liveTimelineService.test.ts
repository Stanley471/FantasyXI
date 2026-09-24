import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LiveTimelineService } from "../services/live/liveTimelineService.js";

function createMockDb() {
  const gameweek = {
    id: 1,
    fplId: 1,
    name: "Gameweek 1",
    isCurrent: true,
    isFinished: false,
  };

  const fixtures = [
    {
      id: 10,
      gameweekId: 1,
      homeTeamId: 1,
      awayTeamId: 2,
      homeScore: 2,
      awayScore: 1,
      minutes: 75,
      started: true,
      finished: false,
      kickoffTime: new Date("2026-09-24T12:30:00Z"),
      homeTeam: { id: 1, name: "Arsenal", shortName: "ARS" },
      awayTeam: { id: 2, name: "Chelsea", shortName: "CHE" },
    },
  ];

  const playerStats = [
    {
      id: 101,
      playerId: 11,
      gameweekId: 1,
      minutes: 75,
      goals: 1,
      assists: 1,
      yellowCards: 0,
      redCards: 0,
      saves: 0,
      bonus: 3,
      totalPoints: 12,
      player: {
        id: 11,
        fplId: 501,
        displayName: "Saka",
        position: "MID",
        teamId: 1,
        team: { id: 1, name: "Arsenal", shortName: "ARS" },
      },
    },
    {
      id: 102,
      playerId: 12,
      gameweekId: 1,
      minutes: 75,
      goals: 0,
      assists: 0,
      yellowCards: 1,
      redCards: 0,
      saves: 0,
      bonus: 0,
      totalPoints: 1,
      player: {
        id: 12,
        fplId: 502,
        displayName: "Enzo",
        position: "MID",
        teamId: 2,
        team: { id: 2, name: "Chelsea", shortName: "CHE" },
      },
    },
    {
      id: 103,
      playerId: 13,
      gameweekId: 1,
      minutes: 75,
      goals: 0,
      assists: 0,
      yellowCards: 0,
      redCards: 0,
      saves: 5,
      bonus: 0,
      totalPoints: 3,
      player: {
        id: 13,
        fplId: 503,
        displayName: "Raya",
        position: "GKP",
        teamId: 1,
        team: { id: 1, name: "Arsenal", shortName: "ARS" },
      },
    },
  ];

  const db: any = {
    gameweek: {
      findFirst: async ({ where }: any) => {
        const idMatches = where.OR.some(
          (cond: any) => cond.id === gameweek.id || cond.fplId === gameweek.fplId
        );
        return idMatches ? gameweek : null;
      },
    },
    fixture: {
      findMany: async () => fixtures,
    },
    playerGameweekStats: {
      findMany: async () => playerStats,
    },
  };

  return db;
}

describe("Live Timeline Service", () => {
  it("parses match events chronologically and maps them to fixtures", async () => {
    const db = createMockDb();
    const service = new LiveTimelineService(db);

    const timeline = await service.getGameweekTimeline(1);
    assert.ok(timeline);
    assert.equal(timeline.gameweek?.id, 1);
    assert.equal(timeline.fixtures.length, 1);
    assert.equal(timeline.fixtures[0].homeTeam, "ARS");
    assert.equal(timeline.fixtures[0].awayTeam, "CHE");

    // Events parsed
    const eventTypes = timeline.events.map((e) => e.type);
    assert.ok(eventTypes.includes("GOAL"));
    assert.ok(eventTypes.includes("ASSIST"));
    assert.ok(eventTypes.includes("YELLOW_CARD"));
    assert.ok(eventTypes.includes("SAVE"));
    assert.ok(eventTypes.includes("BONUS"));

    // Check Saka's goal
    const goal = timeline.events.find((e) => e.type === "GOAL");
    assert.ok(goal);
    assert.equal(goal.playerName, "Saka");
    assert.equal(goal.teamShortName, "ARS");
    assert.equal(goal.pointsAwarded, 5); // MID goal = 5 pts

    // Check summary counters
    assert.equal(timeline.summary.totalGoals, 1);
    assert.equal(timeline.summary.totalAssists, 1);
    assert.equal(timeline.summary.totalYellowCards, 1);
    assert.equal(timeline.summary.totalBonus, 3);
    assert.equal(timeline.summary.totalSaves, 5);
  });

  it("returns null if gameweek does not exist", async () => {
    const db = createMockDb();
    const service = new LiveTimelineService(db);

    const timeline = await service.getGameweekTimeline(999);
    assert.equal(timeline, null);
  });
});
