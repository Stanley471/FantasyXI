import { describe, it, expect } from "vitest";
import {
  buildFixtureDifficultyMatrix,
  analyzeFixtureSwings,
  getHighImpactSwings,
  calculateTeamDifficultyScore,
  rankTeamsByFixtureDifficulty,
  getFixtureWindowSummary,
  getDifficultyColor,
  getDifficultyLabel,
  TeamFixture,
} from "@/lib/analytics/fixtureDifficultyAnalytics";
import { Team } from "@/types";

/**
 * Fixture Difficulty Analytics Tests
 *
 * Validates:
 * - Matrix building and filtering
 * - Difficulty scoring calculations
 * - Color coding for accessibility
 * - High-impact swing detection
 * - Team ranking by schedule difficulty
 */

describe("Fixture Difficulty Analytics", () => {
  const mockTeams: Team[] = [
    { id: 1, name: "Team A", shortName: "TMA", fplId: 1, logoUrl: null },
    { id: 2, name: "Team B", shortName: "TMB", fplId: 2, logoUrl: null },
    { id: 3, name: "Team C", shortName: "TMC", fplId: 3, logoUrl: null },
  ];

  const mockFixtures: TeamFixture[] = [
    // Team A fixtures
    {
      gameweekId: 20,
      gameweekName: "Gameweek 20",
      opponentTeamId: 2,
      opponentTeamName: "Team B",
      isHome: true,
      difficulty: 2,
      difficultyRating: "Easy",
    },
    {
      gameweekId: 21,
      gameweekName: "Gameweek 21",
      opponentTeamId: 3,
      opponentTeamName: "Team C",
      isHome: false,
      difficulty: 4,
      difficultyRating: "Hard",
    },
    {
      gameweekId: 22,
      gameweekName: "Gameweek 22",
      opponentTeamId: 1,
      opponentTeamName: "Team A",
      isHome: true,
      difficulty: 3,
      difficultyRating: "Medium",
    },
    // Team B fixtures
    {
      gameweekId: 20,
      gameweekName: "Gameweek 20",
      opponentTeamId: 1,
      opponentTeamName: "Team A",
      isHome: false,
      difficulty: 3,
      difficultyRating: "Medium",
    },
    {
      gameweekId: 21,
      gameweekName: "Gameweek 21",
      opponentTeamId: 1,
      opponentTeamName: "Team A",
      isHome: true,
      difficulty: 1,
      difficultyRating: "Very Easy",
    },
  ];

  describe("getDifficultyColor", () => {
    it("should return correct colors for difficulty ratings", () => {
      expect(getDifficultyColor(1)).toBe("#10b981"); // Emerald
      expect(getDifficultyColor(2)).toBe("#6ee7b7"); // Light Emerald
      expect(getDifficultyColor(3)).toBe("#f59e0b"); // Amber
      expect(getDifficultyColor(4)).toBe("#f87171"); // Light Red
      expect(getDifficultyColor(5)).toBe("#dc2626"); // Red
    });

    it("should handle out-of-range values", () => {
      expect(getDifficultyColor(0)).toBe("#e5e7eb"); // Gray
      expect(getDifficultyColor(6)).toBe("#e5e7eb"); // Gray
    });
  });

  describe("getDifficultyLabel", () => {
    it("should return correct labels", () => {
      expect(getDifficultyLabel(1)).toBe("Very Easy");
      expect(getDifficultyLabel(2)).toBe("Easy");
      expect(getDifficultyLabel(3)).toBe("Medium");
      expect(getDifficultyLabel(4)).toBe("Hard");
      expect(getDifficultyLabel(5)).toBe("Very Hard");
    });
  });

  describe("buildFixtureDifficultyMatrix", () => {
    it("should build matrix with correct gameweeks", () => {
      const matrix = buildFixtureDifficultyMatrix(
        mockFixtures,
        mockTeams,
        20,
        5
      );

      expect(matrix.gameweeks.length).toBeGreaterThan(0);
      expect(matrix.gameweeks[0].id).toBeGreaterThanOrEqual(20);
    });

    it("should include all teams", () => {
      const matrix = buildFixtureDifficultyMatrix(
        mockFixtures,
        mockTeams,
        20,
        5
      );

      expect(matrix.teams.length).toBe(mockTeams.length);
    });

    it("should populate cells for fixtures in window", () => {
      const matrix = buildFixtureDifficultyMatrix(
        mockFixtures,
        mockTeams,
        20,
        5
      );

      const teamACells = matrix.cells.filter((c) => c.teamId === 1);
      expect(teamACells.length).toBeGreaterThan(0);
    });

    it("should exclude fixtures outside window", () => {
      const matrix = buildFixtureDifficultyMatrix(
        mockFixtures,
        mockTeams,
        23,
        5
      );

      // All fixtures are 20-22, so nothing should be in window 23-28
      expect(matrix.cells.length).toBe(0);
    });

    it("should calculate average difficulty", () => {
      const matrix = buildFixtureDifficultyMatrix(
        mockFixtures,
        mockTeams,
        20,
        3
      );

      expect(matrix.averageDifficulty).toBeGreaterThan(0);
      expect(matrix.averageDifficulty).toBeLessThanOrEqual(5);
    });
  });

  describe("analyzeFixtureSwings", () => {
    it("should detect difficulty swings", () => {
      const swings = analyzeFixtureSwings(1, mockFixtures);

      expect(swings.length).toBeGreaterThan(0);
    });

    it("should identify harder/easier swings correctly", () => {
      // Team A: GW20=2 (Easy), GW21=4 (Hard), GW22=3 (Medium)
      const swings = analyzeFixtureSwings(1, mockFixtures);

      expect(swings[0].swingType).toBe("harder"); // 2 to 4
      expect(swings[1].swingType).toBe("easier"); // 4 to 3
    });

    it("should calculate impact scores", () => {
      const swings = analyzeFixtureSwings(1, mockFixtures);

      swings.forEach((swing) => {
        expect(swing.impactScore).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe("getHighImpactSwings", () => {
    it("should filter by impact threshold", () => {
      const swings = getHighImpactSwings(mockFixtures, mockTeams, 1.5);

      swings.forEach((swing) => {
        expect(swing.impactScore).toBeGreaterThanOrEqual(1.5);
      });
    });

    it("should include team information", () => {
      const swings = getHighImpactSwings(mockFixtures, mockTeams, 0);

      swings.forEach((swing) => {
        expect(swing.teamName).toBeDefined();
        expect(swing.teamId).toBeDefined();
      });
    });

    it("should sort by impact descending", () => {
      const swings = getHighImpactSwings(mockFixtures, mockTeams, 0);

      for (let i = 1; i < swings.length; i++) {
        expect(swings[i - 1].impactScore).toBeGreaterThanOrEqual(
          swings[i].impactScore
        );
      }
    });
  });

  describe("calculateTeamDifficultyScore", () => {
    it("should calculate average difficulty", () => {
      const score = calculateTeamDifficultyScore(
        1,
        mockFixtures,
        20,
        22
      );

      // Team A: (2 + 4 + 3) / 3 = 3
      expect(score).toBeCloseTo(3, 0.1);
    });

    it("should return 0 for team with no fixtures in window", () => {
      const score = calculateTeamDifficultyScore(
        999,
        mockFixtures,
        20,
        22
      );

      expect(score).toBe(0);
    });

    it("should respect window boundaries", () => {
      const score1 = calculateTeamDifficultyScore(
        1,
        mockFixtures,
        20,
        20
      );
      const score2 = calculateTeamDifficultyScore(
        1,
        mockFixtures,
        20,
        22
      );

      expect(score2).toBeGreaterThanOrEqual(score1);
    });
  });

  describe("rankTeamsByFixtureDifficulty", () => {
    it("should rank teams by difficulty score", () => {
      const ranked = rankTeamsByFixtureDifficulty(
        mockFixtures,
        mockTeams,
        20,
        22
      );

      expect(ranked.length).toBeGreaterThan(0);
      // Should be sorted ascending (easiest first)
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].difficultyScore).toBeLessThanOrEqual(
          ranked[i].difficultyScore
        );
      }
    });

    it("should include team information", () => {
      const ranked = rankTeamsByFixtureDifficulty(
        mockFixtures,
        mockTeams,
        20,
        22
      );

      ranked.forEach((item) => {
        expect(item.teamId).toBeDefined();
        expect(item.teamName).toBeDefined();
        expect(item.difficultyScore).toBeDefined();
      });
    });
  });

  describe("getFixtureWindowSummary", () => {
    it("should return summary statistics", () => {
      const summary = getFixtureWindowSummary(
        mockFixtures,
        mockTeams,
        20,
        22
      );

      expect(summary.windowStart).toBe(20);
      expect(summary.windowEnd).toBe(22);
      expect(summary.gameweekCount).toBe(3);
      expect(summary.averageDifficulty).toBeGreaterThan(0);
    });

    it("should identify easiest schedules", () => {
      const summary = getFixtureWindowSummary(
        mockFixtures,
        mockTeams,
        20,
        22
      );

      expect(summary.easiestSchedules.length).toBeGreaterThan(0);
    });

    it("should identify hardest schedules", () => {
      const summary = getFixtureWindowSummary(
        mockFixtures,
        mockTeams,
        20,
        22
      );

      expect(summary.hardestSchedules.length).toBeGreaterThan(0);
    });

    it("should track total fixtures", () => {
      const summary = getFixtureWindowSummary(
        mockFixtures,
        mockTeams,
        20,
        22
      );

      expect(summary.totalFixtures).toBeGreaterThan(0);
    });

    it("should handle empty window", () => {
      const summary = getFixtureWindowSummary(
        mockFixtures,
        mockTeams,
        50,
        55
      );

      expect(summary.averageDifficulty).toBe(0);
      expect(summary.totalFixtures).toBe(0);
    });
  });
});
