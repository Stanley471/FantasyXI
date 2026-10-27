import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  FixtureReschedulingReconciler,
  FixtureChangeInput,
} from "../services/fpl/fixtureReschedulingReconciler.js";

describe("Resilient FPL Fixture Rescheduling & Double Gameweek Split Recalculator (#340)", () => {
  let mockDb: any;
  let gameweeks: any[];
  let fixtures: any[];
  let playerStats: any[];
  let squads: any[];
  let squadScores: any[];
  let adjustmentLogs: any[];

  beforeEach(() => {
    // Setup mock database fixtures
    gameweeks = [
      { id: 101, fplId: 10, isFinished: true, settledAt: new Date("2026-09-01") }, // Completed / Settled
      { id: 102, fplId: 11, isFinished: false, settledAt: null }, // Active Gameweek A
      { id: 103, fplId: 12, isFinished: false, settledAt: null }, // Active Gameweek B
    ];

    fixtures = [
      {
        id: 501,
        fplId: 1001,
        gameweekId: 102, // currently in GW 11
        gameweek: { id: 102, fplId: 11 },
        homeTeamId: 1,
        awayTeamId: 2,
        homeTeam: { id: 1, fplId: 1 }, // Team 1 (Chelsea)
        awayTeam: { id: 2, fplId: 2 }, // Team 2 (Arsenal)
        kickoffTime: new Date("2026-10-15T15:00:00Z"),
      },
      {
        id: 502,
        fplId: 1002,
        gameweekId: 103, // already in GW 12
        gameweek: { id: 103, fplId: 12 },
        homeTeamId: 1, // Team 1 (Chelsea)
        awayTeamId: 3, // Team 3 (Liverpool)
        homeTeam: { id: 1, fplId: 1 },
        awayTeam: { id: 3, fplId: 3 },
        kickoffTime: new Date("2026-10-22T15:00:00Z"),
      },
      {
        id: 500,
        fplId: 1000,
        gameweekId: 101, // in Completed GW 10
        gameweek: { id: 101, fplId: 10 },
        homeTeamId: 4,
        awayTeamId: 5,
        homeTeam: { id: 4, fplId: 4 },
        awayTeam: { id: 5, fplId: 5 },
        kickoffTime: new Date("2026-09-01T15:00:00Z"),
      },
    ];

    playerStats = [
      { id: "stat-1", playerId: 10, fixtureId: 501, gameweekId: 102, minutes: 90, totalPoints: 8 },
      { id: "stat-2", playerId: 10, fixtureId: 502, gameweekId: 103, minutes: 85, totalPoints: 6 },
    ];

    squads = [{ id: "squad-1", userId: "user-1", players: [] }];
    squadScores = [{ squadId: "squad-1", gameweekId: 102, points: 55, totalPoints: 55 }];
    adjustmentLogs = [];

    mockDb = {
      gameweek: {
        findMany: async () => [...gameweeks],
      },
      fixture: {
        findMany: async () => [...fixtures],
        update: async ({ where, data }: any) => {
          const f = fixtures.find((item) => item.id === where.id);
          if (f) Object.assign(f, data);
          return f;
        },
      },
      playerGameweekStats: {
        findMany: async () => [...playerStats],
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (const s of playerStats) {
            if (s.fixtureId === where.fixtureId) {
              Object.assign(s, data);
              count++;
            }
          }
          return { count };
        },
      },
      squad: {
        findMany: async () => [...squads],
      },
      squadGameweekScore: {
        findUnique: async ({ where }: any) => {
          return squadScores.find(
            (s) =>
              s.squadId === where.squadId_gameweekId.squadId &&
              s.gameweekId === where.squadId_gameweekId.gameweekId
          );
        },
        upsert: async ({ create, update, where }: any) => {
          const existing = squadScores.find(
            (s) =>
              s.squadId === where.squadId_gameweekId.squadId &&
              s.gameweekId === where.squadId_gameweekId.gameweekId
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          squadScores.push(create);
          return create;
        },
      },
      scoreAdjustmentLog: {
        create: async ({ data }: any) => {
          adjustmentLogs.push(data);
          return { id: "log-1", ...data };
        },
      },
    };

    const mockScoringService = {
      calculateAndPersistSquadScore: async (squadId: string, gameweekId: number) => {
        return {
          squadId,
          gameweekId,
          totalPoints: 62,
          startingPoints: 58,
          benchPoints: 4,
          captainPoints: 12,
          transferCost: 0,
          chip: null,
          lineupDetails: [],
        };
      },
    };

    (globalThis as any).__mockScoring = mockScoringService;
  });

  describe("Double Gameweek (DGW) Detection & Fixture Re-association", () => {
    it("detects rescheduled fixture moving into GW 12 creating a Double Gameweek for Chelsea", async () => {
      const reconciler = new FixtureReschedulingReconciler(mockDb, (globalThis as any).__mockScoring);

      // Fixture 1001 (Chelsea vs Arsenal) is postponed from GW 11 to GW 12
      // In GW 12, Chelsea already plays Liverpool (Fixture 1002)
      // Thus, GW 12 becomes a Double Gameweek for Chelsea (Team 1)
      const incoming: FixtureChangeInput[] = [
        {
          fplId: 1001,
          homeTeamFplId: 1, // Chelsea
          awayTeamFplId: 2, // Arsenal
          gameweekFplId: 12, // Moved to GW 12!
          kickoffTime: new Date("2026-10-24T18:00:00Z"),
        },
        {
          fplId: 1002,
          homeTeamFplId: 1,
          awayTeamFplId: 3,
          gameweekFplId: 12, // Still in GW 12
          kickoffTime: new Date("2026-10-22T15:00:00Z"),
        },
      ];

      const report = await reconciler.reconcileFixtureChanges(incoming);

      assert.equal(report.rescheduledCount, 1);
      assert.equal(report.rescheduledFixtures.length, 1);
      const rescheduled = report.rescheduledFixtures[0];
      assert.equal(rescheduled.fixtureFplId, 1001);
      assert.equal(rescheduled.fromGameweekFplId, 11);
      assert.equal(rescheduled.toGameweekFplId, 12);
      assert.equal(rescheduled.isDoubleGameweek, true);

      // Verify double gameweek teams
      assert.ok(report.doubleGameweekTeams.has(12));
      assert.ok(report.doubleGameweekTeams.get(12)!.has(1), "Team 1 must be marked as DGW in GW 12");

      // Verify fixture was updated in database to local gameweekId 103 (GW 12)
      const updatedFixture = fixtures.find((f) => f.id === 501);
      assert.equal(updatedFixture.gameweekId, 103);

      // Verify stats for this fixture were migrated to local gameweekId 103
      const updatedStat = playerStats.find((s) => s.fixtureId === 501);
      assert.equal(updatedStat.gameweekId, 103);
    });
  });

  describe("Player Point Aggregation across Double Gameweeks", () => {
    it("accumulates points and minutes across multiple fixtures in a double gameweek", () => {
      // Cole Palmer (playerId: 10) playing 2 fixtures in GW 12
      const dgwStats = [
        {
          playerId: 10,
          fixtureId: 501,
          minutes: 90,
          goals: 1,
          assists: 1,
          cleanSheet: false,
          bonus: 2,
          totalPoints: 10,
        },
        {
          playerId: 10,
          fixtureId: 502,
          minutes: 85,
          goals: 2,
          assists: 0,
          cleanSheet: true,
          bonus: 3,
          totalPoints: 14,
        },
      ];

      const aggregated = FixtureReschedulingReconciler.aggregateDoubleGameweekStats(dgwStats);
      const player10 = aggregated.get(10);

      assert.ok(player10);
      assert.equal(player10.fixtureCount, 2, "Player should have 2 fixtures recorded");
      assert.equal(player10.minutes, 175, "Minutes should be 90 + 85 = 175");
      assert.equal(player10.totalPoints, 24, "Total points should be 10 + 14 = 24");
    });
  });

  describe("Protection of Historical Settled Gameweeks", () => {
    it("strictly refuses to modify or corrupt previously settled gameweeks", async () => {
      const reconciler = new FixtureReschedulingReconciler(mockDb, (globalThis as any).__mockScoring);

      // Attempting to move fixture 1000 from completed GW 10 (id: 101, isFinished: true, settledAt: Date)
      const incoming: FixtureChangeInput[] = [
        {
          fplId: 1000,
          homeTeamFplId: 4,
          awayTeamFplId: 5,
          gameweekFplId: 12, // Retroactive reschedule
        },
      ];

      const report = await reconciler.reconcileFixtureChanges(incoming);

      // Settled Gameweek 101 must be tracked as SKIPPED
      assert.ok(
        report.skippedSettledGameweekIds.includes(101),
        "Settled gameweek 101 must be skipped from recalculation"
      );
      assert.ok(
        !report.recalculatedGameweekIds.includes(101),
        "Settled gameweek 101 must NOT be recalculated"
      );
    });
  });

  describe("Blank Gameweek & Unscheduled Postponements", () => {
    it("handles indefinite postponements by setting gameweekId to null and recalculating affected active GW", async () => {
      const reconciler = new FixtureReschedulingReconciler(mockDb, (globalThis as any).__mockScoring);

      // Fixture 1001 postponed indefinitely (e.g. weather / cup conflict)
      const incoming: FixtureChangeInput[] = [
        {
          fplId: 1001,
          homeTeamFplId: 1,
          awayTeamFplId: 2,
          gameweekFplId: null,
          postponed: true,
        },
      ];

      const report = await reconciler.reconcileFixtureChanges(incoming);

      assert.equal(report.rescheduledCount, 1);
      assert.equal(report.rescheduledFixtures[0].toGameweekFplId, null);

      const f = fixtures.find((item) => item.id === 501);
      assert.equal(f.gameweekId, null);
      assert.ok(report.recalculatedGameweekIds.includes(102), "Active GW 102 must be recalculated");
    });
  });
});
