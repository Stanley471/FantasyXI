import { Position } from "../types/index.js";

export type ScoringPresetName = "CLASSIC_FPL" | "ALL_ATTACK" | "DEFENSIVE_MASTERMIND";

export interface PositionPointWeights {
  [Position.GKP]: number;
  [Position.DEF]: number;
  [Position.MID]: number;
  [Position.FWD]: number;
}

export interface LeagueScoringConfig {
  preset?: ScoringPresetName | "CUSTOM";
  appearanceUnder60: number;
  appearance60Plus: number;
  goalsScored: PositionPointWeights;
  assists: number;
  cleanSheets: PositionPointWeights;
  /** Number of saves required per 1 save point (default: 3) */
  savesPerPoint: number;
  /** Points awarded per save milestone (default: 1) */
  saveMilestonePoints: number;
  penaltySaved: number;
  penaltyMissed: number;
  /** Goals conceded threshold per penalty increment (default: 2) */
  goalsConcededThreshold: number;
  /** Points applied per goalsConcededThreshold for GKP/DEF (default: -1) */
  goalsConcededPenalty: PositionPointWeights;
  yellowCard: number;
  redCard: number;
  ownGoal: number;
  /** Multiplier for bonus points (1 = standard BPS bonus, 0 = disable bonus, 2 = double bonus) */
  bonusMultiplier: number;
  captainMultiplier: number;
  tripleCaptainMultiplier: number;
}

export interface RawPlayerMatchStats {
  playerId: number;
  position: Position;
  minutes: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
}

export class ScoringConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoringConfigValidationError";
  }
}

export const SCORING_PRESETS: Record<ScoringPresetName, LeagueScoringConfig> = {
  CLASSIC_FPL: {
    preset: "CLASSIC_FPL",
    appearanceUnder60: 1,
    appearance60Plus: 2,
    goalsScored: {
      [Position.GKP]: 6,
      [Position.DEF]: 6,
      [Position.MID]: 5,
      [Position.FWD]: 4,
    },
    assists: 3,
    cleanSheets: {
      [Position.GKP]: 4,
      [Position.DEF]: 4,
      [Position.MID]: 1,
      [Position.FWD]: 0,
    },
    savesPerPoint: 3,
    saveMilestonePoints: 1,
    penaltySaved: 5,
    penaltyMissed: -2,
    goalsConcededThreshold: 2,
    goalsConcededPenalty: {
      [Position.GKP]: -1,
      [Position.DEF]: -1,
      [Position.MID]: 0,
      [Position.FWD]: 0,
    },
    yellowCard: -1,
    redCard: -3,
    ownGoal: -2,
    bonusMultiplier: 1,
    captainMultiplier: 2,
    tripleCaptainMultiplier: 3,
  },

  ALL_ATTACK: {
    preset: "ALL_ATTACK",
    appearanceUnder60: 1,
    appearance60Plus: 2,
    goalsScored: {
      [Position.GKP]: 10,
      [Position.DEF]: 8,
      [Position.MID]: 7,
      [Position.FWD]: 6,
    },
    assists: 5,
    cleanSheets: {
      [Position.GKP]: 2,
      [Position.DEF]: 2,
      [Position.MID]: 0,
      [Position.FWD]: 0,
    },
    savesPerPoint: 4,
    saveMilestonePoints: 1,
    penaltySaved: 5,
    penaltyMissed: -3,
    goalsConcededThreshold: 2,
    goalsConcededPenalty: {
      [Position.GKP]: 0,
      [Position.DEF]: 0,
      [Position.MID]: 0,
      [Position.FWD]: 0,
    },
    yellowCard: -1,
    redCard: -3,
    ownGoal: -2,
    bonusMultiplier: 1.5,
    captainMultiplier: 2,
    tripleCaptainMultiplier: 3,
  },

  DEFENSIVE_MASTERMIND: {
    preset: "DEFENSIVE_MASTERMIND",
    appearanceUnder60: 1,
    appearance60Plus: 3,
    goalsScored: {
      [Position.GKP]: 8,
      [Position.DEF]: 7,
      [Position.MID]: 5,
      [Position.FWD]: 4,
    },
    assists: 3,
    cleanSheets: {
      [Position.GKP]: 7,
      [Position.DEF]: 6,
      [Position.MID]: 2,
      [Position.FWD]: 1,
    },
    savesPerPoint: 2,
    saveMilestonePoints: 2,
    penaltySaved: 7,
    penaltyMissed: -2,
    goalsConcededThreshold: 2,
    goalsConcededPenalty: {
      [Position.GKP]: -2,
      [Position.DEF]: -2,
      [Position.MID]: -1,
      [Position.FWD]: 0,
    },
    yellowCard: -1,
    redCard: -4,
    ownGoal: -3,
    bonusMultiplier: 1,
    captainMultiplier: 2,
    tripleCaptainMultiplier: 3,
  },
};

/**
 * Validates a custom or preset league scoring configuration.
 * Throws `ScoringConfigValidationError` if any weight violates domain invariants.
 */
export function validateLeagueScoringConfig(
  input: Partial<LeagueScoringConfig>
): LeagueScoringConfig {
  const basePreset =
    input.preset && input.preset !== "CUSTOM" && SCORING_PRESETS[input.preset]
      ? SCORING_PRESETS[input.preset]
      : SCORING_PRESETS.CLASSIC_FPL;

  const merged: LeagueScoringConfig = {
    ...basePreset,
    ...input,
    goalsScored: {
      ...basePreset.goalsScored,
      ...(input.goalsScored ?? {}),
    },
    cleanSheets: {
      ...basePreset.cleanSheets,
      ...(input.cleanSheets ?? {}),
    },
    goalsConcededPenalty: {
      ...basePreset.goalsConcededPenalty,
      ...(input.goalsConcededPenalty ?? {}),
    },
  };

  for (const pos of [Position.GKP, Position.DEF, Position.MID, Position.FWD]) {
    const goalPts = merged.goalsScored[pos];
    if (typeof goalPts !== "number" || !Number.isFinite(goalPts) || goalPts < 0 || goalPts > 50) {
      throw new ScoringConfigValidationError(
        `Invalid goalsScored weight for ${pos}: must be between 0 and 50`
      );
    }

    const csPts = merged.cleanSheets[pos];
    if (typeof csPts !== "number" || !Number.isFinite(csPts) || csPts < 0 || csPts > 30) {
      throw new ScoringConfigValidationError(
        `Invalid cleanSheets weight for ${pos}: must be between 0 and 30`
      );
    }

    const gcPen = merged.goalsConcededPenalty[pos];
    if (typeof gcPen !== "number" || !Number.isFinite(gcPen) || gcPen > 0 || gcPen < -20) {
      throw new ScoringConfigValidationError(
        `Invalid goalsConcededPenalty for ${pos}: must be <= 0 and >= -20`
      );
    }
  }

  if (merged.assists < 0 || merged.assists > 30) {
    throw new ScoringConfigValidationError("Assists points must be between 0 and 30");
  }

  if (merged.appearanceUnder60 < 0 || merged.appearance60Plus < merged.appearanceUnder60) {
    throw new ScoringConfigValidationError(
      "Appearance points must be non-negative and appearance60Plus >= appearanceUnder60"
    );
  }

  if (merged.savesPerPoint <= 0 || merged.savesPerPoint > 20) {
    throw new ScoringConfigValidationError("savesPerPoint must be between 1 and 20");
  }

  if (merged.goalsConcededThreshold <= 0 || merged.goalsConcededThreshold > 10) {
    throw new ScoringConfigValidationError("goalsConcededThreshold must be between 1 and 10");
  }

  if (merged.yellowCard > 0 || merged.redCard > 0 || merged.ownGoal > 0) {
    throw new ScoringConfigValidationError(
      "Disciplinary cards and own goals cannot award positive points"
    );
  }

  if (merged.captainMultiplier < 1 || merged.captainMultiplier > 5) {
    throw new ScoringConfigValidationError("captainMultiplier must be between 1 and 5");
  }

  if (
    merged.tripleCaptainMultiplier < merged.captainMultiplier ||
    merged.tripleCaptainMultiplier > 10
  ) {
    throw new ScoringConfigValidationError(
      "tripleCaptainMultiplier must be >= captainMultiplier and <= 10"
    );
  }

  return merged;
}

export type CompiledPlayerScorer = (stats: RawPlayerMatchStats) => number;

/**
 * Compiles and caches fast scoring evaluators per league configuration so
 * calculating 10,000+ squads in a league avoids repeated JSON parsing and validation.
 */
export class LeagueScoringRuleEngine {
  private static readonly compiledCache = new Map<string, CompiledPlayerScorer>();

  public static resolveConfig(
    configOrPreset?: Partial<LeagueScoringConfig> | ScoringPresetName | null
  ): LeagueScoringConfig {
    if (!configOrPreset) {
      return SCORING_PRESETS.CLASSIC_FPL;
    }
    if (typeof configOrPreset === "string") {
      const preset = SCORING_PRESETS[configOrPreset];
      if (!preset) {
        throw new ScoringConfigValidationError(`Unknown scoring preset: ${configOrPreset}`);
      }
      return preset;
    }
    return validateLeagueScoringConfig(configOrPreset);
  }

  public static compileScorer(
    configOrPreset?: Partial<LeagueScoringConfig> | ScoringPresetName | null
  ): CompiledPlayerScorer {
    const config = LeagueScoringRuleEngine.resolveConfig(configOrPreset);
    const cacheKey = JSON.stringify(config);

    const cached = LeagueScoringRuleEngine.compiledCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const scorer: CompiledPlayerScorer = (stats: RawPlayerMatchStats): number => {
      if (stats.minutes <= 0) {
        return 0;
      }

      let points =
        stats.minutes >= 60 ? config.appearance60Plus : config.appearanceUnder60;

      points += stats.goalsScored * config.goalsScored[stats.position];
      points += stats.assists * config.assists;

      if (stats.minutes >= 60 && stats.cleanSheets > 0) {
        points += stats.cleanSheets * config.cleanSheets[stats.position];
      }

      if (stats.position === Position.GKP && stats.saves > 0) {
        points +=
          Math.floor(stats.saves / config.savesPerPoint) * config.saveMilestonePoints;
      }

      points += stats.penaltiesSaved * config.penaltySaved;
      points += stats.penaltiesMissed * config.penaltyMissed;

      if (stats.goalsConceded > 0) {
        const penaltySteps = Math.floor(
          stats.goalsConceded / config.goalsConcededThreshold
        );
        points += penaltySteps * config.goalsConcededPenalty[stats.position];
      }

      points += stats.yellowCards * config.yellowCard;
      points += stats.redCards * config.redCard;
      points += stats.ownGoals * config.ownGoal;
      points += Math.round(stats.bonus * config.bonusMultiplier);

      return points;
    };

    LeagueScoringRuleEngine.compiledCache.set(cacheKey, scorer);
    return scorer;
  }

  public static getCacheSize(): number {
    return LeagueScoringRuleEngine.compiledCache.size;
  }

  public static clearCache(): void {
    LeagueScoringRuleEngine.compiledCache.clear();
  }
}
