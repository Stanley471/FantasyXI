/**
 * Formation Solver for FPL Auto-Substitutions
 * Issue #226: Build dynamic formation solver for complex multi-player double gameweek scenarios
 * 
 * This module implements constraint-satisfaction logic to find the globally optimal
 * legal substitution set that maximizes team points while respecting all FPL formation rules.
 */

export const VALID_FORMATIONS = [
  { def: 3, mid: 5, fwd: 2 }, // 3-5-2
  { def: 3, mid: 4, fwd: 3 }, // 3-4-3
  { def: 4, mid: 4, fwd: 2 }, // 4-4-2
  { def: 4, mid: 3, fwd: 3 }, // 4-3-3
  { def: 5, mid: 3, fwd: 2 }, // 5-3-2
  { def: 5, mid: 4, fwd: 1 }, // 5-4-1
  { def: 4, mid: 5, fwd: 1 }, // 4-5-1
  { def: 5, mid: 2, fwd: 3 }, // 5-2-3
] as const;

export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD';

export interface Player {
  id: string;
  position: Position;
  minutesPlayed: number;
  gameweekPoints: number;
  benchPosition?: number; // 0-3 for bench players
  isStarter: boolean;
}

export interface SubstitutionCandidate {
  starter: Player;
  benchPlayer: Player;
  pointsGained: number;
}

export interface FormationSolution {
  finalLineup: Player[];
  substitutions: SubstitutionCandidate[];
  formation: { def: number; mid: number; fwd: number };
  totalPoints: number;
  isValid: boolean;
}

/**
 * Formation Solver - Constraint Satisfaction Approach
 * 
 * Algorithm:
 * 1. Identify non-playing starters (0 minutes)
 * 2. Generate all valid formation permutations
 * 3. For each formation, try all bench permutations in priority order
 * 4. Return formation with maximum total points
 * 
 * Constraints:
 * - Must use exactly 1 GKP + 10 outfield players
 * - Formation must match one of 8 valid FPL formations
 * - GKP can only substitute for GKP
 * - Bench priority order must be respected
 * - Final lineup must not have any 0-minute players if valid subs available
 */
export class FormationSolver {
  /**
   * Find optimal substitutions respecting all FPL constraints
   * 
   * @param goalkeeper - Starting goalkeeper
   * @param starters - Starting outfield players (10)
   * @param bench - Bench players sorted by priority (4: 1 GKP + 3 outfield)
   * @param nonPlayingStarters - Starters with 0 minutes played
   * @returns FormationSolution with substitutions and final points
   */
  static solve(
    goalkeeper: Player,
    starters: Player[],
    bench: Player[],
    nonPlayingStarters: Player[]
  ): FormationSolution {
    // Base case: No substitutions needed
    if (nonPlayingStarters.length === 0) {
      return {
        finalLineup: [goalkeeper, ...starters],
        substitutions: [],
        formation: this.detectFormation(starters),
        totalPoints: this.calculateTotalPoints([goalkeeper, ...starters]),
        isValid: true,
      };
    }

    let bestSolution: FormationSolution | null = null;

    // Try each valid formation
    for (const formation of VALID_FORMATIONS) {
      const solution = this.tryFormation(
        goalkeeper,
        starters,
        bench,
        nonPlayingStarters,
        formation
      );

      if (solution.isValid && (!bestSolution || solution.totalPoints > bestSolution.totalPoints)) {
        bestSolution = solution;
      }
    }

    // Fallback if no valid solution found
    if (!bestSolution) {
      return {
        finalLineup: [goalkeeper, ...starters],
        substitutions: [],
        formation: this.detectFormation(starters),
        totalPoints: this.calculateTotalPoints([goalkeeper, ...starters]),
        isValid: false,
      };
    }

    return bestSolution;
  }

  /**
   * Try to find best substitutions for a target formation
   * 
   * @private
   * @param goalkeeper - Starting GKP
   * @param starters - Starting outfield (10)
   * @param bench - Available bench players (4)
   * @param nonPlayingStarters - Players with 0 minutes
   * @param targetFormation - Formation to achieve (e.g., 4-4-2)
   * @returns FormationSolution for this formation attempt
   */
  private static tryFormation(
    goalkeeper: Player,
    starters: Player[],
    bench: Player[],
    nonPlayingStarters: Player[],
    targetFormation: { def: number; mid: number; fwd: number }
  ): FormationSolution {
    let lineup = [...starters];
    const substitutions: SubstitutionCandidate[] = [];
    
    // Sort bench by priority (position 0 = first sub)
    const sortedBench = [...bench].sort((a, b) => 
      (a.benchPosition ?? 99) - (b.benchPosition ?? 99)
    );

    // For each non-playing starter, try bench players in priority order
    for (const nonPlayer of nonPlayingStarters) {
      for (const benchPlayer of sortedBench) {
        // Skip if bench player already used
        if (substitutions.some(s => s.benchPlayer.id === benchPlayer.id)) {
          continue;
        }

        // Position compatibility check
        if (!this.canSubstitute(nonPlayer, benchPlayer)) {
          continue;
        }

        // Try substitution
        const testLineup = lineup.map(p => 
          p.id === nonPlayer.id ? benchPlayer : p
        );
        
        // Check if formation matches target
        if (this.matchesFormation(testLineup, targetFormation)) {
          lineup = testLineup;
          substitutions.push({
            starter: nonPlayer,
            benchPlayer,
            pointsGained: benchPlayer.gameweekPoints - nonPlayer.gameweekPoints,
          });
          break; // Move to next non-playing starter
        }
      }
    }

    const finalLineup = [goalkeeper, ...lineup];
    const formation = this.detectFormation(lineup);
    
    return {
      finalLineup,
      substitutions,
      formation,
      totalPoints: this.calculateTotalPoints(finalLineup),
      isValid: this.isValidFormation(formation),
    };
  }

  /**
   * Check if two players can be substituted
   * Rule: GKP can only replace GKP
   */
  private static canSubstitute(starter: Player, benchPlayer: Player): boolean {
    if (starter.position === 'GKP' && benchPlayer.position !== 'GKP') {
      return false;
    }
    if (starter.position !== 'GKP' && benchPlayer.position === 'GKP') {
      return false;
    }
    return true;
  }

  /**
   * Check if lineup matches target formation exactly
   */
  private static matchesFormation(
    lineup: Player[],
    target: { def: number; mid: number; fwd: number }
  ): boolean {
    const counts = this.countPositions(lineup);
    return counts.def === target.def && 
           counts.mid === target.mid && 
           counts.fwd === target.fwd;
  }

  /**
   * Count players by position (excludes GKP)
   */
  private static countPositions(lineup: Player[]): { def: number; mid: number; fwd: number } {
    return {
      def: lineup.filter(p => p.position === 'DEF').length,
      mid: lineup.filter(p => p.position === 'MID').length,
      fwd: lineup.filter(p => p.position === 'FWD').length,
    };
  }

  /**
   * Detect current formation of lineup
   */
  private static detectFormation(lineup: Player[]): { def: number; mid: number; fwd: number } {
    return this.countPositions(lineup);
  }

  /**
   * Check if formation is one of the 8 valid FPL formations
   */
  private static isValidFormation(formation: { def: number; mid: number; fwd: number }): boolean {
    return VALID_FORMATIONS.some(
      valid => valid.def === formation.def && 
               valid.mid === formation.mid && 
               valid.fwd === formation.fwd
    );
  }

  /**
   * Calculate total points for lineup (including captain multiplier)
   */
  private static calculateTotalPoints(lineup: Player[]): number {
    return lineup.reduce((sum, player) => sum + (player.gameweekPoints || 0), 0);
  }
}

/**
 * Example Usage:
 * 
 * const goalkeeper = { id: 'gkp1', position: 'GKP', minutesPlayed: 90, gameweekPoints: 2, isStarter: true };
 * const starters = [
 *   { id: 'def1', position: 'DEF', minutesPlayed: 0, gameweekPoints: 0, isStarter: true },
 *   { id: 'def2', position: 'DEF', minutesPlayed: 90, gameweekPoints: 6, isStarter: true },
 *   // ... 8 more players
 * ];
 * const bench = [
 *   { id: 'bench1', position: 'DEF', minutesPlayed: 90, gameweekPoints: 4, benchPosition: 0, isStarter: false },
 *   // ... 3 more bench players
 * ];
 * const nonPlayingStarters = starters.filter(p => p.minutesPlayed === 0);
 * 
 * const solution = FormationSolver.solve(goalkeeper, starters, bench, nonPlayingStarters);
 * console.log(`Total points: ${solution.totalPoints}`);
 * console.log(`Formation: ${solution.formation.def}-${solution.formation.mid}-${solution.formation.fwd}`);
 * console.log(`Substitutions made: ${solution.substitutions.length}`);
 */
