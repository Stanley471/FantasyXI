import {
  LeagueScoringConfig,
  SCORING_POSITIONS,
  ScoringPosition,
  assertValidScoringConfig,
} from "../../models/leagueScoringConfig.js";

/**
 * Compiled scoring rules for custom league scoring (issue #272).
 *
 * A LeagueScoringConfig is compiled once into a closure over flat,
 * position-indexed lookup tables, so scoring a player is a handful of
 * multiplications with no object lookups or branching on rule names. Compiled
 * rule sets are cached by a canonical key of their values: leagues sharing
 * identical rules share one compiled function, and re-scoring a league never
 * recompiles.
 */

/** Per-fixture match events, as stored in PlayerGameweekStats. */
export interface ScoringEventStats {
  minutes: number;
  goals: number;
  assists: number;
  cleanSheet: boolean;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
}

export interface CompiledScoringRules {
  /** Canonical identity of the rule values; equal for equal configs. */
  readonly key: string;
  readonly config: LeagueScoringConfig;
  /** Points for one player's appearance in one fixture. */
  score(stats: ScoringEventStats, position: ScoringPosition): number;
}

const POSITION_INDEX: Record<ScoringPosition, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

/** Canonical key: fixed key order, so property order in stored JSON does not matter. */
export function scoringConfigKey(config: LeagueScoringConfig): string {
  const positional = (p: Record<ScoringPosition, number>) =>
    SCORING_POSITIONS.map((pos) => p[pos]).join(",");
  return [
    config.appearance,
    config.appearance60,
    positional(config.goal),
    config.assist,
    positional(config.cleanSheet),
    positional(config.goalsConcededPer2),
    config.savesPer3,
    config.penaltySave,
    config.penaltyMiss,
    config.yellowCard,
    config.redCard,
    config.ownGoal,
    config.bonusMultiplier,
  ].join("|");
}

function compile(config: LeagueScoringConfig, key: string): CompiledScoringRules {
  const goal = SCORING_POSITIONS.map((p) => config.goal[p]);
  const cleanSheet = SCORING_POSITIONS.map((p) => config.cleanSheet[p]);
  const conceded = SCORING_POSITIONS.map((p) => config.goalsConcededPer2[p]);
  const {
    appearance,
    appearance60,
    assist,
    savesPer3,
    penaltySave,
    penaltyMiss,
    yellowCard,
    redCard,
    ownGoal,
    bonusMultiplier,
  } = config;

  return {
    key,
    config,
    score(s: ScoringEventStats, position: ScoringPosition): number {
      if (s.minutes <= 0) return 0;
      const i = POSITION_INDEX[position];
      const fullGame = s.minutes >= 60;
      return (
        (fullGame ? appearance60 : appearance) +
        s.goals * goal[i] +
        s.assists * assist +
        (s.cleanSheet && fullGame ? cleanSheet[i] : 0) +
        Math.floor(s.goalsConceded / 2) * conceded[i] +
        Math.floor(s.saves / 3) * savesPer3 +
        s.penaltiesSaved * penaltySave +
        s.penaltiesMissed * penaltyMiss +
        s.yellowCards * yellowCard +
        s.redCards * redCard +
        s.ownGoals * ownGoal +
        s.bonus * bonusMultiplier
      );
    },
  };
}

const MAX_CACHED_RULE_SETS = 256;
const compiledCache = new Map<string, CompiledScoringRules>();

/**
 * Validates and compiles `config`, reusing the cached compilation for
 * identical rule values. Throws ScoringConfigValidationError for an invalid
 * config (e.g. a stored value edited by hand).
 */
export function compileScoringRules(config: unknown): CompiledScoringRules {
  assertValidScoringConfig(config);
  const key = scoringConfigKey(config);
  const cached = compiledCache.get(key);
  if (cached) return cached;

  const compiled = compile(config, key);
  compiledCache.set(key, compiled);
  if (compiledCache.size > MAX_CACHED_RULE_SETS) {
    const oldest = compiledCache.keys().next().value;
    if (oldest !== undefined) compiledCache.delete(oldest);
  }
  return compiled;
}

/** Test helper: number of distinct compiled rule sets held. */
export function compiledScoringRulesCacheSize(): number {
  return compiledCache.size;
}
