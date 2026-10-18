/**
 * LeagueScoringConfig: custom per-league scoring rules (issue #272).
 *
 * A private league may replace official FPL points with its own point values
 * for every standard match event. The config is stored as JSON on the league
 * (`leagues.scoring_config`); `null` means official FPL scoring, which keeps
 * the existing scoring path untouched.
 *
 * Validation enforces the direction of every rule, so a league cannot be
 * configured with nonsensical values (e.g. negative points for goals or
 * positive points for red cards), and bounds every value to keep totals sane.
 */

export const SCORING_POSITIONS = ["GKP", "DEF", "MID", "FWD"] as const;
export type ScoringPosition = (typeof SCORING_POSITIONS)[number];

export type PositionalPoints = Record<ScoringPosition, number>;

export const SCORING_PRESET_NAMES = ["CLASSIC_FPL", "ALL_ATTACK", "DEFENSIVE_MASTERMIND"] as const;
export type ScoringPresetName = (typeof SCORING_PRESET_NAMES)[number];

export interface LeagueScoringConfig {
  /** Schema version, so stored configs can be migrated if the shape changes. */
  version: 1;
  /** Preset this config was derived from (informational). */
  preset: ScoringPresetName | "CUSTOM";
  /** Played 1-59 minutes. */
  appearance: number;
  /** Played 60+ minutes (awarded instead of `appearance`). */
  appearance60: number;
  goal: PositionalPoints;
  assist: number;
  /** Awarded only with 60+ minutes played, as in FPL. */
  cleanSheet: PositionalPoints;
  /** Points per 2 goals conceded (zero or negative). */
  goalsConcededPer2: PositionalPoints;
  /** Points per 3 saves. */
  savesPer3: number;
  penaltySave: number;
  penaltyMiss: number;
  yellowCard: number;
  redCard: number;
  ownGoal: number;
  /** Multiplier applied to FPL bonus points (0 disables bonus). */
  bonusMultiplier: number;
}

export type ScoringRuleKey = Exclude<keyof LeagueScoringConfig, "version" | "preset">;

/** Rules that reward an event: must be >= 0 (goals must be >= 1). */
const REWARD_RULES = ["appearance", "appearance60", "assist", "savesPer3", "penaltySave"] as const;
const REWARD_POSITIONAL_RULES = ["goal", "cleanSheet"] as const;
/** Rules that punish an event: must be <= 0. */
const PENALTY_RULES = ["penaltyMiss", "yellowCard", "redCard", "ownGoal"] as const;
const PENALTY_POSITIONAL_RULES = ["goalsConcededPer2"] as const;

export const MAX_RULE_MAGNITUDE = 20;
export const MAX_BONUS_MULTIPLIER = 3;

const RULE_KEYS: readonly ScoringRuleKey[] = [
  ...REWARD_RULES,
  ...REWARD_POSITIONAL_RULES,
  ...PENALTY_RULES,
  ...PENALTY_POSITIONAL_RULES,
  "bonusMultiplier",
];

const POSITIONAL_KEYS = new Set<string>([...REWARD_POSITIONAL_RULES, ...PENALTY_POSITIONAL_RULES]);

/** Official FPL point values; also the reference used by the zero-overhead default path. */
const CLASSIC_FPL: LeagueScoringConfig = {
  version: 1,
  preset: "CLASSIC_FPL",
  appearance: 1,
  appearance60: 2,
  goal: { GKP: 10, DEF: 6, MID: 5, FWD: 4 },
  assist: 3,
  cleanSheet: { GKP: 4, DEF: 4, MID: 1, FWD: 0 },
  goalsConcededPer2: { GKP: -1, DEF: -1, MID: 0, FWD: 0 },
  savesPer3: 1,
  penaltySave: 5,
  penaltyMiss: -2,
  yellowCard: -1,
  redCard: -3,
  ownGoal: -2,
  bonusMultiplier: 1,
};

export const SCORING_PRESETS: Readonly<Record<ScoringPresetName, LeagueScoringConfig>> = {
  CLASSIC_FPL,
  /** Rewards attacking returns from every position; defensive returns shrink. */
  ALL_ATTACK: {
    ...CLASSIC_FPL,
    preset: "ALL_ATTACK",
    goal: { GKP: 12, DEF: 8, MID: 7, FWD: 6 },
    assist: 5,
    cleanSheet: { GKP: 2, DEF: 2, MID: 0, FWD: 0 },
    goalsConcededPer2: { GKP: 0, DEF: 0, MID: 0, FWD: 0 },
  },
  /** Clean sheets, saves and penalty saves dominate; cards hurt more. */
  DEFENSIVE_MASTERMIND: {
    ...CLASSIC_FPL,
    preset: "DEFENSIVE_MASTERMIND",
    goal: { GKP: 10, DEF: 7, MID: 4, FWD: 3 },
    cleanSheet: { GKP: 6, DEF: 6, MID: 2, FWD: 1 },
    goalsConcededPer2: { GKP: -2, DEF: -2, MID: 0, FWD: 0 },
    savesPer3: 2,
    penaltySave: 7,
    yellowCard: -2,
    redCard: -5,
  },
};

export const SCORING_PRESET_DESCRIPTIONS: Record<ScoringPresetName, string> = {
  CLASSIC_FPL: "Official Fantasy Premier League point values",
  ALL_ATTACK: "Bigger rewards for goals and assists, smaller defensive returns",
  DEFENSIVE_MASTERMIND: "Clean sheets, saves and discipline decide the league",
};

export class ScoringConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid scoring rules: ${issues.join("; ")}`);
    this.name = "ScoringConfigValidationError";
  }
}

/** Request shape: start from a preset (default CLASSIC_FPL) and override individual rules. */
export interface LeagueScoringConfigInput {
  preset?: string;
  rules?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkValue(
  issues: string[],
  path: string,
  value: unknown,
  direction: "reward" | "penalty",
  min = 0
): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push(`${path} must be an integer`);
    return;
  }
  if (direction === "reward" && (value < min || value > MAX_RULE_MAGNITUDE)) {
    issues.push(`${path} must be between ${min} and ${MAX_RULE_MAGNITUDE}`);
  }
  if (direction === "penalty" && (value > 0 || value < -MAX_RULE_MAGNITUDE)) {
    issues.push(`${path} must be between -${MAX_RULE_MAGNITUDE} and 0`);
  }
}

/**
 * Validates a complete config. Returns the list of problems (empty when valid);
 * use `assertValidScoringConfig` to throw instead.
 */
export function validateScoringConfig(config: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(config)) return ["scoring config must be an object"];

  for (const key of Object.keys(config)) {
    if (key !== "version" && key !== "preset" && !RULE_KEYS.includes(key as ScoringRuleKey)) {
      issues.push(`unknown scoring rule "${key}"`);
    }
  }
  if (config.version !== 1) issues.push("version must be 1");
  if (
    config.preset !== "CUSTOM" &&
    !(typeof config.preset === "string" && config.preset in SCORING_PRESETS)
  ) {
    issues.push("preset must be a known preset name or CUSTOM");
  }

  for (const key of REWARD_RULES) checkValue(issues, key, config[key], "reward");
  for (const key of PENALTY_RULES) checkValue(issues, key, config[key], "penalty");

  const positional: Array<[string, "reward" | "penalty", number]> = [
    ["goal", "reward", 1],
    ["cleanSheet", "reward", 0],
    ["goalsConcededPer2", "penalty", 0],
  ];
  for (const [key, direction, min] of positional) {
    const value = config[key];
    if (!isPlainObject(value)) {
      issues.push(`${key} must map each position (GKP, DEF, MID, FWD) to points`);
      continue;
    }
    for (const position of Object.keys(value)) {
      if (!SCORING_POSITIONS.includes(position as ScoringPosition)) {
        issues.push(`${key}.${position} is not a valid position`);
      }
    }
    for (const position of SCORING_POSITIONS) {
      checkValue(issues, `${key}.${position}`, value[position], direction, min);
    }
  }

  const bonus = config.bonusMultiplier;
  if (typeof bonus !== "number" || !Number.isInteger(bonus) || bonus < 0 || bonus > MAX_BONUS_MULTIPLIER) {
    issues.push(`bonusMultiplier must be an integer between 0 and ${MAX_BONUS_MULTIPLIER}`);
  }

  if (
    typeof config.appearance === "number" &&
    typeof config.appearance60 === "number" &&
    config.appearance60 < config.appearance
  ) {
    issues.push("appearance60 must be at least appearance");
  }
  if (
    typeof config.yellowCard === "number" &&
    typeof config.redCard === "number" &&
    config.redCard > config.yellowCard
  ) {
    issues.push("redCard must be at least as harsh as yellowCard");
  }

  return issues;
}

export function assertValidScoringConfig(config: unknown): asserts config is LeagueScoringConfig {
  const issues = validateScoringConfig(config);
  if (issues.length > 0) throw new ScoringConfigValidationError(issues);
}

/**
 * Builds a validated config from a preset plus rule overrides. Positional
 * overrides merge per position, so `{ goal: { GKP: 15 } }` changes only GKP.
 */
export function resolveScoringConfig(input: LeagueScoringConfigInput): LeagueScoringConfig {
  if (!isPlainObject(input)) {
    throw new ScoringConfigValidationError(["scoring config must be an object with preset and/or rules"]);
  }
  const presetName = input.preset ?? "CLASSIC_FPL";
  if (typeof presetName !== "string" || !(presetName in SCORING_PRESETS)) {
    throw new ScoringConfigValidationError([
      `unknown preset "${String(presetName)}"; expected one of ${Object.keys(SCORING_PRESETS).join(", ")}`,
    ]);
  }
  const base = SCORING_PRESETS[presetName as ScoringPresetName];
  const rules = input.rules ?? {};
  if (!isPlainObject(rules)) {
    throw new ScoringConfigValidationError(["rules must be an object"]);
  }

  const merged = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(rules)) {
    if (POSITIONAL_KEYS.has(key) && isPlainObject(value)) {
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
    } else {
      merged[key] = value;
    }
  }
  if (Object.keys(rules).length > 0) merged.preset = "CUSTOM";

  assertValidScoringConfig(merged);
  return merged;
}
