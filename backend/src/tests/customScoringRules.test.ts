import test from "node:test";
import assert from "node:assert/strict";
import { Position, ChipType } from "../types/index.js";
import {
  LeagueScoringRuleEngine,
  RawPlayerMatchStats,
  ScoringConfigValidationError,
  validateLeagueScoringConfig,
} from "../models/leagueScoringConfig.js";
import { ScoringService } from "../services/scoring/scoringService.js";

test("LeagueScoringRuleEngine: evaluates CLASSIC_FPL, ALL_ATTACK, and DEFENSIVE_MASTERMIND presets", () => {
  LeagueScoringRuleEngine.clearCache();

  const gkpStats: RawPlayerMatchStats = {
    playerId: 1,
    position: Position.GKP,
    minutes: 90,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 1,
    goalsConceded: 0,
    ownGoals: 0,
    penaltiesSaved: 1,
    penaltiesMissed: 0,
    yellowCards: 0,
    redCards: 0,
    saves: 6,
    bonus: 3,
  };

  const fwdStats: RawPlayerMatchStats = {
    playerId: 9,
    position: Position.FWD,
    minutes: 90,
    goalsScored: 2,
    assists: 1,
    cleanSheets: 0,
    goalsConceded: 3,
    ownGoals: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    yellowCards: 1,
    redCards: 0,
    saves: 0,
    bonus: 2,
  };

  const classicScorer = LeagueScoringRuleEngine.compileScorer("CLASSIC_FPL");
  const attackScorer = LeagueScoringRuleEngine.compileScorer("ALL_ATTACK");
  const defenseScorer = LeagueScoringRuleEngine.compileScorer("DEFENSIVE_MASTERMIND");

  // CLASSIC_FPL GKP: 2 (90m) + 4 (CS) + 2 (6 saves / 3) + 5 (pen save) + 3 (bonus) = 16
  assert.equal(classicScorer(gkpStats), 16);

  // DEFENSIVE_MASTERMIND GKP: 3 (90m) + 7 (CS) + 6 (6 saves / 2 * 2) + 7 (pen save) + 3 (bonus) = 26
  assert.equal(defenseScorer(gkpStats), 26);

  // CLASSIC_FPL FWD: 2 (90m) + 8 (2 goals * 4) + 3 (1 assist) - 1 (YC) + 2 (bonus) = 14
  assert.equal(classicScorer(fwdStats), 14);

  // ALL_ATTACK FWD: 2 (90m) + 12 (2 goals * 6) + 5 (1 assist) - 1 (YC) + 3 (2 * 1.5 bonus) = 21
  assert.equal(attackScorer(fwdStats), 21);

  // Verify compiled scorer caching reuses identical rule configurations
  assert.equal(LeagueScoringRuleEngine.getCacheSize(), 3);
  const classicScorerAgain = LeagueScoringRuleEngine.compileScorer("CLASSIC_FPL");
  assert.equal(classicScorer, classicScorerAgain);
  assert.equal(LeagueScoringRuleEngine.getCacheSize(), 3);
});

test("validateLeagueScoringConfig: rejects invalid or out-of-bounds rule weights", () => {
  assert.throws(
    () =>
      validateLeagueScoringConfig({
        goalsScored: {
          [Position.GKP]: 6,
          [Position.DEF]: 6,
          [Position.MID]: -2, // negative goal points rejected
          [Position.FWD]: 4,
        },
      }),
    ScoringConfigValidationError
  );

  assert.throws(
    () =>
      validateLeagueScoringConfig({
        savesPerPoint: 0,
      }),
    ScoringConfigValidationError
  );

  assert.throws(
    () =>
      validateLeagueScoringConfig({
        redCard: 2, // positive points for red card rejected
      }),
    ScoringConfigValidationError
  );

  assert.throws(
    () =>
      validateLeagueScoringConfig({
        captainMultiplier: 0.5,
      }),
    ScoringConfigValidationError
  );
});

test("ScoringService.calculateLineupScore: applies custom league scoring rules and captain multipliers", () => {
  const players = [
    {
      playerId: 1,
      position: Position.GKP,
      isStarter: true,
      isCaptain: false,
      isViceCaptain: false,
      positionOrder: 1,
    },
    {
      playerId: 2,
      position: Position.DEF,
      isStarter: true,
      isCaptain: true,
      isViceCaptain: false,
      positionOrder: 2,
    },
  ];

  const rawStatsMap = new Map<number, RawPlayerMatchStats>([
    [
      1,
      {
        playerId: 1,
        position: Position.GKP,
        minutes: 90,
        goalsScored: 0,
        assists: 0,
        cleanSheets: 1,
        goalsConceded: 0,
        ownGoals: 0,
        penaltiesSaved: 0,
        penaltiesMissed: 0,
        yellowCards: 0,
        redCards: 0,
        saves: 4,
        bonus: 0,
      },
    ],
    [
      2,
      {
        playerId: 2,
        position: Position.DEF,
        minutes: 90,
        goalsScored: 1,
        assists: 0,
        cleanSheets: 1,
        goalsConceded: 0,
        ownGoals: 0,
        penaltiesSaved: 0,
        penaltiesMissed: 0,
        yellowCards: 0,
        redCards: 0,
        saves: 0,
        bonus: 0,
      },
    ],
  ]);

  const fallbackStatsMap = new Map<number, { minutes: number; totalPoints: number }>();

  // Evaluate with DEFENSIVE_MASTERMIND + custom 3x regular captain multiplier and 4x Triple Captain
  const result = ScoringService.calculateLineupScore(players, fallbackStatsMap, {
    chip: ChipType.TRIPLE_CAPTAIN,
    scoringConfig: {
      preset: "DEFENSIVE_MASTERMIND",
      captainMultiplier: 2,
      tripleCaptainMultiplier: 4,
    },
    rawStatsMap,
  });

  // GKP in DEFENSIVE_MASTERMIND: 3 (90m) + 7 (CS) + 4 (4 saves / 2 * 2) = 14
  // DEF in DEFENSIVE_MASTERMIND: 3 (90m) + 7 (goal) + 6 (CS) = 16 -> 4x Triple Captain = 64
  assert.equal(result.startingPoints, 14 + 64);
  assert.equal(result.captainPoints, 16 * 3);
  assert.equal(result.totalPoints, 78);
});
