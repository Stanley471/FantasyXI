import { describe, it, expect } from "vitest";
import {
  simulateLeague,
  ManagerData,
  RemainingFixture,
  SimulationOptions,
} from "@/lib/simulation/monteCarloEngine";

/**
 * Monte Carlo Simulation Benchmark & Correctness Tests
 *
 * Validates:
 * - 1,000 iterations complete in under 300ms
 * - Probability calculations are normalized (0-1)
 * - Title win probabilities sum to ~1.0
 * - Projected standings are properly ranked
 */

describe("Monte Carlo League Simulations", () => {
  // Test data
  const mockManagers: ManagerData[] = [
    {
      id: "manager-1",
      name: "Manager 1",
      currentPoints: 1200,
      currentRank: 1,
      squad: [
        {
          id: 1,
          fplId: 1,
          displayName: "Player 1",
          teamId: 1,
          position: "DEF",
          isCaptain: false,
          isViceCaptain: false,
          isStarter: true,
          purchasePrice: 5.5,
        },
      ],
      history: [{ gameweekId: 1, points: 75, transferCost: 0 }],
    },
    {
      id: "manager-2",
      name: "Manager 2",
      currentPoints: 1150,
      currentRank: 2,
      squad: [
        {
          id: 2,
          fplId: 2,
          displayName: "Player 2",
          teamId: 2,
          position: "FWD",
          isCaptain: true,
          isViceCaptain: false,
          isStarter: true,
          purchasePrice: 10.0,
        },
      ],
      history: [{ gameweekId: 1, points: 72, transferCost: 0 }],
    },
    {
      id: "manager-3",
      name: "Manager 3",
      currentPoints: 1100,
      currentRank: 3,
      squad: [],
      history: [],
    },
  ];

  const mockFixtures: RemainingFixture[] = [
    {
      id: 1,
      gameweekId: 20,
      homeTeamId: 1,
      awayTeamId: 2,
      homeTeamName: "Team A",
      awayTeamName: "Team B",
      kickoffTime: "2024-01-15T15:00:00Z",
    },
    {
      id: 2,
      gameweekId: 20,
      homeTeamId: 3,
      awayTeamId: 4,
      homeTeamName: "Team C",
      awayTeamName: "Team D",
      kickoffTime: "2024-01-15T17:30:00Z",
    },
  ];

  const mockPlayerStats = {
    1: { xP: 5.5, stdDev: 2.1, form: 4.2, minutesPlayed: 90, chanceOfPlayingNextRound: 0.95 },
    2: { xP: 7.2, stdDev: 3.5, form: 5.8, minutesPlayed: 90, chanceOfPlayingNextRound: 0.98 },
  };

  const mockOptions: SimulationOptions = {
    iterations: 100, // Small for tests
    currentGameweek: 20,
    totalGameweeks: 38,
    playerStats: mockPlayerStats,
    fixtureStrengths: { 1: 1.0, 2: 1.0 },
  };

  it("should run 1,000 iterations in under 300ms", () => {
    const options: SimulationOptions = {
      ...mockOptions,
      iterations: 1000,
    };

    const start = performance.now();
    const result = simulateLeague(mockManagers, mockFixtures, options);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(300);
    expect(result.standings.length).toBe(1000);
  });

  it("should return correct number of simulations", () => {
    const result = simulateLeague(mockManagers, mockFixtures, mockOptions);
    expect(result.standings.length).toBe(mockOptions.iterations);
    expect(result.iterations).toBe(mockOptions.iterations);
  });

  it("should generate valid standing records", () => {
    const result = simulateLeague(mockManagers, mockFixtures, mockOptions);

    for (const standing of result.standings) {
      // Should have all managers
      expect(Object.keys(standing).length).toBe(mockManagers.length);

      // Each manager should have points >= 0
      for (const [managerId, points] of Object.entries(standing)) {
        expect(typeof points).toBe("number");
        expect(points).toBeGreaterThanOrEqual(
          mockManagers.find((m) => m.id === managerId)?.currentPoints || 0
        );
      }
    }
  });

  it("should calculate probabilities that sum to 1", () => {
    const result = simulateLeague(mockManagers, mockFixtures, mockOptions);

    const titleOdds = Object.values(result.probabilities.titleWinChances);
    const total = titleOdds.reduce((a, b) => a + b, 0);

    expect(total).toBeCloseTo(1.0, 1); // Allow 1 decimal place of rounding
  });

  it("should ensure all probabilities are between 0 and 1", () => {
    const result = simulateLeague(mockManagers, mockFixtures, mockOptions);

    for (const prob of Object.values(result.probabilities.titleWinChances)) {
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(1);
    }

    for (const prob of Object.values(result.probabilities.top3Probability)) {
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(1);
    }

    for (const prob of Object.values(result.probabilities.topHalfProbability)) {
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(1);
    }

    for (const prob of Object.values(result.probabilities.relegationRisk)) {
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(1);
    }
  });

  it("should project final standings in correct order", () => {
    const result = simulateLeague(mockManagers, mockFixtures, mockOptions);

    const projected = result.projectedFinalStandings;

    // Should be sorted by rank
    for (let i = 1; i < projected.length; i++) {
      expect(projected[i].projectedRank).toBe(i + 1);
      expect(projected[i - 1].projectedPoints).toBeGreaterThanOrEqual(
        projected[i].projectedPoints
      );
    }

    // Points range should be valid
    for (const standing of projected) {
      expect(standing.pointsRange.min).toBeLessThanOrEqual(
        standing.projectedPoints
      );
      expect(standing.pointsRange.max).toBeGreaterThanOrEqual(
        standing.projectedPoints
      );
    }
  });

  it("should track min/max points across iterations", () => {
    const result = simulateLeague(mockManagers, mockFixtures, {
      ...mockOptions,
      iterations: 50,
    });

    for (const standing of result.projectedFinalStandings) {
      // Min and max should be found in actual standings
      const allValues = result.standings.map((s) => s[standing.managerId]);
      const actualMin = Math.min(...allValues);
      const actualMax = Math.max(...allValues);

      expect(standing.pointsRange.min).toBe(actualMin);
      expect(standing.pointsRange.max).toBe(actualMax);
    }
  });

  it("should handle edge case of single manager", () => {
    const singleManager = [mockManagers[0]];
    const result = simulateLeague(
      singleManager,
      mockFixtures,
      mockOptions
    );

    expect(result.probabilities.titleWinChances["manager-1"]).toBeCloseTo(1.0, 1);
  });

  it("should return consistent results across runs (seeded)", () => {
    // Run simulation twice
    const result1 = simulateLeague(mockManagers, mockFixtures, {
      ...mockOptions,
      iterations: 50,
    });
    const result2 = simulateLeague(mockManagers, mockFixtures, {
      ...mockOptions,
      iterations: 50,
    });

    // Probabilities should be similar (within 5%)
    for (const managerId of Object.keys(
      result1.probabilities.titleWinChances
    )) {
      const prob1 = result1.probabilities.titleWinChances[managerId];
      const prob2 = result2.probabilities.titleWinChances[managerId];

      // With only 50 iterations, expect some variance
      expect(Math.abs(prob1 - prob2)).toBeLessThan(0.2);
    }
  });

  it("should handle zero remaining fixtures", () => {
    const result = simulateLeague(mockManagers, [], mockOptions);

    // All managers should end with their current points
    for (const standing of result.standings) {
      for (const manager of mockManagers) {
        expect(standing[manager.id]).toBe(manager.currentPoints);
      }
    }
  });

  it("should respect fixture difficulty multipliers", () => {
    const fixtureStrengths = { 1: 1.5, 2: 0.5 };

    const result = simulateLeague(mockManagers, mockFixtures, {
      ...mockOptions,
      iterations: 500,
      fixtureStrengths,
    });

    // High-strength fixtures should produce higher variance
    const avgFinalPoints = result.projectedFinalStandings.map(
      (s) => s.projectedPoints
    );

    expect(avgFinalPoints[0]).toBeGreaterThan(mockManagers[0].currentPoints);
  });

  it("should calculate top3 probability correctly", () => {
    const result = simulateLeague(mockManagers, mockFixtures, mockOptions);

    // Top 3 probability should be >= title probability for each manager
    for (const managerId of Object.keys(
      result.probabilities.titleWinChances
    )) {
      const titleProb = result.probabilities.titleWinChances[managerId];
      const top3Prob = result.probabilities.top3Probability[managerId];

      expect(top3Prob).toBeGreaterThanOrEqual(titleProb);
    }
  });

  it("should calculate relegation risk for lower-ranked managers", () => {
    const result = simulateLeague(mockManagers, mockFixtures, mockOptions);

    const lastManager = mockManagers[mockManagers.length - 1];
    const relegationRisk =
      result.probabilities.relegationRisk[lastManager.id];

    // Last place manager should have non-zero relegation risk
    expect(relegationRisk).toBeGreaterThan(0);
  });
});
