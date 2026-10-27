/**
 * Configuration for chip timing signal detection.
 * Controls deviation thresholds and weighting for suspicious chip plays.
 */
export interface ChipTimingConfig {
  /** Minimum deviation from base rate (e.g., 2.0 = >2x base rate is suspicious) */
  minDeviation: number;
  /** Weight for H2H opponent benefit (full weight) */
  h2hBenefitWeight: number;
  /** Weight for league-wide suspicious timing (half weight) */
  leagueAvgBenefitWeight: number;
  /** Minimum gameweeks of data to analyze */
  minGameweeksAnalyzed: number;
}

/**
 * Default configuration for chip timing detection.
 */
export const DEFAULT_CHIP_TIMING_CONFIG: ChipTimingConfig = {
  minDeviation: 2.0,
  h2hBenefitWeight: 1.0,
  leagueAvgBenefitWeight: 0.5,
  minGameweeksAnalyzed: 5,
};

/**
 * Represents a chip activation with context.
 */
export interface ChipUsage {
  squadId: string;
  chipType: string; // TRIPLE_CAPTAIN, BENCH_BOOST, FREE_HIT, WILDCARD
  gameweekId: number;
  usedAt: Date;
}

/**
 * Head-to-head fixture between two accounts.
 */
export interface H2hFixture {
  homeSquadId: string;
  awaySquadId: string;
  gameweekId: number;
}

/**
 * Evidence for a single chip usage and its correlation with rival's benefit.
 */
export interface ChipTimingEvent {
  squadId: string;
  chipType: string;
  gameweekId: number;
  usedAt: Date;
  opponentSquadId?: string;
  benefitsOpponent: boolean;
  baseRateThisGw: number;
  deviation: number;
  suspicionScore: number;
}

/**
 * Evidence structure for chip timing signal.
 */
export interface ChipTimingEvidence {
  score: number;
  events: ChipTimingEvent[];
  config: ChipTimingConfig;
  notes?: string;
}

/**
 * Compute base rate for a chip type in a given gameweek.
 * Base rate = number of teams playing the chip / league size
 *
 * @param chipType Chip type to calculate base rate for
 * @param gameweekId Gameweek ID
 * @param allChipUsages All chip usages in the league
 * @param leagueSize Total league member count
 * @returns Base rate as a decimal (0-1)
 */
function computeChipBaseRate(
  chipType: string,
  gameweekId: number,
  allChipUsages: ChipUsage[],
  leagueSize: number
): number {
  if (leagueSize === 0) return 0;

  const chipsThisGw = allChipUsages.filter(
    (c) => c.chipType === chipType && c.gameweekId === gameweekId
  );

  return chipsThisGw.length / leagueSize;
}

/**
 * Check if two squads have a head-to-head fixture in a gameweek.
 */
function hasH2hFixture(
  squadAId: string,
  squadBId: string,
  gameweekId: number,
  h2hFixtures: H2hFixture[]
): boolean {
  return h2hFixtures.some(
    (f) =>
      f.gameweekId === gameweekId &&
      ((f.homeSquadId === squadAId && f.awaySquadId === squadBId) ||
        (f.homeSquadId === squadBId && f.awaySquadId === squadAId))
  );
}

/**
 * Heuristic: does playing a chip in this gameweek primarily benefit the opponent?
 * For example, if squad A plays Free Hit in GW5 and squad B is ahead on points,
 * squad A might be attempting a catch-up, not specifically benefiting B.
 * This is a weak signal and requires context.
 */
function doesChipBenefitOpponent(chipType: string, _gameweekId: number): boolean {
  // Most chips are played to improve one's own score, not the opponent's.
  // A chip would "benefit" the opponent only in rare strategic scenarios:
  // - Playing a chip early to waste it (very rare)
  // - Playing a chip to avoid catching an opponent (but this benefits self)
  //
  // In practice, benefit is asymmetric: if A plays a chip and B doesn't,
  // B might benefit relative to A, but not vice versa.
  // This function is conservative and returns false by default.
  return false;
}

/**
 * Compute chip timing signal between two accounts.
 * Analyzes chip usage for suspicious correlations with rival activity.
 *
 * @param chipsA Chip usages for account A
 * @param chipsB Chip usages for account B
 * @param allLeagueChips All chip usages in the league
 * @param h2hFixtures Head-to-head fixtures (null if not H2H league)
 * @param leagueSize Total league member count
 * @param gameweekRange Gameweek range to analyze
 * @param config Signal configuration
 * @returns {score, evidence} tuple
 */
export function computeChipTimingScore(
  chipsA: ChipUsage[],
  chipsB: ChipUsage[],
  allLeagueChips: ChipUsage[],
  h2hFixtures: H2hFixture[] | null,
  leagueSize: number,
  gameweekRange: { startGW: number; endGW: number },
  config: ChipTimingConfig = DEFAULT_CHIP_TIMING_CONFIG
): { score: number; evidence: ChipTimingEvidence } {
  const events: ChipTimingEvent[] = [];

  // Require minimum data
  if (gameweekRange.endGW - gameweekRange.startGW + 1 < config.minGameweeksAnalyzed) {
    return { score: 0, evidence: { score: 0, events: [], config } };
  }

  // Analyze account A's chip usage
  for (const chipA of chipsA) {
    if (chipA.gameweekId < gameweekRange.startGW || chipA.gameweekId > gameweekRange.endGW) {
      continue;
    }

    const baseRate = computeChipBaseRate(chipA.chipType, chipA.gameweekId, allLeagueChips, leagueSize);
    const deviation = baseRate > 0 ? 1 / baseRate : 0; // How unusual is this timing?

    // Check if this benefits opponent (H2H context)
    const benefitsOpponent =
      h2hFixtures && hasH2hFixture(chipA.squadId, chipsB[0]?.squadId || '', chipA.gameweekId, h2hFixtures)
        ? doesChipBenefitOpponent(chipA.chipType, chipA.gameweekId)
        : false;

    const weight = benefitsOpponent ? config.h2hBenefitWeight : config.leagueAvgBenefitWeight;
    const suspicionScore = Math.min(1.0, Math.max(0, (deviation - 1) / config.minDeviation) * weight);

    if (suspicionScore > 0) {
      events.push({
        squadId: chipA.squadId,
        chipType: chipA.chipType,
        gameweekId: chipA.gameweekId,
        usedAt: chipA.usedAt,
        benefitsOpponent,
        baseRateThisGw: baseRate,
        deviation,
        suspicionScore,
      });
    }
  }

  // Analyze account B's chip usage
  for (const chipB of chipsB) {
    if (chipB.gameweekId < gameweekRange.startGW || chipB.gameweekId > gameweekRange.endGW) {
      continue;
    }

    const baseRate = computeChipBaseRate(chipB.chipType, chipB.gameweekId, allLeagueChips, leagueSize);
    const deviation = baseRate > 0 ? 1 / baseRate : 0;

    const benefitsOpponent =
      h2hFixtures && hasH2hFixture(chipsA[0]?.squadId || '', chipB.squadId, chipB.gameweekId, h2hFixtures)
        ? doesChipBenefitOpponent(chipB.chipType, chipB.gameweekId)
        : false;

    const weight = benefitsOpponent ? config.h2hBenefitWeight : config.leagueAvgBenefitWeight;
    const suspicionScore = Math.min(1.0, Math.max(0, (deviation - 1) / config.minDeviation) * weight);

    if (suspicionScore > 0) {
      events.push({
        squadId: chipB.squadId,
        chipType: chipB.chipType,
        gameweekId: chipB.gameweekId,
        usedAt: chipB.usedAt,
        benefitsOpponent,
        baseRateThisGw: baseRate,
        deviation,
        suspicionScore,
      });
    }
  }

  // Compute overall score as average of top suspicion events
  let score = 0;
  if (events.length > 0) {
    const topEvents = events.sort((a, b) => b.suspicionScore - a.suspicionScore).slice(0, 3);
    score = topEvents.reduce((sum, e) => sum + e.suspicionScore, 0) / topEvents.length;
  }

  const evidence: ChipTimingEvidence = {
    score,
    events,
    config,
    notes:
      events.length > 0
        ? `Detected ${events.length} suspiciously-timed chip plays. Analyze context per gameweek.`
        : undefined,
  };

  return { score, evidence };
}

/**
 * Compute chip timing signal in batch for multiple account pairs.
 *
 * @param pairs Account pairs with their chip usages
 * @param allLeagueChips All chip usages in the league
 * @param h2hFixtures Head-to-head fixtures (null if not H2H league)
 * @param leagueSize Total league member count
 * @param gameweekRange Gameweek range to analyze
 * @param config Signal configuration
 * @returns Array of {score, evidence} tuples
 */
export function computeChipTimingScoreBatch(
  pairs: Array<{
    chipsA: ChipUsage[];
    chipsB: ChipUsage[];
  }>,
  allLeagueChips: ChipUsage[],
  h2hFixtures: H2hFixture[] | null,
  leagueSize: number,
  gameweekRange: { startGW: number; endGW: number },
  config: ChipTimingConfig = DEFAULT_CHIP_TIMING_CONFIG
): Array<{ score: number; evidence: ChipTimingEvidence }> {
  return pairs.map(({ chipsA, chipsB }) =>
    computeChipTimingScore(chipsA, chipsB, allLeagueChips, h2hFixtures, leagueSize, gameweekRange, config)
  );
}
