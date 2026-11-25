/**
 * Dedicated Web Worker for Monte Carlo League Simulations
 *
 * Runs 1,000+ iterations of league standings projections off-thread to maintain
 * 60fps UI responsiveness. Provides:
 * - Title win probabilities
 * - H2H matchup probabilities
 * - Projected standing distributions
 * - Expected points (xP) computations
 */

import { simulateLeague, SimulationOptions, SimulationResult } from "../lib/simulation/monteCarloEngine";

export interface MonteCarloWorkerRequest {
  id: string;
  type: "SIMULATE_LEAGUE" | "SIMULATE_MATCHUPS" | "CALCULATE_PROBABILITIES";
  payload: any;
}

export interface MonteCarloWorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  durationMs: number;
  iterationsCompleted?: number;
}

self.onmessage = (event: MessageEvent<MonteCarloWorkerRequest>) => {
  const { id, type, payload } = event.data;
  const start = performance.now();

  try {
    let resultData: any;

    switch (type) {
      case "SIMULATE_LEAGUE": {
        const {
          managers,
          remainingFixtures,
          currentGameweek,
          totalGameweeks,
          iterations,
          fixtureStrengths,
          playerStats,
        } = payload;

        const options: SimulationOptions = {
          iterations,
          currentGameweek,
          totalGameweeks,
          fixtureStrengths: fixtureStrengths || {},
          playerStats: playerStats || {},
        };

        resultData = simulateLeague(managers, remainingFixtures, options);
        break;
      }

      case "SIMULATE_MATCHUPS": {
        const {
          manager1,
          manager2,
          remainingFixtures,
          currentGameweek,
          totalGameweeks,
          iterations,
          fixtureStrengths,
          playerStats,
        } = payload;

        const options: SimulationOptions = {
          iterations,
          currentGameweek,
          totalGameweeks,
          fixtureStrengths: fixtureStrengths || {},
          playerStats: playerStats || {},
        };

        resultData = simulateMatchups(
          manager1,
          manager2,
          remainingFixtures,
          options
        );
        break;
      }

      case "CALCULATE_PROBABILITIES": {
        const { simulationResult } = payload;
        resultData = calculateWinProbabilities(simulationResult);
        break;
      }

      default:
        throw new Error(`Unknown Monte Carlo action: ${type}`);
    }

    const durationMs = performance.now() - start;
    self.postMessage({
      id,
      success: true,
      data: resultData,
      durationMs,
    } as MonteCarloWorkerResponse);
  } catch (err) {
    const durationMs = performance.now() - start;
    self.postMessage({
      id,
      success: false,
      error: (err as Error).message,
      durationMs,
    } as MonteCarloWorkerResponse);
  }
};

/**
 * Simulate H2H matchups between two managers across remaining gameweeks
 */
function simulateMatchups(
  manager1: any,
  manager2: any,
  remainingFixtures: any[],
  options: SimulationOptions
) {
  const wins = { manager1: 0, manager2: 0, draws: 0 };
  
  for (let i = 0; i < options.iterations; i++) {
    let m1Points = manager1.currentPoints;
    let m2Points = manager2.currentPoints;

    for (const fixture of remainingFixtures) {
      const m1Points_gw = simulateGameweekPoints(manager1, fixture, options);
      const m2Points_gw = simulateGameweekPoints(manager2, fixture, options);
      
      m1Points += m1Points_gw;
      m2Points += m2Points_gw;
    }

    if (m1Points > m2Points) {
      wins.manager1++;
    } else if (m2Points > m1Points) {
      wins.manager2++;
    } else {
      wins.draws++;
    }
  }

  return {
    manager1WinProbability: wins.manager1 / options.iterations,
    manager2WinProbability: wins.manager2 / options.iterations,
    drawProbability: wins.draws / options.iterations,
    totalSimulations: options.iterations,
  };
}

/**
 * Simulate a single gameweek's points for a manager
 */
function simulateGameweekPoints(
  manager: any,
  fixture: any,
  options: SimulationOptions
): number {
  let points = 0;

  // Get squad for this gameweek
  const squad = manager.squad || manager.players;
  if (!squad) return 0;

  for (const player of squad) {
    // Skip if player not in remaining fixtures
    const playerFixtures = getPlayerFixtures(player, fixture, options);
    if (playerFixtures.length === 0) continue;

    // Simulate player performance
    const playerPoints = simulatePlayerPerformance(
      player,
      playerFixtures[0],
      options
    );
    
    // Apply captain/vice-captain multiplier
    if (player.isCaptain) {
      points += playerPoints * 2;
    } else if (player.isViceCaptain) {
      points += playerPoints * 1.5;
    } else if (player.isStarter) {
      points += playerPoints;
    }
    // Bench players not scored by default (auto-sub handled separately)
  }

  return Math.max(0, points);
}

/**
 * Simulate a single player's points in a fixture
 */
function simulatePlayerPerformance(
  player: any,
  fixture: any,
  options: SimulationOptions
): number {
  const playerStats = options.playerStats[player.id] || {};
  const fixtureStrength = options.fixtureStrengths[fixture.id] || 1;

  // Expected points (xP) as baseline
  const expectedPoints = playerStats.xP || 0;

  // Add variance based on historical standard deviation
  const stdDev = playerStats.stdDev || expectedPoints * 0.5;
  const variance = gaussianRandom() * stdDev;

  // Apply fixture difficulty multiplier
  let difficulty = 1;
  if (fixture.difficulty) {
    // FDR: 1-5 scale, map to 0.7x - 1.2x
    difficulty = 0.7 + (6 - fixture.difficulty) * 0.1;
  }

  const points = (expectedPoints + variance) * difficulty * fixtureStrength;
  return Math.max(0, Math.round(points * 10) / 10);
}

/**
 * Box-Muller transform for Gaussian random numbers
 */
function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z0;
}

/**
 * Get fixtures for a player in the current gameweek
 */
function getPlayerFixtures(
  player: any,
  fixture: any,
  options: SimulationOptions
): any[] {
  if (!player.team || !fixture) return [];
  
  const isPlaying =
    player.team.id === fixture.homeTeamId ||
    player.team.id === fixture.awayTeamId;

  return isPlaying ? [fixture] : [];
}

/**
 * Calculate win probabilities from simulation result
 */
function calculateWinProbabilities(result: SimulationResult) {
  const managerIds = Object.keys(result.standings[0]);
  const probabilities: Record<string, number> = {};

  // Count how many times each manager finished in each position
  const finishPositions: Record<string, number[]> = {};
  
  for (const managerId of managerIds) {
    finishPositions[managerId] = Array(managerIds.length).fill(0);
  }

  for (const standing of result.standings) {
    const sorted = Object.entries(standing)
      .sort(([, a], [, b]) => (b as any) - (a as any))
      .map(([id]) => id);

    sorted.forEach((id, rank) => {
      finishPositions[id][rank]++;
    });
  }

  // Calculate probabilities
  for (const managerId of managerIds) {
    const positions = finishPositions[managerId];
    probabilities[managerId] = positions[0] / result.standings.length;
  }

  return probabilities;
}
