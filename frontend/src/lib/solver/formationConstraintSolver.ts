/**
 * High-Performance Constraint Satisfaction Formation & Squad Solver
 *
 * Enforces Premier League / FantasyXI constraints:
 * 1. 11 starting players, exactly 1 GKP, 3-5 DEF, 2-5 MID, 1-3 FWD.
 * 2. Standard formations: 3-5-2, 3-4-3, 4-4-2, 4-3-3, 4-5-1, 5-3-2, 5-4-1, 5-2-3.
 * 3. Max 3 players per club limit.
 * 4. Maximum budget cap.
 * 5. Instant sub-millisecond evaluation for real-time UI drag-and-drop.
 */

import { Position, SQUAD_RULES } from "@/types";

export interface SolverPlayer {
  id: number;
  position: Position;
  teamId: number;
  price: number; // in tenths, e.g. 100 = 10.0m
  isStarter?: boolean;
}

export interface SquadConstraintValidationResult {
  valid: boolean;
  errors: string[];
  formation: string | null;
  totalCost: number;
  clubCounts: Record<number, number>;
  clubViolations: number[];
  validFormationsCount: number;
}

export interface TransferEvaluationResult {
  valid: boolean;
  reason?: string;
  newCost: number;
  remainingBudget: number;
  wouldViolateClubLimit: boolean;
  violatingClubId?: number;
}

// All 8 official FPL formations
export const VALID_FORMATIONS: readonly string[] = [
  "3-4-3",
  "3-5-2",
  "4-3-3",
  "4-4-2",
  "4-5-1",
  "5-2-3",
  "5-3-2",
  "5-4-1",
];

export class FormationConstraintSolver {
  /**
   * Validates formation numbers (def-mid-fwd) against FPL rules.
   */
  public static isValidFormation(def: number, mid: number, fwd: number): boolean {
    if (def + mid + fwd !== 10) return false;
    if (def < 3 || def > 5) return false;
    if (mid < 2 || mid > 5) return false;
    if (fwd < 1 || fwd > 3) return false;
    return true;
  }

  /**
   * Comprehensive constraint satisfaction check on a 15-player squad (or partial lineup).
   */
  public static validateSquad(
    players: SolverPlayer[],
    maxBudgetTenths: number = SQUAD_RULES.STARTING_BUDGET * 10
  ): SquadConstraintValidationResult {
    const errors: string[] = [];
    const clubCounts: Record<number, number> = {};
    const clubViolations: number[] = [];
    let totalCost = 0;

    let gkp = 0;
    let def = 0;
    let mid = 0;
    let fwd = 0;

    let starterGkp = 0;
    let starterDef = 0;
    let starterMid = 0;
    let starterFwd = 0;
    let startersCount = 0;

    for (const p of players) {
      totalCost += p.price;
      clubCounts[p.teamId] = (clubCounts[p.teamId] || 0) + 1;

      if (clubCounts[p.teamId] > SQUAD_RULES.MAX_PER_TEAM) {
        if (!clubViolations.includes(p.teamId)) {
          clubViolations.push(p.teamId);
          errors.push(
            `Exceeded club limit: Maximum ${SQUAD_RULES.MAX_PER_TEAM} players allowed from team ${p.teamId}.`
          );
        }
      }

      if (p.position === Position.GKP) gkp++;
      else if (p.position === Position.DEF) def++;
      else if (p.position === Position.MID) mid++;
      else if (p.position === Position.FWD) fwd++;

      if (p.isStarter) {
        startersCount++;
        if (p.position === Position.GKP) starterGkp++;
        else if (p.position === Position.DEF) starterDef++;
        else if (p.position === Position.MID) starterMid++;
        else if (p.position === Position.FWD) starterFwd++;
      }
    }

    // Budget check
    if (totalCost > maxBudgetTenths) {
      errors.push(
        `Squad cost £${(totalCost / 10).toFixed(1)}m exceeds budget of £${(maxBudgetTenths / 10).toFixed(1)}m.`
      );
    }

    // Starting XI formation validation
    let formation: string | null = null;
    if (startersCount === SQUAD_RULES.STARTERS) {
      if (starterGkp !== 1) {
        errors.push("Must have exactly 1 starting Goalkeeper.");
      }
      if (!this.isValidFormation(starterDef, starterMid, starterFwd)) {
        errors.push(
          `Invalid starting formation: ${starterDef}-${starterMid}-${starterFwd}. Must be a valid FPL formation.`
        );
      } else {
        formation = `${starterDef}-${starterMid}-${starterFwd}`;
      }
    } else if (startersCount > 0 && startersCount !== SQUAD_RULES.STARTERS) {
      errors.push(
        `Starting XI must have exactly ${SQUAD_RULES.STARTERS} players (currently ${startersCount}).`
      );
    }

    // Full 15 squad position counts
    if (players.length === SQUAD_RULES.TOTAL_PLAYERS) {
      if (gkp !== 2) errors.push(`Must have exactly 2 Goalkeepers (has ${gkp}).`);
      if (def !== 5) errors.push(`Must have exactly 5 Defenders (has ${def}).`);
      if (mid !== 5) errors.push(`Must have exactly 5 Midfielders (has ${mid}).`);
      if (fwd !== 3) errors.push(`Must have exactly 3 Forwards (has ${fwd}).`);
    }

    const validFormations = this.findPermissibleFormations(players);

    return {
      valid: errors.length === 0,
      errors,
      formation,
      totalCost,
      clubCounts,
      clubViolations,
      validFormationsCount: validFormations.length,
    };
  }

  /**
   * Evaluates all legal formations that can be fielded from the squad outfielders.
   */
  public static findPermissibleFormations(players: SolverPlayer[]): string[] {
    const defCount = players.filter((p) => p.position === Position.DEF).length;
    const midCount = players.filter((p) => p.position === Position.MID).length;
    const fwdCount = players.filter((p) => p.position === Position.FWD).length;
    const gkpCount = players.filter((p) => p.position === Position.GKP).length;

    if (gkpCount < 1) return [];

    const allowed: string[] = [];

    for (const f of VALID_FORMATIONS) {
      const [d, m, fw] = f.split("-").map(Number);
      if (defCount >= d && midCount >= m && fwdCount >= fw) {
        allowed.push(f);
      }
    }

    return allowed;
  }

  /**
   * Fast incremental evaluation of a single transfer swap (PlayerOut -> PlayerIn).
   */
  public static evaluateTransfer(
    currentSquad: SolverPlayer[],
    playerOutId: number,
    playerIn: SolverPlayer,
    maxBudgetTenths: number = SQUAD_RULES.STARTING_BUDGET * 10
  ): TransferEvaluationResult {
    const playerOut = currentSquad.find((p) => p.id === playerOutId);
    if (!playerOut) {
      return {
        valid: false,
        reason: "Player to transfer out not found in squad.",
        newCost: 0,
        remainingBudget: 0,
        wouldViolateClubLimit: false,
      };
    }

    if (playerOut.position !== playerIn.position) {
      return {
        valid: false,
        reason: `Position mismatch: Cannot replace ${playerOut.position} with ${playerIn.position}.`,
        newCost: 0,
        remainingBudget: 0,
        wouldViolateClubLimit: false,
      };
    }

    // Check duplicate
    if (currentSquad.some((p) => p.id === playerIn.id)) {
      return {
        valid: false,
        reason: "Player is already in your squad.",
        newCost: 0,
        remainingBudget: 0,
        wouldViolateClubLimit: false,
      };
    }

    // Compute cost delta
    let currentCost = 0;
    const clubCounts: Record<number, number> = {};

    for (const p of currentSquad) {
      currentCost += p.price;
      clubCounts[p.teamId] = (clubCounts[p.teamId] || 0) + 1;
    }

    const newCost = currentCost - playerOut.price + playerIn.price;
    const remainingBudget = maxBudgetTenths - newCost;

    if (newCost > maxBudgetTenths) {
      return {
        valid: false,
        reason: `Transfer exceeds budget by £${((newCost - maxBudgetTenths) / 10).toFixed(1)}m.`,
        newCost,
        remainingBudget,
        wouldViolateClubLimit: false,
      };
    }

    // Check club limit
    const incomingClub = playerIn.teamId;
    const currentClubCount =
      (clubCounts[incomingClub] || 0) -
      (playerOut.teamId === incomingClub ? 1 : 0);

    if (currentClubCount >= SQUAD_RULES.MAX_PER_TEAM) {
      return {
        valid: false,
        reason: `Exceeds club limit: Maximum ${SQUAD_RULES.MAX_PER_TEAM} players allowed from team ${incomingClub}.`,
        newCost,
        remainingBudget,
        wouldViolateClubLimit: true,
        violatingClubId: incomingClub,
      };
    }

    return {
      valid: true,
      newCost,
      remainingBudget,
      wouldViolateClubLimit: false,
    };
  }

  /**
   * Filters an entire candidate pool to only valid/feasible transfers within sub-milliseconds.
   */
  public static filterFeasibleTransfers(
    currentSquad: SolverPlayer[],
    playerOutId: number,
    candidatePool: SolverPlayer[],
    maxBudgetTenths?: number
  ): SolverPlayer[] {
    const playerOut = currentSquad.find((p) => p.id === playerOutId);
    if (!playerOut) return [];

    const existingIds = new Set(currentSquad.map((p) => p.id));
    const clubCounts: Record<number, number> = {};
    let currentCost = 0;

    for (const p of currentSquad) {
      currentCost += p.price;
      clubCounts[p.teamId] = (clubCounts[p.teamId] || 0) + 1;
    }
    // Decrement club count for outgoing player
    clubCounts[playerOut.teamId] = (clubCounts[playerOut.teamId] || 1) - 1;

    const maxBudget = maxBudgetTenths ?? SQUAD_RULES.STARTING_BUDGET * 10;
    const budgetWithoutOut = currentCost - playerOut.price;

    return candidatePool.filter((candidate) => {
      if (candidate.position !== playerOut.position) return false;
      if (existingIds.has(candidate.id)) return false;
      if (budgetWithoutOut + candidate.price > maxBudget) return false;
      if ((clubCounts[candidate.teamId] || 0) >= SQUAD_RULES.MAX_PER_TEAM) return false;
      return true;
    });
  }
}
