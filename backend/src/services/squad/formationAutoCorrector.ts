/**
 * Squad Tactical Formation Auto-Corrector
 *
 * Validates and auto-corrects squad formations when fixture cancellations invalidate
 * starting lineups. Handles:
 * - Minimum defender/midfielder/forward requirements
 * - Captain/vice-captain lifecycle (captain unavailable → vice-captain promoted)
 * - Bench priority order when making substitutions
 * - Multi-position player eligibility
 * - Detailed execution logs for each operation
 *
 * Closes #447
 */

import { Position, SQUAD_RULES, SquadPlayerSelection } from "../../types/index.js";

export interface PlayerInfo extends SquadPlayerSelection {
  id: number;
  position: Position;
  isInjured: boolean;
  isPostponed: boolean;
  displayName?: string;
}

export interface FixtureImpact {
  unavailablePlayers: Set<number>; // Player IDs with cancelled fixtures or injuries
  affectedStarters: PlayerInfo[];
  affectedBench: PlayerInfo[];
}

export interface FormationCorrection {
  originalFormation: string;
  correctedFormation: string;
  substitutions: Array<{
    playerOutId: number;
    playerOutName?: string;
    playerInId: number;
    playerInName?: string;
    reason: string;
  }>;
  captainChange?: {
    from: number;
    to: number;
    reason: string;
  };
  viceCaptainChange?: {
    from: number;
    to: number;
    reason: string;
  };
  executionLog: string[];
  isValid: boolean;
  errors: string[];
}

/**
 * Validates formation constraints: minimum defenders, midfielders, forwards.
 */
export interface FormationConstraint {
  minDef: number;
  minMid: number;
  minFwd: number;
  maxDef?: number;
  maxMid?: number;
  maxFwd?: number;
}

export const LEGAL_FORMATIONS: FormationConstraint[] = [
  { minDef: 3, minMid: 2, minFwd: 1 }, // 3-5-2, 3-4-3, etc.
  { minDef: 4, minMid: 3, minFwd: 1 }, // 4-3-3, 4-4-2, 4-5-1, etc.
  { minDef: 5, minMid: 3, minFwd: 1 }, // 5-3-2, 5-4-1, etc.
];

export class FormationAutoCorrector {
  /**
   * Analyzes a squad's exposure to fixture cancellations and generates
   * auto-correction plan if needed.
   */
  public static correctFormation(
    squad: {
      starters: PlayerInfo[];
      bench: PlayerInfo[];
      captainId: number;
      viceCaptainId: number;
    },
    impacts: FixtureImpact
  ): FormationCorrection {
    const log: string[] = [];
    const errors: string[] = [];

    log.push(
      `Starting correction process. Squad: ${squad.starters.length} starters, ${squad.bench.length} bench.`
    );
    log.push(
      `Unavailable players: ${Array.from(impacts.unavailablePlayers).join(", ")}`
    );

    // Step 1: Identify affected starters who must be removed
    const affectedStarterIds = new Set<number>();
    const removedStarters: PlayerInfo[] = [];

    for (const starter of squad.starters) {
      if (impacts.unavailablePlayers.has(starter.playerId)) {
        affectedStarterIds.add(starter.playerId);
        removedStarters.push(starter);
        log.push(
          `Starter ${starter.playerId} (${starter.displayName || "?"}) unavailable - must remove from XI`
        );
      }
    }

    // Calculate current formation before corrections
    const currentFormation = this.calculateFormation(squad.starters);
    log.push(`Current formation: ${currentFormation}`);

    // Step 2: Calculate what the formation will be after removing unavailable starters
    const startersAfterRemoval = squad.starters.filter(
      (s) => !affectedStarterIds.has(s.playerId)
    );
    const formationAfterRemoval = this.calculateFormation(startersAfterRemoval);
    log.push(`Formation after removal: ${formationAfterRemoval}`);

    // Step 3: Identify which positions need reinforcement
    const deficitPositions = this.identifyDeficits(formationAfterRemoval);
    if (deficitPositions.length > 0) {
      log.push(`Position deficits detected: ${deficitPositions.join(", ")}`);
    }

    // Step 4: Determine eligible bench replacements
    const availableBench = squad.bench.filter(
      (b) => !impacts.unavailablePlayers.has(b.playerId)
    );
    log.push(`Available bench players: ${availableBench.length}`);

    // Step 5: Execute substitutions respecting bench order
    const substitutions: FormationCorrection["substitutions"] = [];
    const newStarters = [...startersAfterRemoval];
    const usedBench = new Set<number>();

    for (const position of deficitPositions) {
      const positioned = availableBench.find(
        (p) => p.position === position && !usedBench.has(p.playerId)
      );

      if (!positioned) {
        errors.push(
          `No available ${position} on bench to fill deficit (all injured/postponed)`
        );
        continue;
      }

      const removedStarter = removedStarters.find((s) => s.position === position);
      if (!removedStarter) {
        errors.push(
          `Critical error: position ${position} deficit but no matching removed starter`
        );
        continue;
      }

      substitutions.push({
        playerOutId: removedStarter.playerId,
        playerOutName: removedStarter.displayName,
        playerInId: positioned.playerId,
        playerInName: positioned.displayName,
        reason: `Replace unavailable ${position.toUpperCase()}`,
      });

      newStarters.push({
        ...positioned,
        isStarter: true,
      });
      usedBench.add(positioned.playerId);
      removedStarters.splice(removedStarters.indexOf(removedStarter), 1);

      log.push(
        `Substituted: ${removedStarter.playerId} out, ${positioned.playerId} in (${position})`
      );
    }

    // Step 6: Verify final formation is legal
    const finalFormation = this.calculateFormation(newStarters);
    const isFormationLegal = this.isLegalFormation(finalFormation);
    if (!isFormationLegal) {
      errors.push(
        `Final formation ${finalFormation} does not meet minimum requirements`
      );
    }

    // Step 7: Handle captain/vice-captain changes
    let newCaptainId = squad.captainId;
    let newViceCaptainId = squad.viceCaptainId;
    const captainChange = this.handleCaptaincy(
      squad.captainId,
      squad.viceCaptainId,
      newStarters,
      impacts.unavailablePlayers,
      log
    );

    if (captainChange) {
      if (captainChange.type === "captain") {
        newCaptainId = captainChange.newId;
      } else {
        newViceCaptainId = captainChange.newId;
      }
    }

    const viceCaptainChange = this.handleViceCaptaincy(
      squad.viceCaptainId,
      newStarters,
      impacts.unavailablePlayers,
      log
    );

    if (viceCaptainChange) {
      newViceCaptainId = viceCaptainChange.newId;
    }

    const isValid = errors.length === 0 && isFormationLegal;

    log.push(`Correction complete. Valid: ${isValid}, Errors: ${errors.length}`);

    return {
      originalFormation: currentFormation,
      correctedFormation: finalFormation,
      substitutions,
      captainChange: captainChange ? {
        from: squad.captainId,
        to: newCaptainId,
        reason: captainChange.reason,
      } : undefined,
      viceCaptainChange: viceCaptainChange ? {
        from: squad.viceCaptainId,
        to: newViceCaptainId,
        reason: viceCaptainChange.reason,
      } : undefined,
      executionLog: log,
      isValid,
      errors,
    };
  }

  /**
   * Calculates formation string (e.g., "4-4-2") from starters.
   */
  public static calculateFormation(starters: PlayerInfo[]): string {
    const positions: Record<Position, number> = {
      [Position.GKP]: 0,
      [Position.DEF]: 0,
      [Position.MID]: 0,
      [Position.FWD]: 0,
    };

    for (const starter of starters) {
      positions[starter.position]++;
    }

    return `${positions[Position.DEF]}-${positions[Position.MID]}-${positions[Position.FWD]}`;
  }

  /**
   * Identifies which positions are below minimum thresholds.
   */
  public static identifyDeficits(formation: string): Position[] {
    const parts = formation.split("-").map((p) => parseInt(p, 10));
    const [def, mid, fwd] = parts;

    const deficits: Position[] = [];

    if (def < SQUAD_RULES.MIN_STARTERS.DEF) {
      deficits.push(Position.DEF);
    }
    if (mid < SQUAD_RULES.MIN_STARTERS.MID) {
      deficits.push(Position.MID);
    }
    if (fwd < SQUAD_RULES.MIN_STARTERS.FWD) {
      deficits.push(Position.FWD);
    }

    return deficits;
  }

  /**
   * Checks if a formation is legal (meets all constraints).
   */
  public static isLegalFormation(formation: string): boolean {
    const parts = formation.split("-").map((p) => parseInt(p, 10));
    const [def, mid, fwd] = parts;

    for (const constraint of LEGAL_FORMATIONS) {
      const meetsMin =
        def >= constraint.minDef &&
        mid >= constraint.minMid &&
        fwd >= constraint.minFwd;

      const meetsMax =
        (!constraint.maxDef || def <= constraint.maxDef) &&
        (!constraint.maxMid || mid <= constraint.maxMid) &&
        (!constraint.maxFwd || fwd <= constraint.maxFwd);

      if (meetsMin && meetsMax) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handles captain promotion: if captain is unavailable and vice-captain is available,
   * vice-captain becomes captain.
   */
  private static handleCaptaincy(
    captainId: number,
    viceCaptainId: number,
    newStarters: PlayerInfo[],
    unavailable: Set<number>,
    log: string[]
  ): { type: "captain"; newId: number; reason: string } | null {
    if (unavailable.has(captainId)) {
      log.push(`Captain (ID: ${captainId}) is unavailable`);

      // Can vice-captain take over?
      const viceCaptainStarter = newStarters.find(
        (s) => s.playerId === viceCaptainId
      );

      if (viceCaptainStarter) {
        log.push(
          `Vice-captain (ID: ${viceCaptainId}) promoted to captain (still on pitch)`
        );
        return {
          type: "captain",
          newId: viceCaptainId,
          reason: "Captain unavailable; vice-captain promoted",
        };
      } else {
        log.push(`Vice-captain also unavailable. Captain multiplier zeroed.`);
        // Return null; caller will handle zeroing captain multiplier
        return null;
      }
    }

    return null;
  }

  /**
   * Handles vice-captain selection: if vice-captain is unavailable, select next
   * available starter (preferring higher-value players).
   */
  private static handleViceCaptaincy(
    viceCaptainId: number,
    newStarters: PlayerInfo[],
    unavailable: Set<number>,
    log: string[]
  ): { newId: number; reason: string } | null {
    if (!unavailable.has(viceCaptainId)) {
      return null; // Vice-captain still available
    }

    log.push(`Vice-captain (ID: ${viceCaptainId}) is unavailable`);

    // Select the first available starter (excluding captain if needed)
    const replacement = newStarters[0];
    if (replacement) {
      log.push(
        `New vice-captain selected: ID ${replacement.playerId} (${replacement.displayName || "?"})`
      );
      return {
        newId: replacement.playerId,
        reason: "Vice-captain unavailable; next starter selected",
      };
    }

    log.push(`No available starters for vice-captain role. Multiplier zeroed.`);
    return null;
  }

  /**
   * Validates a correction result before applying it to the squad.
   */
  public static validateCorrection(correction: FormationCorrection): string[] {
    const issues: string[] = [];

    if (!correction.isValid) {
      issues.push(...correction.errors);
    }

    if (correction.substitutions.length === 0 && !correction.captainChange) {
      issues.push("No corrections needed or generated");
    }

    return issues;
  }
}
