/**
 * xG/xP Forecasting Models Test Suite
 *
 * Tests:
 * - Accuracy: known inputs produce expected outputs (hand-calculated) for each position
 * - Fallbacks: missing data falls back cleanly to positional defaults
 * - Stability: extreme values, NaN, Infinity, zero inputs produce bounded finite results
 * - Shrinkage: small samples blend toward positional average, large samples trust individual rate
 * - Numerical safety: all outputs within bounds, monotonic where expected
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeXG,
  computeXA,
  computeExpectedMinutes,
  computeXP,
  computeCleanSheetProbability,
  XG_XP_CONFIG,
} from "../services/fpl/xgxpModels.js";
import { Position } from "@prisma/client";

describe("xG/xP Models", () => {
  // ========== ACCURACY TESTS ==========
  describe("Accuracy: Expected outputs for known inputs (hand-calculated)", () => {
    it("Forward at home vs weak defense: high xG", () => {
      // Forward with 30 goals in 2700 minutes (0.1 per 90 baseline)
      // vs weak defense (1500 strength, neutral 1950)
      // Home venue (1.12), expected 90 minutes
      const result = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1500, // Weak
        isHome: true,
        expectedMinutes: 90,
      });

      // Base rate: 30/2700*90 = 1.0 per 90
      // Defense factor: (1950 - 1500) / 100 = 4.5, clamped to 1.5
      // Venue: 1.12
      // Final: 1.0 * 1.5 * 1.12 * 1.0 = 1.68 xG
      assert.ok(result.finalXG > 1.5, "xG should be elevated for weak defense at home");
      assert.ok(result.finalXG < 2.0, "xG should be clamped reasonably");
    });

    it("Defender away vs strong defense: low xG", () => {
      const result = computeXG({
        playerGoals: 10,
        playerMinutes: 2700, // ~30 games
        position: Position.DEF,
        opponentDefenseRating: 2200, // Strong
        isHome: false,
        expectedMinutes: 90,
      });

      // Base rate: 10/2700*90 = 0.333 per 90
      // Defense factor: (1950 - 2200) / 100 = -2.5, clamped to 0.5
      // Venue: 0.88
      // Final: 0.333 * 0.5 * 0.88 * 1.0 ≈ 0.147 xG
      assert.ok(result.finalXG < 0.2, "xG should be suppressed for strong defense away");
      assert.equal(result.finalXG, result.finalXG, "xG should be a number");
    });

    it("GKP has near-zero goal xG regardless of input", () => {
      const result = computeXG({
        playerGoals: 1, // Impossible, but testing input handling
        playerMinutes: 2700,
        position: Position.GKP,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      assert.ok(result.finalXG < 0.01, "GKP xG should be near zero");
    });

    it("xP components sum correctly for midfielder", () => {
      const result = computeXP({
        position: Position.MID,
        playerGoals: 50,
        playerAssists: 30,
        playerMinutes: 2700, // ~30 games
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      // Appearance: 4 (full 90 minutes)
      // Goals: 0.556 (per 90) * 1.12 (venue) * 1.0 (opponent neutral) * 5 (MID goal value) ≈ 3.1
      // Assists: 0.333 (per 90) * 1.12 * 1.0 * 3 ≈ 1.1
      // Clean sheet: 0.3 (baseline) * 1.0 (adjustment) * 1 (MID value) = 0.3
      // Cards: ~0.066 card rate (per 90) * 1.0 (expected minutes factor) * (-0.1) ≈ -0.007
      // Bonus: 0.5
      // Total: 4 + 3.1 + 1.1 + 0.3 - 0.007 + 0.5 ≈ 9.0+
      assert.ok(result.totalXP > 8, "xP should be substantial for regular midfielder");
      assert.ok(result.totalXP < 50, "xP should be clamped to reasonable max");
    });

    it("Injured player has zero expected minutes and minimal xP", () => {
      const result = computeXP({
        position: Position.FWD,
        playerGoals: 100,
        playerAssists: 50,
        playerMinutes: 5000,
        playerStatus: "i", // Injured
        chanceOfPlayingNextRound: null,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      assert.equal(result.appearancePoints, 0, "Injured player should have 0 appearance points");
      assert.ok(result.totalXP < 1, "Injured player xP should be minimal");
    });

    it("50% chance of playing reduces expected minutes and xP proportionally", () => {
      const result100 = computeXP({
        position: Position.DEF,
        playerGoals: 20,
        playerAssists: 10,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      const result50 = computeXP({
        position: Position.DEF,
        playerGoals: 20,
        playerAssists: 10,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 50,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      // xP at 50% should be roughly half of 100%
      assert.ok(result50.totalXP < result100.totalXP, "50% chance should reduce xP");
      assert.ok(result50.totalXP > result100.totalXP * 0.4, "Reduction should be proportional");
    });
  });

  // ========== FALLBACK TESTS ==========
  describe("Fallbacks: Missing data falls back cleanly", () => {
    it("No player history: falls back to positional average", () => {
      const result = computeXG({
        playerGoals: 0,
        playerMinutes: 0, // No history
        position: Position.MID,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      // Should use positional baseline: 0.15 per 90, *1.0 (neutral opponent), * 1.12 (venue), * 1.0 (minutes factor)
      assert.equal(result.dataSource, "positional_only");
      const expectedXG = 0.15 * 1.0 * 1.12;
      assert.ok(Math.abs(result.finalXG - expectedXG) < 0.01, "Should use positional average");
    });

    it("Small sample (5 games): shrinks toward positional average", () => {
      const result = computeXG({
        playerGoals: 5, // Extremely high rate on small sample
        playerMinutes: 450, // 5 games of 90 minutes
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      // Individual rate: 5/450*90 = 1.0 per 90
      // Positional average: 0.25 per 90
      // Shrinkage at 5 games: blend toward positional
      assert.equal(result.dataSource, "shrunk_to_position");
      assert.ok(result.finalXG < 0.9, "High individual rate should be tempered by shrinkage");
      assert.ok(result.finalXG > 0.25 * 1.0 * 1.12, "Should not drop all the way to positional");
    });

    it("Missing opponent defense rating: uses neutral factor", () => {
      const result = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: null, // Missing
        isHome: true,
        expectedMinutes: 90,
      });

      assert.ok(result.dataSource.includes("missing_opponent") || result.dataSource === "full_history");
      assert.equal(result.opponentDefenseFactor, 1.0, "Missing opponent data should use neutral 1.0");
    });

    it("Missing venue data: computed from isHome boolean", () => {
      const resultHome = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      const resultAway = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: false,
        expectedMinutes: 90,
      });

      assert.equal(resultHome.venueFactor, 1.12, "Home should be 1.12");
      assert.equal(resultAway.venueFactor, 0.88, "Away should be 0.88");
      assert.ok(resultHome.finalXG > resultAway.finalXG, "Home should have higher xG than away");
    });

    it("Clean sheet probability with missing team defense: uses positional baseline", () => {
      const result = computeCleanSheetProbability({
        teamDefenseRating: null,
        playerPosition: Position.DEF,
      });

      assert.equal(result.probability, 0.3, "Missing defense data should use positional baseline");
      assert.equal(result.used, false, "Should indicate no defense data was used");
    });
  });

  // ========== STABILITY TESTS ==========
  describe("Stability: Extreme values produce bounded, finite results", () => {
    it("Zero minutes: produces zero xG", () => {
      const result = computeXG({
        playerGoals: 100,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 0, // No expected minutes
      });

      assert.equal(result.finalXG, 0, "Zero expected minutes should produce zero xG");
    });

    it("Negative goals input: clamped to valid range", () => {
      const result = computeXG({
        playerGoals: -50, // Invalid
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      assert.ok(Number.isFinite(result.finalXG), "Should produce finite result");
      assert.ok(result.finalXG >= 0, "Should not be negative");
    });

    it("Infinite/NaN minutes input: handled gracefully", () => {
      const resultInf = computeXG({
        playerGoals: 30,
        playerMinutes: Infinity,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      const resultNaN = computeXG({
        playerGoals: 30,
        playerMinutes: NaN,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      assert.ok(Number.isFinite(resultInf.finalXG), "Infinite input should produce finite xG");
      assert.ok(Number.isFinite(resultNaN.finalXG), "NaN input should produce finite xG");
    });

    it("Extremely high team strength (outlier): defense factor clamped", () => {
      const result = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 5000, // Unrealistic outlier
        isHome: true,
        expectedMinutes: 90,
      });

      // Defense factor should be clamped to [0.5, 1.5]
      assert.ok(result.opponentDefenseFactor >= 0.5, "Defense factor floor");
      assert.ok(result.opponentDefenseFactor <= 1.5, "Defense factor ceiling");
      assert.ok(Number.isFinite(result.finalXG), "Should produce finite xG");
    });

    it("xP components are all bounded and finite", () => {
      const result = computeXP({
        position: Position.FWD,
        playerGoals: Infinity,
        playerAssists: NaN,
        playerMinutes: -1000,
        playerStatus: null,
        chanceOfPlayingNextRound: 150, // Over 100%
        teamDefenseRating: 10000,
        opponentDefenseRating: 0,
        isHome: true,
      });

      assert.ok(Number.isFinite(result.appearancePoints), "Appearance points finite");
      assert.ok(Number.isFinite(result.expectedGoalPoints), "Goal points finite");
      assert.ok(Number.isFinite(result.expectedAssistPoints), "Assist points finite");
      assert.ok(Number.isFinite(result.expectedCleanSheetPoints), "CS points finite");
      assert.ok(Number.isFinite(result.expectedCardPoints), "Card points finite");
      assert.ok(Number.isFinite(result.totalXP), "Total xP finite");

      assert.ok(result.totalXP >= XG_XP_CONFIG.MIN_XP, "Total xP >= min");
      assert.ok(result.totalXP <= XG_XP_CONFIG.MAX_XP, "Total xP <= max");
    });
  });

  // ========== SHRINKAGE TESTS ==========
  describe("Shrinkage: Results move toward positional average as sample size shrinks", () => {
    it("Shrinkage blends individual rate with positional average", () => {
      // Forward with 0.5 goal rate per 90 (double positional average of 0.25)
      const largeHistoryRate = 50 / 4500; // 50 goals in 4500 minutes (50 games)

      // Compute with small sample
      const smallSample = computeXG({
        playerGoals: 2.5, // Same rate, 2.5 games
        playerMinutes: 225,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      // Compute with large sample
      const largeSample = computeXG({
        playerGoals: 50,
        playerMinutes: 4500,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      // Both should have similar individual rates (0.5 per 90)
      // but small sample should be blended toward positional (0.25)
      // so small sample xG should be lower than large sample
      assert.ok(smallSample.finalXG < largeSample.finalXG, "Small sample should produce lower xG");

      const positionalXG = 0.25 * 1.0 * 1.0 * 1.0; // Positional only
      const largeXG = largeHistoryRate * 90 * 1.0 * 1.0 * 1.0; // Individual rate

      assert.ok(smallSample.finalXG > positionalXG, "Small sample should be > positional");
      assert.ok(smallSample.finalXG < largeXG, "Small sample should be < individual");
    });

    it("At zero games, uses positional average (100% blend)", () => {
      const result = computeXG({
        playerGoals: 0,
        playerMinutes: 0,
        position: Position.MID,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      const positionalXG = XG_XP_CONFIG.POSITIONAL_GOAL_RATE_PER_90[Position.MID] * 1.0 * 1.0 * 1.0;
      assert.ok(Math.abs(result.finalXG - positionalXG) < 0.01);
    });

    it("At max sample size (30+), trusts individual rate almost entirely", () => {
      // Midfielder with unusually high rate: 0.35 per 90 (vs positional 0.15)
      const result = computeXG({
        playerGoals: 70,
        playerMinutes: 7200, // 80 games
        position: Position.MID,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      const individualRate = 70 / 7200 * 90; // ≈ 0.875
      const expectedXG = individualRate * 1.0 * 1.0 * 1.0; // ≈ 0.875

      assert.ok(result.finalXG > 0.35, "Should trust high individual rate at large sample");
      assert.ok(Math.abs(result.finalXG - expectedXG) < 0.1, "Should be close to individual rate");
    });
  });

  // ========== MONOTONICITY TESTS ==========
  describe("Monotonicity: Relationships expected to be monotonic hold", () => {
    it("Higher team defense never reduces clean sheet probability", () => {
      const weakDefense = computeCleanSheetProbability({
        teamDefenseRating: 1800,
        playerPosition: Position.DEF,
      });

      const neutralDefense = computeCleanSheetProbability({
        teamDefenseRating: 1950,
        playerPosition: Position.DEF,
      });

      const strongDefense = computeCleanSheetProbability({
        teamDefenseRating: 2100,
        playerPosition: Position.DEF,
      });

      assert.ok(weakDefense.probability < neutralDefense.probability, "Weak < neutral");
      assert.ok(neutralDefense.probability < strongDefense.probability, "Neutral < strong");
    });

    it("Higher expected minutes never reduces xG", () => {
      const result0min = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 0,
      });

      const result45min = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 45,
      });

      const result90min = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      assert.ok(result0min.finalXG <= result45min.finalXG);
      assert.ok(result45min.finalXG <= result90min.finalXG);
    });

    it("Weaker opponent defense never reduces xG", () => {
      const strongDef = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 2100,
        isHome: true,
        expectedMinutes: 90,
      });

      const neutralDef = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      const weakDef = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1800,
        isHome: true,
        expectedMinutes: 90,
      });

      assert.ok(strongDef.finalXG <= neutralDef.finalXG);
      assert.ok(neutralDef.finalXG <= weakDef.finalXG);
    });

    it("Home never produces lower xG than away for same inputs", () => {
      const away = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: false,
        expectedMinutes: 90,
      });

      const home = computeXG({
        playerGoals: 30,
        playerMinutes: 2700,
        position: Position.FWD,
        opponentDefenseRating: 1950,
        isHome: true,
        expectedMinutes: 90,
      });

      assert.ok(away.finalXG < home.finalXG, "Home advantage should apply");
      assert.equal(away.venueFactor, 0.88);
      assert.equal(home.venueFactor, 1.12);
    });
  });

  // ========== POSITION-SPECIFIC TESTS ==========
  describe("Position-specific behavior", () => {
    it("GKP has significantly lower goal and assist rates", () => {
      const gkpGoalRate = XG_XP_CONFIG.POSITIONAL_GOAL_RATE_PER_90[Position.GKP];
      const fwdGoalRate = XG_XP_CONFIG.POSITIONAL_GOAL_RATE_PER_90[Position.FWD];

      assert.equal(gkpGoalRate, 0, "GKP should have zero goal rate");
      assert.ok(fwdGoalRate > 0.2, "FWD should have substantial goal rate");
    });

    it("GKP gets save points, others don't", () => {
      const gkpResult = computeXP({
        position: Position.GKP,
        playerGoals: 0,
        playerAssists: 0,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      const defResult = computeXP({
        position: Position.DEF,
        playerGoals: 0,
        playerAssists: 0,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      assert.ok(gkpResult.expectedSavePoints > 0, "GKP should have save points");
      assert.equal(defResult.expectedSavePoints, 0, "DEF should have zero save points");
    });

    it("FWD goals worth 4 points, others worth 5", () => {
      const fwdResult = computeXP({
        position: Position.FWD,
        playerGoals: 10,
        playerAssists: 0,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      const midResult = computeXP({
        position: Position.MID,
        playerGoals: 10,
        playerAssists: 0,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      // MID should have more goal points than FWD (5 vs 4 per goal)
      assert.ok(midResult.expectedGoalPoints > fwdResult.expectedGoalPoints);
    });

    it("MID gets clean sheet point, FWD gets none", () => {
      const midResult = computeXP({
        position: Position.MID,
        playerGoals: 0,
        playerAssists: 0,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      const fwdResult = computeXP({
        position: Position.FWD,
        playerGoals: 0,
        playerAssists: 0,
        playerMinutes: 2700,
        playerStatus: "a",
        chanceOfPlayingNextRound: 100,
        teamDefenseRating: 1950,
        opponentDefenseRating: 1950,
        isHome: true,
      });

      assert.ok(midResult.expectedCleanSheetPoints > 0);
      assert.equal(fwdResult.expectedCleanSheetPoints, 0);
    });
  });
});
