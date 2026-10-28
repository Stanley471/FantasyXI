import { Position, Player } from "@/types";
import {
  countStartersByPosition,
  detectFormation,
  validateSubstitution,
  FormationCounts,
} from "@/lib/formation";

export interface SquadPlayerLike {
  playerId: number;
  isStarter: boolean;
  player: Player;
}

export interface TacticalPathTarget {
  playerId: number;
  isEligible: boolean;
  reason?: string;
  resultingFormation?: string;
}

export interface SubstitutionPathsResult {
  sourcePlayerId: number;
  isSourceStarter: boolean;
  sourcePosition: Position;
  currentFormation: string;
  eligiblePlayerIds: number[];
  ineligibleTargets: TacticalPathTarget[];
  allTargets: Map<number, TacticalPathTarget>;
  possibleFormationMorphs: Array<{
    targetPlayerId: number;
    newFormation: string;
    isMorph: boolean;
  }>;
}

export interface PitchCoordinate {
  x: number; // percentage (0 - 100)
  y: number; // percentage (0 - 100)
}

/**
 * Computes responsive (x, y) coordinates on a 100x100 SVG tactical pitch.
 * When formations morph (e.g. 4 DEF -> 3 DEF), coordinates automatically adjust
 * to center players horizontally along their tactical zone.
 */
export function getTacticalSlotCoordinates(
  position: Position,
  indexInPosition: number,
  totalInPosition: number
): PitchCoordinate {
  // Y-axis percentage anchors for tactical zones (top = FWD, bottom = GKP)
  const yAnchorByPosition: Record<Position, number> = {
    [Position.FWD]: 22,
    [Position.MID]: 44,
    [Position.DEF]: 68,
    [Position.GKP]: 88,
  };

  const y = yAnchorByPosition[position] ?? 50;

  if (totalInPosition <= 1) {
    return { x: 50, y };
  }

  // Calculate horizontal spacing centered on the pitch
  const spacing = 90 / (totalInPosition + 1);
  const x = 5 + spacing * (indexInPosition + 1);

  return { x: Math.round(x * 10) / 10, y };
}

/**
 * Solves all substitution paths for a given source player across the entire squad.
 * Categorizes each squad member as eligible or ineligible with tactical feedback
 * and predicts resulting formation changes (formation morphing).
 */
export function calculateSubstitutionPaths(
  sourcePlayer: SquadPlayerLike,
  allPlayers: SquadPlayerLike[]
): SubstitutionPathsResult {
  const currentStarters = allPlayers.filter((p) => p.isStarter);
  const currentFormation = detectFormation(currentStarters as any);

  const eligiblePlayerIds: number[] = [];
  const ineligibleTargets: TacticalPathTarget[] = [];
  const allTargets = new Map<number, TacticalPathTarget>();
  const possibleFormationMorphs: Array<{
    targetPlayerId: number;
    newFormation: string;
    isMorph: boolean;
  }> = [];

  for (const candidate of allPlayers) {
    if (candidate.playerId === sourcePlayer.playerId) {
      continue;
    }

    const validation = validateSubstitution(sourcePlayer, candidate, allPlayers);

    if (validation.valid) {
      eligiblePlayerIds.push(candidate.playerId);

      // Determine the hypothetical resulting formation
      let resultingFormation = currentFormation;
      if (sourcePlayer.isStarter !== candidate.isStarter) {
        const simulatedStarters = allPlayers
          .filter((p) => {
            if (p.playerId === sourcePlayer.playerId) return candidate.isStarter;
            if (p.playerId === candidate.playerId) return sourcePlayer.isStarter;
            return p.isStarter;
          })
          .map((p) => ({ player: p.player, position: p.player.position }));

        resultingFormation = detectFormation(simulatedStarters);
      }

      const isMorph = resultingFormation !== currentFormation;
      if (isMorph) {
        possibleFormationMorphs.push({
          targetPlayerId: candidate.playerId,
          newFormation: resultingFormation,
          isMorph: true,
        });
      }

      const targetInfo: TacticalPathTarget = {
        playerId: candidate.playerId,
        isEligible: true,
        resultingFormation,
      };

      allTargets.set(candidate.playerId, targetInfo);
    } else {
      const targetInfo: TacticalPathTarget = {
        playerId: candidate.playerId,
        isEligible: false,
        reason: validation.reason,
      };
      ineligibleTargets.push(targetInfo);
      allTargets.set(candidate.playerId, targetInfo);
    }
  }

  return {
    sourcePlayerId: sourcePlayer.playerId,
    isSourceStarter: sourcePlayer.isStarter,
    sourcePosition: sourcePlayer.player.position,
    currentFormation,
    eligiblePlayerIds,
    ineligibleTargets,
    allTargets,
    possibleFormationMorphs,
  };
}

/**
 * Checks whether an active player can be swapped with a target slot.
 */
export function isSubstitutionTargetEligible(
  sourcePlayer: SquadPlayerLike | null,
  targetPlayer: SquadPlayerLike | null,
  allPlayers: SquadPlayerLike[]
): { eligible: boolean; reason?: string } {
  if (!sourcePlayer || !targetPlayer) {
    return { eligible: false, reason: "Invalid player selection" };
  }
  const result = validateSubstitution(sourcePlayer, targetPlayer, allPlayers);
  return { eligible: result.valid, reason: result.reason };
}
