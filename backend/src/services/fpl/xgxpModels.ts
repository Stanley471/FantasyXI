/**
 * xG and xP Forecasting Models
 *
 * Implements transparent regression-style expected goals (xG) and expected points (xP)
 * prediction for fantasy football players, using historical performance, team strength
 * ratings, opponent defensive metrics, and venue factors.
 *
 * Design principles:
 * - All inputs validated; guards against division by zero, NaN, Infinity, negative rates
 * - Shrinkage toward positional averages prevents extreme values from small samples
 * - Component-level breakdown enables explainability and testing
 * - Fallback to positional defaults when player history insufficient
 * - Deterministic for identical inputs; numerical outputs bounded and finite
 */

import { Position } from "../../types/index.js";

/**
 * Configuration for xG/xP models with all constants documented.
 * Grouped by concern for easy tuning.
 */
export const XG_XP_CONFIG = {
  // ========== Position-Specific Historical Baselines (per 90 minutes) ==========
  // These are used when a player has insufficient history to compute individual rates.
  // Derived from typical FPL positional averages over a season.

  POSITIONAL_GOAL_RATE_PER_90: {
    [Position.GKP]: 0.0, // Goalkeepers rarely score
    [Position.DEF]: 0.08, // ~7-8 goals per season for a regular defender
    [Position.MID]: 0.15, // ~13-15 goals per season for a regular midfielder
    [Position.FWD]: 0.25, // ~22-25 goals per season for a regular forward
  },

  POSITIONAL_ASSIST_RATE_PER_90: {
    [Position.GKP]: 0.0,
    [Position.DEF]: 0.05, // Defenders provide fewer assists
    [Position.MID]: 0.10, // Midfielders assist regularly
    [Position.FWD]: 0.05, // Forwards assist less than create goals
  },

  POSITIONAL_CLEAN_SHEET_PROBABILITY: {
    [Position.GKP]: 0.30, // Keepers in ~30% of clean sheets
    [Position.DEF]: 0.30,
    [Position.MID]: 0.30,
    [Position.FWD]: 0.30, // Forwards rarely play in clean sheets
  },

  POSITIONAL_MINUTES_EXPECTED: {
    [Position.GKP]: 90, // Keepers almost always play 90
    [Position.DEF]: 75, // Defenders rotated, ~75 min average
    [Position.MID]: 70, // Midfielders see rotation, ~70 min average
    [Position.FWD]: 60, // Forwards most rotated, ~60 min average
  },

  // ========== Opponent Defensive Factor ==========
  // Team strength ratings (from FPL) are ~1800-2100 on absolute scale.
  // We normalize to a multiplier: 1.0 = neutral, >1.0 = stronger defense (lower xG), <1.0 = weaker.
  TEAM_STRENGTH_NEUTRAL: 1950, // Midpoint for normalization
  TEAM_STRENGTH_SCALING: 100, // Divisor to convert strength delta to multiplier factor

  // ========== Venue Multiplier ==========
  // Home teams typically score ~10-15% more than away teams.
  HOME_VENUE_MULTIPLIER: 1.12,
  AWAY_VENUE_MULTIPLIER: 0.88,

  // ========== Shrinkage (Stein estimation) ==========
  // Blend player's individual rate with positional average based on sample size.
  // Higher sample size → more weight to individual; small sample → lean on positional.
  SHRINKAGE_SAMPLE_THRESHOLD: 10, // Games at which we trust individual rate ~60%
  SHRINKAGE_MAX_SAMPLE: 30, // Games at which individual rate ~95% trusted

  // ========== Numerical Safety Bounds ==========
  MIN_RATE_PER_90: 0.0,
  MAX_RATE_PER_90: 0.5, // Prevent extreme outliers (no player scores every other game)
  MIN_PROBABILITY: 0.0,
  MAX_PROBABILITY: 1.0,
  MIN_EXPECTED_MINUTES: 0.0,
  MAX_EXPECTED_MINUTES: 90.0,
  MIN_XG: 0.0,
  MAX_XG: 2.0, // Few games have xG > 2 for a single player
  MIN_XP: 0.0,
  MAX_XP: 50.0, // Realistic upper bound for a single gameweek forecast

  // ========== FPL Scoring Values (replicate scoringService logic) ==========
  FPL_POINTS: {
    APPEARANCE_PER_90: 4, // 1 point per 2 minutes, capped at 4 for full 90
    GOAL_GKP: 5,
    GOAL_DEF: 5,
    GOAL_MID: 5,
    GOAL_FWD: 4,
    ASSIST: 3,
    CLEAN_SHEET_GKP: 4,
    CLEAN_SHEET_DEF: 4,
    CLEAN_SHEET_MID: 1,
    CLEAN_SHEET_FWD: 0,
    YELLOW_CARD: -1,
    RED_CARD: -3,
    SAVE_PER_3: 1, // Goalkeeper only
    BONUS_TYPICAL: 1, // Conservative average bonus per game
  },

  // ========== Cards Expected Value ==========
  // Position-dependent likelihood of receiving yellow/red cards per 90 minutes.
  CARD_RATE_PER_90: {
    [Position.GKP]: 0.05, // Keepers rarely carded
    [Position.DEF]: 0.12, // Defenders most likely to be carded
    [Position.MID]: 0.08,
    [Position.FWD]: 0.06,
  },
};

/**
 * Data source indicator for transparency in predictions.
 * Helps consumers understand data quality and confidence.
 */
export type DataSourceType =
  | "full_history" // Sufficient historical data for all components
  | "shrunk_to_position" // Blended with positional average due to small sample
  | "positional_only" // Using only positional baseline (no player history)
  | "missing_opponent_data" // Opponent strength not available, used neutral
  | "missing_venue_data"; // Venue not available, used neutral

/**
 * Per-component breakdown of xG for explainability and testing.
 */
export interface XGBreakdown {
  playerBaseRatePer90: number; // Player's historical goal rate per 90 minutes
  shrinkageBlendedRate: number; // After shrinkage toward positional average
  opponentDefenseFactor: number; // Multiplier for opponent strength (1.0 = neutral)
  venueFactor: number; // Home 1.12, away 0.88, neutral 1.0
  expectedMinutes: number; // Forecasted minutes for this gameweek
  finalXG: number; // shrinkageBlendedRate * opponentDefenseFactor * venueFactor * (expectedMinutes / 90)
  dataSource: DataSourceType;
  sampleSize: number; // Number of historical games used
}

/**
 * Per-component breakdown of xP for explainability and testing.
 */
export interface XPBreakdown {
  appearancePoints: number; // (expectedMinutes / 90) * 4
  expectedGoalPoints: number; // xG * position_goal_value
  expectedAssistPoints: number; // xA * 3
  expectedCleanSheetPoints: number; // clean_sheet_probability * cs_value
  expectedCardPoints: number; // Expected negative points from yellow/red cards
  expectedBonusPoints: number; // Conservative bonus estimate
  expectedSavePoints: number; // For GKP only
  totalXP: number; // Sum of all components
  dataSource: DataSourceType;
}

/**
 * Guard against numerical anomalies: ensure value is finite, non-negative, within bounds.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

/**
 * Stein shrinkage: blend individual rate with positional average based on sample size.
 * As sample size increases, gradually trust the individual rate more.
 */
function applyShinkage(
  individualRate: number,
  positionalAverage: number,
  sampleSize: number,
  thresholdSize: number = XG_XP_CONFIG.SHRINKAGE_SAMPLE_THRESHOLD,
  maxSize: number = XG_XP_CONFIG.SHRINKAGE_MAX_SAMPLE
): number {
  if (sampleSize <= 0) return positionalAverage;
  if (sampleSize >= maxSize) return individualRate;

  // Linear interpolation between threshold and max
  const alpha = (sampleSize - 0) / (maxSize - 0);
  return positionalAverage + alpha * (individualRate - positionalAverage);
}

/**
 * Compute opponent defensive factor multiplier from team strength ratings.
 * Stronger opponent defense → lower xG for attacking player.
 */
function getOpponentDefenseFactor(
  defenseRating: number | undefined | null,
  isHome: boolean
): { factor: number; used: boolean } {
  if (defenseRating === undefined || defenseRating === null) {
    // Missing opponent data: use neutral
    return { factor: 1.0, used: false };
  }

  // Normalize: neutral is 1.0, strong defense is < 1.0, weak defense is > 1.0
  // Formula: (neutral - opponentStrength) / scaling
  const delta = XG_XP_CONFIG.TEAM_STRENGTH_NEUTRAL - defenseRating;
  const factor = clamp(1.0 + delta / XG_XP_CONFIG.TEAM_STRENGTH_SCALING, 0.5, 1.5);

  return { factor, used: true };
}

/**
 * Compute venue factor (home/away multiplier).
 */
function getVenueFactor(isHome: boolean): number {
  return isHome ? XG_XP_CONFIG.HOME_VENUE_MULTIPLIER : XG_XP_CONFIG.AWAY_VENUE_MULTIPLIER;
}

/**
 * Compute xG per 90 for a player against a specific opponent.
 *
 * Inputs:
 * - playerStats: Historical goal counts and minutes
 * - position: Player's position (GKP, DEF, MID, FWD)
 * - opponentDefenseRating: Opponent's defensive strength (FPL rating), nullable
 * - isHome: Whether the player's team is at home
 * - expectedMinutes: Forecasted minutes for the upcoming fixture (0-90)
 *
 * Returns: XGBreakdown with final xG and data quality indicator
 */
export function computeXG(options: {
  playerGoals: number; // Career total goals (or recent season goals)
  playerMinutes: number; // Career total minutes (or recent season minutes)
  position: Position;
  opponentDefenseRating: number | undefined | null;
  isHome: boolean;
  expectedMinutes: number;
}): XGBreakdown {
  const {
    playerGoals,
    playerMinutes,
    position,
    opponentDefenseRating,
    isHome,
    expectedMinutes,
  } = options;

  // ========== Determine data source and compute individual rate ==========
  let dataSource: DataSourceType = "full_history";
  let sampleSize = 0;
  let individualRatePer90 = 0;

  if (playerMinutes > 0) {
    sampleSize = Math.max(1, Math.floor(playerMinutes / 90));
    individualRatePer90 = clamp(playerGoals / playerMinutes * 90, 0, XG_XP_CONFIG.MAX_RATE_PER_90);
  }

  const positionalAverage = XG_XP_CONFIG.POSITIONAL_GOAL_RATE_PER_90[position];

  if (sampleSize === 0) {
    // No history: use positional only
    dataSource = "positional_only";
    individualRatePer90 = positionalAverage;
  } else if (sampleSize < XG_XP_CONFIG.SHRINKAGE_SAMPLE_THRESHOLD) {
    // Small sample: blend with positional
    dataSource = "shrunk_to_position";
  }

  // ========== Apply shrinkage ==========
  const shrinkageBlendedRate = applyShinkage(
    individualRatePer90,
    positionalAverage,
    sampleSize
  );

  // ========== Apply defensive factor ==========
  const { factor: defenseMultiplier, used: defenseDataUsed } = getOpponentDefenseFactor(
    opponentDefenseRating,
    isHome
  );
  if (!defenseDataUsed) {
    dataSource = "missing_opponent_data";
  }

  // ========== Apply venue factor ==========
  const venueMultiplier = getVenueFactor(isHome);

  // ========== Compute final xG ==========
  const minutesFraction = clamp(expectedMinutes / 90, 0, 1);
  const finalXG = clamp(
    shrinkageBlendedRate * defenseMultiplier * venueMultiplier * minutesFraction,
    XG_XP_CONFIG.MIN_XG,
    XG_XP_CONFIG.MAX_XG
  );

  return {
    playerBaseRatePer90: individualRatePer90,
    shrinkageBlendedRate,
    opponentDefenseFactor: defenseMultiplier,
    venueFactor: venueMultiplier,
    expectedMinutes: clamp(expectedMinutes, 0, 90),
    finalXG,
    dataSource,
    sampleSize,
  };
}

/**
 * Compute xA (expected assists) using similar logic to xG.
 */
export function computeXA(options: {
  playerAssists: number;
  playerMinutes: number;
  position: Position;
  opponentDefenseRating: number | undefined | null;
  isHome: boolean;
  expectedMinutes: number;
}): XGBreakdown {
  const {
    playerAssists,
    playerMinutes,
    position,
    opponentDefenseRating,
    isHome,
    expectedMinutes,
  } = options;

  let dataSource: DataSourceType = "full_history";
  let sampleSize = 0;
  let individualRatePer90 = 0;

  if (playerMinutes > 0) {
    sampleSize = Math.max(1, Math.floor(playerMinutes / 90));
    individualRatePer90 = clamp(playerAssists / playerMinutes * 90, 0, XG_XP_CONFIG.MAX_RATE_PER_90);
  }

  const positionalAverage = XG_XP_CONFIG.POSITIONAL_ASSIST_RATE_PER_90[position];

  if (sampleSize === 0) {
    dataSource = "positional_only";
    individualRatePer90 = positionalAverage;
  } else if (sampleSize < XG_XP_CONFIG.SHRINKAGE_SAMPLE_THRESHOLD) {
    dataSource = "shrunk_to_position";
  }

  const shrinkageBlendedRate = applyShinkage(
    individualRatePer90,
    positionalAverage,
    sampleSize
  );

  const { factor: defenseMultiplier, used: defenseDataUsed } = getOpponentDefenseFactor(
    opponentDefenseRating,
    isHome
  );
  if (!defenseDataUsed) {
    dataSource = "missing_opponent_data";
  }

  const venueMultiplier = getVenueFactor(isHome);
  const minutesFraction = clamp(expectedMinutes / 90, 0, 1);
  const finalXA = clamp(
    shrinkageBlendedRate * defenseMultiplier * venueMultiplier * minutesFraction,
    XG_XP_CONFIG.MIN_XG,
    XG_XP_CONFIG.MAX_XG
  );

  return {
    playerBaseRatePer90: individualRatePer90,
    shrinkageBlendedRate,
    opponentDefenseFactor: defenseMultiplier,
    venueFactor: venueMultiplier,
    expectedMinutes: clamp(expectedMinutes, 0, 90),
    finalXG: finalXA,
    dataSource,
    sampleSize,
  };
}

/**
 * Compute clean sheet probability for a team (all positions on that team see the same CS prob).
 * Stronger defense → higher probability.
 */
export function computeCleanSheetProbability(options: {
  teamDefenseRating: number | undefined | null;
  playerPosition: Position;
}): { probability: number; used: boolean } {
  const { teamDefenseRating, playerPosition } = options;

  const positionalBaseline = XG_XP_CONFIG.POSITIONAL_CLEAN_SHEET_PROBABILITY[playerPosition];

  if (teamDefenseRating === undefined || teamDefenseRating === null) {
    return { probability: positionalBaseline, used: false };
  }

  // Stronger defense → higher CS probability
  // Normalize and adjust baseline
  const strengthDelta = teamDefenseRating - XG_XP_CONFIG.TEAM_STRENGTH_NEUTRAL;
  const adjustment = clamp(strengthDelta / XG_XP_CONFIG.TEAM_STRENGTH_SCALING * 0.2, -0.15, 0.15);
  const probability = clamp(positionalBaseline + adjustment, 0, 1);

  return { probability, used: true };
}

/**
 * Compute expected minutes for upcoming fixture.
 * Uses injury/availability chance or defaults to positional average.
 */
export function computeExpectedMinutes(options: {
  playerStatus: string | null | undefined;
  chanceOfPlayingNextRound: number | null | undefined;
  position: Position;
}): number {
  const { playerStatus, chanceOfPlayingNextRound, position } = options;

  // If player is injured, suspended, or unavailable: 0 minutes
  if (playerStatus === "i" || playerStatus === "s" || playerStatus === "u" || playerStatus === "d") {
    return 0;
  }

  const positionalDefault = XG_XP_CONFIG.POSITIONAL_MINUTES_EXPECTED[position];

  // If chance percentage is available, scale expected minutes by it
  if (chanceOfPlayingNextRound !== undefined && chanceOfPlayingNextRound !== null) {
    const chance = clamp(chanceOfPlayingNextRound / 100, 0, 1);
    return clamp(positionalDefault * chance, 0, 90);
  }

  // Player available; assume full minutes
  return positionalDefault;
}

/**
 * Compute expected points (xP) as the sum of all FPL point components.
 *
 * Replicates FPL scoring formula using expected values:
 * - Appearance points from expected minutes
 * - Goal points from xG
 * - Assist points from xA
 * - Clean sheet points from team CS probability
 * - Card points from position-typical yellow/red rates
 * - Bonus points from conservative estimate
 */
export function computeXP(options: {
  position: Position;
  playerGoals: number;
  playerAssists: number;
  playerMinutes: number;
  playerStatus: string | null | undefined;
  chanceOfPlayingNextRound: number | null | undefined;
  teamDefenseRating: number | undefined | null;
  opponentDefenseRating: number | undefined | null;
  isHome: boolean;
}): XPBreakdown {
  const {
    position,
    playerGoals,
    playerAssists,
    playerMinutes,
    playerStatus,
    chanceOfPlayingNextRound,
    teamDefenseRating,
    opponentDefenseRating,
    isHome,
  } = options;

  // ========== Expected Minutes ==========
  const expectedMinutes = computeExpectedMinutes({
    playerStatus,
    chanceOfPlayingNextRound,
    position,
  });

  // ========== xG and xA ==========
  const xgBreakdown = computeXG({
    playerGoals,
    playerMinutes,
    position,
    opponentDefenseRating,
    isHome,
    expectedMinutes,
  });

  const xaBreakdown = computeXA({
    playerAssists,
    playerMinutes,
    position,
    opponentDefenseRating,
    isHome,
    expectedMinutes,
  });

  // Determine data source as the most conservative
  let dataSource = xgBreakdown.dataSource;
  if (xaBreakdown.dataSource === "positional_only" || xgBreakdown.dataSource === "positional_only") {
    dataSource = "positional_only";
  } else if (
    xaBreakdown.dataSource === "shrunk_to_position" ||
    xgBreakdown.dataSource === "shrunk_to_position"
  ) {
    dataSource = "shrunk_to_position";
  }

  // ========== Appearance Points ==========
  const appearancePoints = clamp(
    (expectedMinutes / 90) * XG_XP_CONFIG.FPL_POINTS.APPEARANCE_PER_90,
    0,
    4
  );

  // ========== Goal Points ==========
  const goalValue = {
    [Position.GKP]: XG_XP_CONFIG.FPL_POINTS.GOAL_GKP,
    [Position.DEF]: XG_XP_CONFIG.FPL_POINTS.GOAL_DEF,
    [Position.MID]: XG_XP_CONFIG.FPL_POINTS.GOAL_MID,
    [Position.FWD]: XG_XP_CONFIG.FPL_POINTS.GOAL_FWD,
  }[position];

  const expectedGoalPoints = clamp(xgBreakdown.finalXG * goalValue, 0, 20);

  // ========== Assist Points ==========
  const expectedAssistPoints = clamp(xaBreakdown.finalXG * XG_XP_CONFIG.FPL_POINTS.ASSIST, 0, 10);

  // ========== Clean Sheet Points ==========
  const { probability: csProb } = computeCleanSheetProbability({
    teamDefenseRating,
    playerPosition: position,
  });

  const csValue = {
    [Position.GKP]: XG_XP_CONFIG.FPL_POINTS.CLEAN_SHEET_GKP,
    [Position.DEF]: XG_XP_CONFIG.FPL_POINTS.CLEAN_SHEET_DEF,
    [Position.MID]: XG_XP_CONFIG.FPL_POINTS.CLEAN_SHEET_MID,
    [Position.FWD]: XG_XP_CONFIG.FPL_POINTS.CLEAN_SHEET_FWD,
  }[position];

  const expectedCleanSheetPoints = clamp(csProb * csValue, 0, 4);

  // ========== Card Points (expected value: negative) ==========
  const cardRatePer90 = XG_XP_CONFIG.CARD_RATE_PER_90[position];
  const expectedCardRate = clamp(
    cardRatePer90 * (expectedMinutes / 90),
    0,
    1
  );
  // Assume 80% yellow (−1 pt), 20% red (−3 pts) when carded
  const expectedCardPoints = clamp(
    -(expectedCardRate * (0.8 * XG_XP_CONFIG.FPL_POINTS.YELLOW_CARD +
      0.2 * XG_XP_CONFIG.FPL_POINTS.RED_CARD)),
    -5,
    0
  );

  // ========== Bonus Points (conservative) ==========
  // Typical player gets bonus in ~5-10% of matches; estimate 0.5 pts expected
  const expectedBonusPoints = 0.5;

  // ========== Saves Points (GKP only) ==========
  let expectedSavePoints = 0;
  if (position === Position.GKP) {
    // Assume GKP makes ~3-4 saves per game
    const savesPerGame = 3.5;
    const expectedSaves = savesPerGame * (expectedMinutes / 90);
    expectedSavePoints = clamp(
      Math.floor(expectedSaves / 3) * XG_XP_CONFIG.FPL_POINTS.SAVE_PER_3,
      0,
      3
    );
  }

  // ========== Total xP ==========
  const totalXP = clamp(
    appearancePoints +
      expectedGoalPoints +
      expectedAssistPoints +
      expectedCleanSheetPoints +
      expectedCardPoints +
      expectedBonusPoints +
      expectedSavePoints,
    XG_XP_CONFIG.MIN_XP,
    XG_XP_CONFIG.MAX_XP
  );

  return {
    appearancePoints,
    expectedGoalPoints,
    expectedAssistPoints,
    expectedCleanSheetPoints,
    expectedCardPoints,
    expectedBonusPoints,
    expectedSavePoints,
    totalXP,
    dataSource,
  };
}

export default {
  XG_XP_CONFIG,
  computeXG,
  computeXA,
  computeCleanSheetProbability,
  computeExpectedMinutes,
  computeXP,
};
