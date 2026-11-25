/**
 * Formation Correction Engine
 *
 * Orchestrates the detection of postponed fixtures, identification of affected squads,
 * application of formation auto-corrections, and persistence of results.
 *
 * Integrates with SquadService, FixtureService, and logs all operations for audit.
 */

import { prisma } from "../../config/db.js";
import { Position } from "../../types/index.js";
import {
  FormationAutoCorrector,
  PlayerInfo,
  FixtureImpact,
  FormationCorrection,
} from "./formationAutoCorrector.js";
import { logger } from "../../config/logger.js";

export interface PostponementEvent {
  gameweekId: number;
  fixturesAffected: Array<{
    fixtureId: number;
    homeTeamId: number;
    awayTeamId: number;
  }>;
}

export interface SquadCorrectionResult {
  squadId: string;
  userId: string;
  squadName: string;
  correction: FormationCorrection;
  applied: boolean;
  error?: string;
}

export interface CorrectionBatch {
  postponementEvent: PostponementEvent;
  squadsCorrected: SquadCorrectionResult[];
  totalSquadsProcessed: number;
  successCount: number;
  failureCount: number;
}

export class FormationCorrectionEngine {
  constructor(private readonly db: any = prisma) {}

  /**
   * Processes a postponement event: identifies affected squads, generates corrections,
   * and applies them.
   */
  public async processPostponement(event: PostponementEvent): Promise<CorrectionBatch> {
    const batch: CorrectionBatch = {
      postponementEvent: event,
      squadsCorrected: [],
      totalSquadsProcessed: 0,
      successCount: 0,
      failureCount: 0,
    };

    logger.info(
      `Starting postponement processing for gameweek ${event.gameweekId}, ${event.fixturesAffected.length} fixtures`
    );

    try {
      // Step 1: Identify all players affected by postponement
      const affectedPlayers = await this.identifyAffectedPlayers(event);
      logger.info(`Identified ${affectedPlayers.size} affected players`);

      // Step 2: Find all active squads with affected players
      const affectedSquads = await this.findAffectedSquads(affectedPlayers);
      batch.totalSquadsProcessed = affectedSquads.length;
      logger.info(`Found ${affectedSquads.length} squads with affected players`);

      // Step 3: Process each squad
      for (const squad of affectedSquads) {
        try {
          const result = await this.correctSquadFormation(squad, affectedPlayers);
          batch.squadsCorrected.push(result);

          if (result.applied) {
            batch.successCount++;
          } else {
            batch.failureCount++;
          }
        } catch (error) {
          batch.failureCount++;
          batch.squadsCorrected.push({
            squadId: squad.id,
            userId: squad.userId,
            squadName: squad.name,
            correction: {} as FormationCorrection,
            applied: false,
            error: error instanceof Error ? error.message : String(error),
          });

          logger.error(`Error processing squad ${squad.id}: ${error}`);
        }
      }

      logger.info(
        `Postponement processing complete: ${batch.successCount} succeeded, ${batch.failureCount} failed`
      );

      return batch;
    } catch (error) {
      logger.error(`Fatal error in postponement processing: ${error}`);
      throw error;
    }
  }

  /**
   * Identifies all players whose fixtures are affected by the postponement event.
   */
  private async identifyAffectedPlayers(event: PostponementEvent): Promise<Set<number>> {
    const affectedPlayers = new Set<number>();

    // Fetch all players in the affected teams
    const affectedTeamIds = new Set<number>();
    for (const fixture of event.fixturesAffected) {
      affectedTeamIds.add(fixture.homeTeamId);
      affectedTeamIds.add(fixture.awayTeamId);
    }

    const players = await this.db.player.findMany({
      where: {
        teamId: {
          in: Array.from(affectedTeamIds),
        },
      },
      select: { id: true },
    });

    for (const player of players) {
      affectedPlayers.add(player.id);
    }

    return affectedPlayers;
  }

  /**
   * Finds all active squads that contain at least one affected player.
   */
  private async findAffectedSquads(affectedPlayers: Set<number>): Promise<any[]> {
    const squads = await this.db.squad.findMany({
      where: {
        players: {
          some: {
            playerId: {
              in: Array.from(affectedPlayers),
            },
          },
        },
        // Only active squads (not archived)
        user: {
          role: {
            not: "CANCELLED",
          },
        },
      },
      include: {
        user: { select: { id: true, email: true } },
        players: {
          include: {
            player: {
              select: {
                id: true,
                position: true,
                displayName: true,
                injuryStatus: true,
                isPostponed: true,
              },
            },
          },
        },
      },
    });

    return squads;
  }

  /**
   * Applies formation correction to a single squad.
   */
  private async correctSquadFormation(
    squad: any,
    affectedPlayers: Set<number>
  ): Promise<SquadCorrectionResult> {
    const result: SquadCorrectionResult = {
      squadId: squad.id,
      userId: squad.userId,
      squadName: squad.name,
      correction: {} as FormationCorrection,
      applied: false,
    };

    try {
      // Step 1: Build player info structures
      const starters: PlayerInfo[] = [];
      const bench: PlayerInfo[] = [];

      for (const squadPlayer of squad.players) {
        const playerInfo: PlayerInfo = {
          playerId: squadPlayer.player.id,
          position: squadPlayer.player.position,
          isInjured: !!squadPlayer.player.injuryStatus,
          isPostponed: !!squadPlayer.player.isPostponed,
          isCaptain: squadPlayer.isCaptain,
          isViceCaptain: squadPlayer.isViceCaptain,
          isStarter: squadPlayer.isStarter,
          positionOrder: squadPlayer.positionOrder,
          id: squadPlayer.player.id,
          displayName: squadPlayer.player.displayName,
        };

        if (squadPlayer.isStarter) {
          starters.push(playerInfo);
        } else {
          bench.push(playerInfo);
        }
      }

      // Step 2: Identify fixture impact
      const impact: FixtureImpact = {
        unavailablePlayers: new Set(
          squad.players
            .filter((sp: any) => affectedPlayers.has(sp.playerId))
            .map((sp: any) => sp.playerId)
        ),
        affectedStarters: starters.filter((s) => affectedPlayers.has(s.playerId)),
        affectedBench: bench.filter((b) => affectedPlayers.has(b.playerId)),
      };

      // If no impact, return early
      if (impact.unavailablePlayers.size === 0) {
        result.correction = {
          originalFormation: FormationAutoCorrector.calculateFormation(starters),
          correctedFormation: FormationAutoCorrector.calculateFormation(starters),
          substitutions: [],
          executionLog: ["No affected players in this squad"],
          isValid: true,
          errors: [],
        };
        return result;
      }

      // Step 3: Generate correction
      result.correction = FormationAutoCorrector.correctFormation(
        {
          starters,
          bench,
          captainId: squad.players.find((sp: any) => sp.isCaptain)?.playerId,
          viceCaptainId: squad.players.find((sp: any) => sp.isViceCaptain)?.playerId,
        },
        impact
      );

      // Step 4: Apply correction if valid
      if (result.correction.isValid && result.correction.substitutions.length > 0) {
        await this.applyCorrection(squad, result.correction);
        result.applied = true;
        logger.info(`Applied correction to squad ${squad.id}: ${result.correction.correctedFormation}`);
      } else if (result.correction.isValid) {
        logger.info(`Squad ${squad.id} already has valid formation after impact`);
        result.applied = true;
      } else {
        result.error = `Formation correction failed: ${result.correction.errors.join("; ")}`;
      }

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Persists formation correction to the database.
   */
  private async applyCorrection(squad: any, correction: FormationCorrection): Promise<void> {
    await this.db.$transaction(async (tx: any) => {
      // Step 1: Update squad players (mark affected starters as benched)
      for (const substitution of correction.substitutions) {
        // Remove starter
        await tx.squadPlayer.update({
          where: {
            squadId_playerId: {
              squadId: squad.id,
              playerId: substitution.playerOutId,
            },
          },
          data: {
            isStarter: false,
            positionOrder: 999, // Bench position
          },
        });

        // Promote bench player to starter
        await tx.squadPlayer.update({
          where: {
            squadId_playerId: {
              squadId: squad.id,
              playerId: substitution.playerInId,
            },
          },
          data: {
            isStarter: true,
            positionOrder: 1, // Will be reordered
          },
        });
      }

      // Step 2: Handle captaincy changes
      if (correction.captainChange) {
        // Remove old captain
        await tx.squadPlayer.updateMany({
          where: {
            squadId: squad.id,
            isCaptain: true,
          },
          data: {
            isCaptain: false,
          },
        });

        // Assign new captain
        await tx.squadPlayer.update({
          where: {
            squadId_playerId: {
              squadId: squad.id,
              playerId: correction.captainChange.to,
            },
          },
          data: {
            isCaptain: true,
          },
        });
      }

      // Step 3: Handle vice-captaincy changes
      if (correction.viceCaptainChange) {
        await tx.squadPlayer.updateMany({
          where: {
            squadId: squad.id,
            isViceCaptain: true,
          },
          data: {
            isViceCaptain: false,
          },
        });

        await tx.squadPlayer.update({
          where: {
            squadId_playerId: {
              squadId: squad.id,
              playerId: correction.viceCaptainChange.to,
            },
          },
          data: {
            isViceCaptain: true,
          },
        });
      }

      // Step 4: Create audit log entry
      await tx.squadFormationCorrectionLog.create({
        data: {
          squadId: squad.id,
          gameweekId: 0, // Will be populated if we have gameweek context
          originalFormation: correction.originalFormation,
          correctedFormation: correction.correctedFormation,
          substitutionCount: correction.substitutions.length,
          captainChanged: !!correction.captainChange,
          viceCaptainChanged: !!correction.viceCaptainChange,
          executionLog: JSON.stringify(correction.executionLog),
          appliedAt: new Date(),
        },
      });
    });
  }

  /**
   * Retrieves correction history for a squad.
   */
  public async getCorrectionHistory(squadId: string, limit: number = 10): Promise<any[]> {
    return this.db.squadFormationCorrectionLog.findMany({
      where: { squadId },
      orderBy: { appliedAt: "desc" },
      take: limit,
    });
  }
}

export const formationCorrectionEngine = new FormationCorrectionEngine();
