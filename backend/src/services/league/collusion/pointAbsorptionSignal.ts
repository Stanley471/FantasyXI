/**
 * Configuration for point absorption signal detection.
 * Controls correlation thresholds and minimum sample sizes.
 */
export interface PointAbsorptionConfig {
  /** Minimum Pearson correlation to flag (e.g., 0.6 = moderate correlation) */
  minCorrelation: number;
  /** Minimum gameweeks of data for statistical significance */
  minGameweeks: number;
}

/**
 * Default configuration for point absorption detection.
 */
export const DEFAULT_POINT_ABSORPTION_CONFIG: PointAbsorptionConfig = {
  minCorrelation: 0.6,
  minGameweeks: 10,
};

/**
 * Squad scores for a gameweek.
 */
export interface SquadGameweekScore {
  gameweekId: number;
  points: number;
  transferCost: number; // -4, -8, etc.
}

/**
 * Evidence for a point absorption event.
 */
export interface PointAbsorptionEvent {
  gameweekId: number;
  accountATransferCost: number;
  accountBGain: number;
  correlation: number;
}

/**
 * Evidence structure for point absorption signal.
 */
export interface PointAbsorptionEvidence {
  score: number;
  events: PointAbsorptionEvent[];
  pearsonCorrelation: number;
  config: PointAbsorptionConfig;
  notes?: string;
}

/**
 * Compute mean and standard deviation of an array.
 */
function stats(arr: number[]): { mean: number; stdDev: number } {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev };
}

/**
 * Compute Pearson correlation coefficient between two arrays.
 * Returns -1 to 1, with 0 indicating no correlation.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;

  const { mean: meanX, stdDev: stdDevX } = stats(x);
  const { mean: meanY, stdDev: stdDevY } = stats(y);

  if (stdDevX === 0 || stdDevY === 0) return 0; // No variance

  let covariance = 0;
  for (let i = 0; i < x.length; i++) {
    covariance += ((x[i] - meanX) * (y[i] - meanY)) / x.length;
  }

  return covariance / (stdDevX * stdDevY);
}

/**
 * Compute point absorption signal between two accounts.
 * Analyzes correlation between transfer costs (points lost) and rival's gains.
 *
 * The hypothesis: if account A repeatedly takes transfer hits at gameweeks
 * when account B scores high points, there might be collusion.
 *
 * In practice, this is a weak signal on its own, as transfer hits are often
 * strategic (chasing form, injury coverage, etc.). Requires combination
 * with other signals.
 *
 * @param scoresA Gameweek scores for account A
 * @param scoresB Gameweek scores for account B
 * @param gameweekRange Gameweek range to analyze
 * @param config Signal configuration
 * @returns {score, evidence} tuple
 */
export function computePointAbsorptionScore(
  scoresA: SquadGameweekScore[],
  scoresB: SquadGameweekScore[],
  gameweekRange: { startGW: number; endGW: number },
  config: PointAbsorptionConfig = DEFAULT_POINT_ABSORPTION_CONFIG
): { score: number; evidence: PointAbsorptionEvidence } {
  // Filter to gameweek range
  const filteredA = scoresA.filter(
    (s) => s.gameweekId >= gameweekRange.startGW && s.gameweekId <= gameweekRange.endGW
  );
  const filteredB = scoresB.filter(
    (s) => s.gameweekId >= gameweekRange.startGW && s.gameweekId <= gameweekRange.endGW
  );

  // Build maps for easy lookup
  const scoresAMap = new Map(filteredA.map((s) => [s.gameweekId, s]));
  const scoresBMap = new Map(filteredB.map((s) => [s.gameweekId, s]));

  // Find common gameweeks
  const commonGWs = Array.from(scoresAMap.keys()).filter((gw) => scoresBMap.has(gw));

  if (commonGWs.length < config.minGameweeks) {
    return {
      score: 0,
      evidence: {
        score: 0,
        events: [],
        pearsonCorrelation: 0,
        config,
        notes: `Insufficient gameweeks (${commonGWs.length} < ${config.minGameweeks}) for correlation analysis.`,
      },
    };
  }

  // Extract costs and gains
  const costs: number[] = [];
  const gains: number[] = [];
  const events: PointAbsorptionEvent[] = [];

  for (const gwId of commonGWs) {
    const scoreA = scoresAMap.get(gwId)!;
    const scoreB = scoresBMap.get(gwId)!;

    // Cost for A is negative (points deducted), so we use absolute value
    const costA = Math.abs(scoreA.transferCost);
    const gainB = scoreB.points;

    costs.push(costA);
    gains.push(gainB);

    if (costA > 0) {
      events.push({
        gameweekId: gwId,
        accountATransferCost: costA,
        accountBGain: gainB,
        correlation: costA * gainB, // Product for rough correlation check
      });
    }
  }

  // Compute Pearson correlation
  const correlation = pearsonCorrelation(costs, gains);

  // Score based on correlation strength
  // Only positive correlation matters (A takes hits, B gains)
  let score = 0;
  if (correlation > config.minCorrelation) {
    score = (correlation - config.minCorrelation) / (1 - config.minCorrelation); // Normalize to 0-1
    score = Math.min(1.0, score * 0.5); // Cap at 0.5 as this is a weak signal
  }

  const evidence: PointAbsorptionEvidence = {
    score,
    events,
    pearsonCorrelation: correlation,
    config,
    notes:
      correlation > config.minCorrelation
        ? `Positive correlation (r=${correlation.toFixed(3)}) between transfer costs and rival gains over ${commonGWs.length} gameweeks.`
        : correlation > 0
          ? `Weak positive correlation (r=${correlation.toFixed(3)}) detected.`
          : undefined,
  };

  return { score, evidence };
}

/**
 * Compute point absorption signal in batch for multiple account pairs.
 *
 * @param pairs Account pairs with their scores
 * @param gameweekRange Gameweek range to analyze
 * @param config Signal configuration
 * @returns Array of {score, evidence} tuples
 */
export function computePointAbsorptionScoreBatch(
  pairs: Array<{
    scoresA: SquadGameweekScore[];
    scoresB: SquadGameweekScore[];
  }>,
  gameweekRange: { startGW: number; endGW: number },
  config: PointAbsorptionConfig = DEFAULT_POINT_ABSORPTION_CONFIG
): Array<{ score: number; evidence: PointAbsorptionEvidence }> {
  return pairs.map(({ scoresA, scoresB }) =>
    computePointAbsorptionScore(scoresA, scoresB, gameweekRange, config)
  );
}
