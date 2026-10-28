import { PrismaClient } from '@prisma/client';
import { logger } from '@/config/logger';
import { LeagueIntegrityService } from '@/services/league/collusion/leagueIntegrityService';

const prisma = new PrismaClient();

/**
 * Audit all ACTIVE leagues for collusion after each gameweek settles.
 * This job runs every 6 hours and processes any leagues that just settled a gameweek.
 *
 * @returns Summary of audit results
 */
export async function auditLeaguesForCollusion(): Promise<{
  leaguesAudited: number;
  totalFlagsCreated: number;
  totalAccountsSuspended: number;
  errors: number;
}> {
  logger.info('[Collusion Audit] Starting league integrity audit');

  const integrityService = new LeagueIntegrityService(prisma);
  let leaguesAudited = 0;
  let totalFlagsCreated = 0;
  let totalAccountsSuspended = 0;
  let errors = 0;

  try {
    // Find recently settled gameweeks (settled in the last 6 hours)
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

    const settledGameweeks = await prisma.gameweek.findMany({
      where: {
        isFinished: true,
        settledAt: {
          gte: sixHoursAgo,
        },
      },
      select: { id: true, fplId: true },
    });

    if (settledGameweeks.length === 0) {
      logger.info('[Collusion Audit] No recently settled gameweeks found');
      return {
        leaguesAudited: 0,
        totalFlagsCreated: 0,
        totalAccountsSuspended: 0,
        errors: 0,
      };
    }

    logger.info(
      `[Collusion Audit] Found ${settledGameweeks.length} recently settled gameweeks: ${settledGameweeks.map((g) => g.fplId).join(', ')}`
    );

    // For each recently settled gameweek, audit leagues that ended on it
    for (const gameweek of settledGameweeks) {
      try {
        // Find ACTIVE or COMPLETED leagues that end on this gameweek
        const leagues = await prisma.league.findMany({
          where: {
            endGameweekId: gameweek.id,
            status: { in: ['ACTIVE', 'COMPLETED'] },
          },
          select: { id: true, name: true },
        });

        logger.info(`[Collusion Audit] Auditing ${leagues.length} leagues for GW ${gameweek.fplId}`);

        for (const league of leagues) {
          try {
            leaguesAudited++;

            const result = await integrityService.auditLeagueForCollusion(league.id, gameweek.fplId, {
              riskConfig: undefined, // Use defaults
              maxCandidates: 500,
              dryRun: false,
            });

            totalFlagsCreated += result.flagsCreated;
            totalAccountsSuspended += result.accountsSuspended;

            logger.info(
              `[Collusion Audit] League ${league.name} (${league.id}): ${result.flagsCreated} flags, ${result.accountsSuspended} suspensions`
            );
          } catch (err) {
            logger.error(`[Collusion Audit] Error auditing league ${league.id}:`, err);
            errors++;
          }
        }
      } catch (err) {
        logger.error(`[Collusion Audit] Error processing gameweek ${gameweek.fplId}:`, err);
        errors++;
      }
    }
  } catch (err) {
    logger.error('[Collusion Audit] Critical error during audit run:', err);
    errors++;
  }

  const summary = {
    leaguesAudited,
    totalFlagsCreated,
    totalAccountsSuspended,
    errors,
  };

  logger.info(`[Collusion Audit] Audit complete: ${JSON.stringify(summary)}`);

  return summary;
}

/**
 * Audit a specific league immediately (on-demand).
 * Useful for admin-triggered audits or testing.
 *
 * @param leagueId League to audit
 * @param gameweekId Gameweek to audit through
 * @returns Audit results
 */
export async function auditLeagueOnDemand(leagueId: string, gameweekId: number): Promise<{
  flagsCreated: number;
  accountsSuspended: number;
}> {
  logger.info(`[Collusion Audit] On-demand audit for league ${leagueId}, GW ${gameweekId}`);

  const integrityService = new LeagueIntegrityService(prisma);

  try {
    const result = await integrityService.auditLeagueForCollusion(leagueId, gameweekId, {
      riskConfig: undefined, // Use defaults
      dryRun: false,
    });

    logger.info(`[Collusion Audit] On-demand audit complete: ${result.flagsCreated} flags, ${result.accountsSuspended} suspensions`);

    return result;
  } catch (err) {
    logger.error(`[Collusion Audit] Error in on-demand audit:`, err);
    throw err;
  }
}
