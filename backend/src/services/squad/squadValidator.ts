import { Position, SQUAD_RULES, SquadPlayerSelection } from "../../types/index.js";

/**
 * Custom error thrown when a squad fails domain business rules.
 */
export class SquadValidationError extends Error {
  public errors: string[];

  constructor(errors: string[] | string) {
    const errorList = Array.isArray(errors) ? errors : [errors];
    super(errorList.join("; "));
    this.name = "SquadValidationError";
    this.errors = errorList;
  }
}

/**
 * Custom error thrown when an edit is attempted after the gameweek deadline.
 */
export class SquadLockedError extends Error {
  public deadline: Date;

  constructor(deadline: Date) {
    super(
      `Squad is locked. Gameweek deadline passed on ${deadline.toISOString()}`
    );
    this.name = "SquadLockedError";
    this.deadline = deadline;
  }
}

export interface PlayerForValidation {
  id: number;
  teamId: number;
  position: Position;
  price: number;
  displayName?: string;
}

export interface ValidatedSquadResult {
  totalCost: number;
  formation: string; // e.g. "4-4-2"
  starterIds: number[];
  benchIds: number[];
  captainId: number;
  viceCaptainId: number;
}

export const MIN_SQUAD_NAME_LENGTH = 3;

export class SquadValidator {
  /**
   * Normalizes a squad name: whitespace control characters become spaces,
   * other control/format characters (null bytes, backspaces, zero-width
   * marks) are stripped, runs of whitespace collapse to one space and the
   * result is trimmed.
   */
  public static sanitizeSquadName(name: unknown): string {
    const sanitized = (typeof name === "string" ? name : "")
      .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (/\s/.test(char) ? " " : ""))
      .replace(/\s+/g, " ")
      .trim();
    if (sanitized.length < MIN_SQUAD_NAME_LENGTH) {
      throw new SquadValidationError(
        `Squad name must be at least ${MIN_SQUAD_NAME_LENGTH} characters`
      );
    }
    return sanitized;
  }

  /**
   * Enforces that current timestamp has not passed the gameweek deadline.
   */
  public static validateDeadline(deadline: Date, now: Date = new Date()): void {
    if (now.getTime() >= deadline.getTime()) {
      throw new SquadLockedError(deadline);
    }
  }

  /**
   * Validates all core squad domain rules against player data.
   */
  public static validateSquad(
    selections: SquadPlayerSelection[],
    players: PlayerForValidation[],
    maxBudget: number = SQUAD_RULES.STARTING_BUDGET
  ): ValidatedSquadResult {
    const errors: string[] = [];

    // 1. Total players count
    if (selections.length !== SQUAD_RULES.TOTAL_PLAYERS) {
      errors.push(
        `Squad must contain exactly ${SQUAD_RULES.TOTAL_PLAYERS} players (received ${selections.length})`
      );
    }

    // 2. Duplicate player IDs
    const playerIds = selections.map((s) => s.playerId);
    const uniqueIds = new Set(playerIds);
    if (uniqueIds.size !== playerIds.length) {
      errors.push("Duplicate players are not allowed in a squad");
    }

    // Map players for fast lookup
    const playerMap = new Map<number, PlayerForValidation>();
    for (const p of players) {
      playerMap.set(p.id, p);
    }

    // Check all selected IDs exist in DB
    for (const id of playerIds) {
      if (!playerMap.has(id)) {
        errors.push(`Player with ID ${id} was not found`);
      }
    }

    if (errors.length > 0) {
      throw new SquadValidationError(errors);
    }

    // 3. Starters vs Bench count
    const starters = selections.filter((s) => s.isStarter);
    const bench = selections.filter((s) => !s.isStarter);

    if (starters.length !== SQUAD_RULES.STARTERS) {
      errors.push(
        `Starting XI must have exactly ${SQUAD_RULES.STARTERS} players (found ${starters.length})`
      );
    }

    if (bench.length !== SQUAD_RULES.BENCH) {
      errors.push(
        `Bench must have exactly ${SQUAD_RULES.BENCH} substitutes (found ${bench.length})`
      );
    }

    // 4. Captain and Vice-Captain validation
    const captains = selections.filter((s) => s.isCaptain);
    const viceCaptains = selections.filter((s) => s.isViceCaptain);

    if (captains.length !== 1) {
      errors.push("Squad must have exactly one captain selected");
    }

    if (viceCaptains.length !== 1) {
      errors.push("Squad must have exactly one vice-captain selected");
    }

    if (captains.length === 1 && viceCaptains.length === 1) {
      if (captains[0].playerId === viceCaptains[0].playerId) {
        errors.push("Captain and vice-captain cannot be the same player");
      }
      if (!captains[0].isStarter) {
        errors.push("Captain must be in the starting XI");
      }
      if (!viceCaptains[0].isStarter) {
        errors.push("Vice-captain must be in the starting XI");
      }
    }

    // 5. Position breakdown for entire 15-player squad
    const positionCounts: Record<Position, number> = {
      [Position.GKP]: 0,
      [Position.DEF]: 0,
      [Position.MID]: 0,
      [Position.FWD]: 0,
    };

    let totalCost = 0.0;
    const teamCounts = new Map<number, number>();

    for (const sel of selections) {
      const p = playerMap.get(sel.playerId)!;
      positionCounts[p.position]++;
      totalCost += Number(p.price);

      const currentTeamCount = teamCounts.get(p.teamId) || 0;
      teamCounts.set(p.teamId, currentTeamCount + 1);
    }

    // Round totalCost to 1 decimal place to avoid floating point imprecision
    totalCost = Math.round(totalCost * 10) / 10;

    // Check squad position quotas
    if (positionCounts[Position.GKP] !== SQUAD_RULES.POSITION_COUNTS.GKP) {
      errors.push(
        `Squad must have exactly ${SQUAD_RULES.POSITION_COUNTS.GKP} goalkeepers (found ${positionCounts[Position.GKP]})`
      );
    }
    if (positionCounts[Position.DEF] !== SQUAD_RULES.POSITION_COUNTS.DEF) {
      errors.push(
        `Squad must have exactly ${SQUAD_RULES.POSITION_COUNTS.DEF} defenders (found ${positionCounts[Position.DEF]})`
      );
    }
    if (positionCounts[Position.MID] !== SQUAD_RULES.POSITION_COUNTS.MID) {
      errors.push(
        `Squad must have exactly ${SQUAD_RULES.POSITION_COUNTS.MID} midfielders (found ${positionCounts[Position.MID]})`
      );
    }
    if (positionCounts[Position.FWD] !== SQUAD_RULES.POSITION_COUNTS.FWD) {
      errors.push(
        `Squad must have exactly ${SQUAD_RULES.POSITION_COUNTS.FWD} forwards (found ${positionCounts[Position.FWD]})`
      );
    }

    // 6. Budget validation (£100.0m maximum, or available funds for transfers)
    if (totalCost > maxBudget) {
      errors.push(
        `Squad budget exceeded: Total cost is £${totalCost.toFixed(1)}m (max allowed is £${maxBudget.toFixed(1)}m)`
      );
    }

    // 7. Team quota validation (max 3 players from any single club)
    for (const [teamId, count] of teamCounts.entries()) {
      if (count > SQUAD_RULES.MAX_PER_TEAM) {
        errors.push(
          `Maximum ${SQUAD_RULES.MAX_PER_TEAM} players allowed from a single team (team ID ${teamId} has ${count})`
        );
      }
    }

    // 8. Starting XI Formation validation
    const starterPositions: Record<Position, number> = {
      [Position.GKP]: 0,
      [Position.DEF]: 0,
      [Position.MID]: 0,
      [Position.FWD]: 0,
    };

    for (const sel of starters) {
      const p = playerMap.get(sel.playerId)!;
      starterPositions[p.position]++;
    }

    if (starterPositions[Position.GKP] !== 1) {
      errors.push(
        `Starting XI must have exactly 1 goalkeeper (found ${starterPositions[Position.GKP]})`
      );
    }

    if (starterPositions[Position.DEF] < SQUAD_RULES.MIN_STARTERS.DEF) {
      errors.push(
        `Starting XI must have at least ${SQUAD_RULES.MIN_STARTERS.DEF} defenders (found ${starterPositions[Position.DEF]})`
      );
    }

    if (starterPositions[Position.MID] < SQUAD_RULES.MIN_STARTERS.MID) {
      errors.push(
        `Starting XI must have at least ${SQUAD_RULES.MIN_STARTERS.MID} midfielders (found ${starterPositions[Position.MID]})`
      );
    }

    if (starterPositions[Position.FWD] < SQUAD_RULES.MIN_STARTERS.FWD) {
      errors.push(
        `Starting XI must have at least ${SQUAD_RULES.MIN_STARTERS.FWD} forwards (found ${starterPositions[Position.FWD]})`
      );
    }

    if (errors.length > 0) {
      throw new SquadValidationError(errors);
    }

    const formation = `${starterPositions[Position.DEF]}-${starterPositions[Position.MID]}-${starterPositions[Position.FWD]}`;

    return {
      totalCost,
      formation,
      starterIds: starters.map((s) => s.playerId),
      benchIds: bench.map((s) => s.playerId),
      captainId: captains[0].playerId,
      viceCaptainId: viceCaptains[0].playerId,
    };
  }
}
