import { SquadPlayer, Player } from '@prisma/client';

/**
 * Configuration for bench ghosting signal detection.
 * Controls statistical significance thresholds and weights.
 */
export interface BenchGhostingConfig {
  /** Minimum occurrences of mirroring pattern to be suspicious */
  minOccurrences: number;
  /** P-value threshold for statistical significance (e.g., 0.05 = 95% confidence) */
  maxChanceByIndependence: number;
  /** Weight for captain choice mirroring */
  captainMirrorWeight: number;
  /** Weight for bench order ghosting (benching a high scorer) */
  benchGhostWeight: number;
}

/**
 * Default configuration for bench ghosting detection.
 */
export const DEFAULT_BENCH_GHOSTING_CONFIG: BenchGhostingConfig = {
  minOccurrences: 3,
  maxChanceByIndependence: 0.05,
  captainMirrorWeight: 0.7,
  benchGhostWeight: 0.9,
};

/**
 * Represents a squad's lineup for a gameweek.
 */
export interface SquadLineup {
  gameweekId: number;
  captainPlayerId: number;
  viceCaptainPlayerId: number;
  benchOrder: number[]; // Player IDs in bench order
}

/**
 * A single mirroring event.
 */
export interface MirroringEvent {
  gameweekId: number;
  pattern: 'captain_mirror' | 'bench_mirror' | 'point_sacrifice';
  squadAPlayerId: number;
  squadBPlayerId: number;
  details: Record<string, unknown>;
}

/**
 * Evidence for a bench ghosting signal.
 */
export interface BenchGhostingEvidence {
  score: number;
  events: MirroringEvent[];
  totalOccurrences: number;
  probabilityByChance: number; // P-value
  config: BenchGhostingConfig;
  notes?: string;
}

/**
 * Binomial cumulative distribution function (normal approximation).
 * P(X <= k) where X ~ Binomial(n, p).
 * Used to compute the probability of observing k or more successes by chance.
 */
function binomialCdf(n: number, p: number, k: number): number {
  // For large n, use normal approximation
  if (n > 30) {
    const mean = n * p;
    const stdDev = Math.sqrt(n * p * (1 - p));
    const z = (k - mean) / stdDev;
    // Cumulative standard normal: approximate with erf
    return 0.5 * (1 + erf(z / Math.sqrt(2)));
  }

  // For small n, use recursive binomial
  let prob = 0;
  for (let i = 0; i <= k; i++) {
    prob += binomialProb(n, p, i);
  }
  return prob;
}

/**
 * Binomial probability mass function.
 * P(X = k) where X ~ Binomial(n, p).
 */
function binomialProb(n: number, p: number, k: number): number {
  if (k > n || k < 0) return 0;
  const comb = combination(n, k);
  return comb * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

/**
 * Combination: n! / (k! * (n-k)!)
 */
function combination(n: number, k: number): number {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;

  let result = 1;
  for (let i = 0; i < k; i++) {
    result *= (n - i) / (i + 1);
  }
  return result;
}

/**
 * Error function (approximation).
 */
function erf(x: number): number {
  // Approximation of error function using Abramowitz and Stegun
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1 / (1 + p * x);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  return sign * (1 - (((a5 * t5 + a4 * t4) * t3 + a3 * t3 + a2 * t2 + a1 * t) * Math.exp(-x * x)));
}

/**
 * Check if two squads have captain mirror (both selected same player as captain).
 */
function isCaptainMirror(lineupA: SquadLineup, lineupB: SquadLineup): boolean {
  return lineupA.captainPlayerId === lineupB.captainPlayerId && lineupA.captainPlayerId !== 0;
}

/**
 * Check if two bench orders have significant overlap (similar benching patterns).
 */
function isBenchMirror(lineupA: SquadLineup, lineupB: SquadLineup): boolean {
  if (lineupA.benchOrder.length < 2 || lineupB.benchOrder.length < 2) return false;

  // Check overlap in top 3 bench players
  const topBenchA = new Set(lineupA.benchOrder.slice(0, 3));
  const topBenchB = lineupB.benchOrder.slice(0, 3);
  const overlap = topBenchB.filter((p) => topBenchA.has(p)).length;

  return overlap >= 2; // At least 2 of top 3 bench players match
}

/**
 * Check if a squad is sacrificing points (benching a high-scoring player).
 * This requires gameweek scores to evaluate, so it's simplified here.
 * In practice, you'd compare final points vs. potential points.
 */
function isPointSacrifice(_lineupA: SquadLineup, _lineupB: SquadLineup): boolean {
  // Simplified: requires external scoring data not available in this signature.
  // Returns false by default.
  return false;
}

/**
 * Compute bench ghosting signal between two accounts.
 * Detects captain mirroring, bench order similarity, and point sacrifice patterns.
 *
 * @param lineupsA Gameweek lineups for account A
 * @param lineupsB Gameweek lineups for account B
 * @param gameweekRange Gameweek range to analyze
 * @param config Signal configuration
 * @returns {score, evidence} tuple
 */
export function computeBenchGhostingScore(
  lineupsA: SquadLineup[],
  lineupsB: SquadLineup[],
  gameweekRange: { startGW: number; endGW: number },
  config: BenchGhostingConfig = DEFAULT_BENCH_GHOSTING_CONFIG
): { score: number; evidence: BenchGhostingEvidence } {
  // Filter to gameweek range
  const filteredA = lineupsA.filter((l) => l.gameweekId >= gameweekRange.startGW && l.gameweekId <= gameweekRange.endGW);
  const filteredB = lineupsB.filter((l) => l.gameweekId >= gameweekRange.startGW && l.gameweekId <= gameweekRange.endGW);

  // Build a map of lineups by gameweek for easy lookup
  const lineupsAMap = new Map(filteredA.map((l) => [l.gameweekId, l]));
  const lineupsBMap = new Map(filteredB.map((l) => [l.gameweekId, l]));

  const events: MirroringEvent[] = [];

  // Find common gameweeks
  for (const [gwId, lineupA] of lineupsAMap.entries()) {
    const lineupB = lineupsBMap.get(gwId);
    if (!lineupB) continue;

    // Check captain mirror
    if (isCaptainMirror(lineupA, lineupB)) {
      events.push({
        gameweekId: gwId,
        pattern: 'captain_mirror',
        squadAPlayerId: lineupA.captainPlayerId,
        squadBPlayerId: lineupB.captainPlayerId,
        details: {
          weight: config.captainMirrorWeight,
          coincidence: 'Both chose same captain',
        },
      });
    }

    // Check bench mirror
    if (isBenchMirror(lineupA, lineupB)) {
      events.push({
        gameweekId: gwId,
        pattern: 'bench_mirror',
        squadAPlayerId: lineupA.benchOrder[0] ?? 0,
        squadBPlayerId: lineupB.benchOrder[0] ?? 0,
        details: {
          weight: config.benchGhostWeight * 0.5, // Half weight for bench (less coordinated)
          coincidence: 'Similar bench orders',
        },
      });
    }

    // Check point sacrifice (simplified)
    if (isPointSacrifice(lineupA, lineupB)) {
      events.push({
        gameweekId: gwId,
        pattern: 'point_sacrifice',
        squadAPlayerId: 0,
        squadBPlayerId: 0,
        details: {
          weight: config.benchGhostWeight,
          coincidence: 'Potential point sacrifice pattern',
        },
      });
    }
  }

  // Compute statistical significance
  let score = 0;
  let pValue = 1.0;

  if (events.length >= config.minOccurrences) {
    // Model as binomial: probability of n independent mirroring events
    // Assuming base rate of mirroring is ~1/(number of possible captains/benches)
    // Rough estimate: 1/15 chance of captain mirror by coincidence
    const baseRate = 1 / 15;
    const n = lineupsAMap.size; // Number of gameweeks compared
    const k = events.length; // Number of mirroring events

    pValue = 1 - binomialCdf(n, baseRate, k - 1); // P(X >= k)
    score = Math.max(0, 1 - pValue);
  }

  const evidence: BenchGhostingEvidence = {
    score,
    events,
    totalOccurrences: events.length,
    probabilityByChance: pValue,
    config,
    notes:
      events.length >= config.minOccurrences && pValue < config.maxChanceByIndependence
        ? `Detected ${events.length} mirroring events over ${lineupsAMap.size} gameweeks (p=${pValue.toFixed(4)}). Statistical significance: ${(1 - pValue).toFixed(2)}.`
        : events.length > 0
          ? `Detected ${events.length} mirroring events, but below threshold for statistical significance.`
          : undefined,
  };

  return { score, evidence };
}

/**
 * Compute bench ghosting signal in batch for multiple account pairs.
 *
 * @param pairs Account pairs with their lineups
 * @param gameweekRange Gameweek range to analyze
 * @param config Signal configuration
 * @returns Array of {score, evidence} tuples
 */
export function computeBenchGhostingScoreBatch(
  pairs: Array<{
    lineupsA: SquadLineup[];
    lineupsB: SquadLineup[];
  }>,
  gameweekRange: { startGW: number; endGW: number },
  config: BenchGhostingConfig = DEFAULT_BENCH_GHOSTING_CONFIG
): Array<{ score: number; evidence: BenchGhostingEvidence }> {
  return pairs.map(({ lineupsA, lineupsB }) =>
    computeBenchGhostingScore(lineupsA, lineupsB, gameweekRange, config)
  );
}
