import { Position } from "../types/index.js";

export type ScoringPreset =
  | "CLASSIC_FPL"
  | "ALL_ATTACK"
  | "DEFENSIVE_MASTERMIND";

export interface LeagueScoringConfig {
  version: 1;
  appearance: {
    underSixtyMinutes: number;
    sixtyOrMoreMinutes: number;
  };
  goals: Record<Position, number>;
  assists: number;
  cleanSheets: Record<Position, number>;
  goalsConcededPerTwo: Record<Position, number>;
  savesPerThree: number;
  penaltySaves: number;
  penaltyMisses: number;
  yellowCards: number;
  redCards: number;
  ownGoals: number;
  bonus: number;
}

const makePreset = (
  overrides: Partial<LeagueScoringConfig> = {}
): LeagueScoringConfig => ({
  version: 1,
  appearance: { underSixtyMinutes: 1, sixtyOrMoreMinutes: 2 },
  goals: {
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
  goalsConcededPerTwo: {
    [Position.GKP]: -1,
    [Position.DEF]: -1,
    [Position.MID]: 0,
    [Position.FWD]: 0,
  },
  savesPerThree: 1,
  penaltySaves: 5,
  penaltyMisses: -2,
  yellowCards: -1,
  redCards: -3,
  ownGoals: -2,
  bonus: 1,
  ...overrides,
});

export const LEAGUE_SCORING_PRESETS: Readonly<
  Record<ScoringPreset, LeagueScoringConfig>
> = Object.freeze({
  CLASSIC_FPL: makePreset(),
  ALL_ATTACK: makePreset({
    goals: {
      [Position.GKP]: 10,
      [Position.DEF]: 8,
      [Position.MID]: 7,
      [Position.FWD]: 6,
    },
    assists: 5,
    penaltySaves: 3,
    cleanSheets: {
      [Position.GKP]: 2,
      [Position.DEF]: 2,
      [Position.MID]: 1,
      [Position.FWD]: 0,
    },
  }),
  DEFENSIVE_MASTERMIND: makePreset({
    cleanSheets: {
      [Position.GKP]: 8,
      [Position.DEF]: 7,
      [Position.MID]: 2,
      [Position.FWD]: 0,
    },
    goalsConcededPerTwo: {
      [Position.GKP]: -2,
      [Position.DEF]: -2,
      [Position.MID]: 0,
      [Position.FWD]: 0,
    },
    savesPerThree: 2,
    penaltySaves: 8,
  }),
});

const positions = Object.values(Position);
const nonNegativeFields = [
  "assists",
  "savesPerThree",
  "penaltySaves",
  "bonus",
] as const;
const nonPositiveFields = [
  "penaltyMisses",
  "yellowCards",
  "redCards",
  "ownGoals",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${path} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return value;
}

function readPositionWeights(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): Record<Position, number> {
  if (!isRecord(value)) {
    throw new Error(`${path} must contain a weight for every position`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== positions.length ||
    positions.some((position) => !Object.prototype.hasOwnProperty.call(value, position))
  ) {
    throw new Error(`${path} must contain exactly GKP, DEF, MID, and FWD`);
  }
  return Object.fromEntries(
    positions.map((position) => [
      position,
      readInteger(value[position], `${path}.${position}`, minimum, maximum),
    ])
  ) as Record<Position, number>;
}

function readFlatWeights(
  input: Record<string, unknown>,
  fields: readonly string[],
  minimum: number,
  maximum: number
): Record<string, number> {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      readInteger(input[field], field, minimum, maximum),
    ])
  );
}

/**
 * Validates and returns a canonical scoring config, rejecting unknown fields and
 * invalid reward/penalty signs before league settings are persisted.
 */
export function parseLeagueScoringConfig(input: unknown): LeagueScoringConfig {
  if (!isRecord(input)) {
    throw new Error("Scoring config must be an object");
  }
  const expectedKeys = [
    "version",
    "appearance",
    "goals",
    "assists",
    "cleanSheets",
    "goalsConcededPerTwo",
    "savesPerThree",
    "penaltySaves",
    "penaltyMisses",
    "yellowCards",
    "redCards",
    "ownGoals",
    "bonus",
  ];
  if (
    Object.keys(input).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
  ) {
    throw new Error("Scoring config contains missing or unknown fields");
  }
  if (input.version !== 1) {
    throw new Error("Scoring config version must be 1");
  }
  if (!isRecord(input.appearance)) {
    throw new Error("appearance must contain underSixtyMinutes and sixtyOrMoreMinutes");
  }
  const appearanceKeys = Object.keys(input.appearance);
  if (
    appearanceKeys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(input.appearance, "underSixtyMinutes") ||
    !Object.prototype.hasOwnProperty.call(input.appearance, "sixtyOrMoreMinutes")
  ) {
    throw new Error("appearance contains missing or unknown fields");
  }
  const flatWeights = readFlatWeights(
    input,
    nonNegativeFields,
    0,
    100
  );
  Object.assign(
    flatWeights,
    readFlatWeights(input, nonPositiveFields, -100, 0)
  );

  return {
    version: 1,
    appearance: {
      underSixtyMinutes: readInteger(
        input.appearance.underSixtyMinutes,
        "appearance.underSixtyMinutes",
        0,
        100
      ),
      sixtyOrMoreMinutes: readInteger(
        input.appearance.sixtyOrMoreMinutes,
        "appearance.sixtyOrMoreMinutes",
        0,
        100
      ),
    },
    goals: readPositionWeights(input.goals, "goals", 0, 100),
    assists: flatWeights.assists,
    cleanSheets: readPositionWeights(input.cleanSheets, "cleanSheets", 0, 100),
    goalsConcededPerTwo: readPositionWeights(
      input.goalsConcededPerTwo,
      "goalsConcededPerTwo",
      -100,
      0
    ),
    savesPerThree: flatWeights.savesPerThree,
    penaltySaves: flatWeights.penaltySaves,
    penaltyMisses: flatWeights.penaltyMisses,
    yellowCards: flatWeights.yellowCards,
    redCards: flatWeights.redCards,
    ownGoals: flatWeights.ownGoals,
    bonus: flatWeights.bonus,
  };
}

export function resolveLeagueScoringConfig(options: {
  scoringConfig?: unknown;
  scoringPreset?: unknown;
}): LeagueScoringConfig | null {
  if (options.scoringConfig !== undefined && options.scoringPreset !== undefined) {
    throw new Error("Choose either scoringConfig or scoringPreset, not both");
  }
  if (options.scoringConfig !== undefined) {
    return parseLeagueScoringConfig(options.scoringConfig);
  }
  if (options.scoringPreset !== undefined) {
    if (
      typeof options.scoringPreset !== "string" ||
      !Object.prototype.hasOwnProperty.call(
        LEAGUE_SCORING_PRESETS,
        options.scoringPreset
      )
    ) {
      throw new Error(`Unknown scoring preset: ${String(options.scoringPreset)}`);
    }
    return parseLeagueScoringConfig(
      LEAGUE_SCORING_PRESETS[options.scoringPreset as ScoringPreset]
    );
  }
  return null;
}
