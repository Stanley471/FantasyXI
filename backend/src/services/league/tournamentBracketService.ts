/**
 * Tournament Knockout Cup Bracket Service (Issue #523)
 */

import { logger } from "../../config/logger.js";
import { prisma } from "../../config/db.js";

export class TournamentBracketService {
  public static roundsForBracketSize(managerCount: number): number {
    if (managerCount <= 0) throw new Error("Manager count must be positive");
    const powerOfTwo = Math.log2(managerCount);
    if (!Number.isInteger(powerOfTwo)) {
      throw new Error(`Bracket size ${managerCount} is not a power of 2`);
    }
    return powerOfTwo;
  }

  public static padWithByes(managers: Array<{ id: string; seed: number }>, minSize: number): Array<{ id: string; seed: number; isBye: boolean }> {
    if (managers.length >= minSize) return managers.map(m => ({ ...m, isBye: false }));
    const targetSize = Math.pow(2, Math.ceil(Math.log2(minSize)));
    const padded = [...managers.map(m => ({ ...m, isBye: false }))];
    while (padded.length < targetSize) {
      padded.push({ id: `bye-${padded.length}`, seed: padded.length, isBye: true });
    }
    return padded;
  }

  public async createKnockoutCup(leagueId: string, startGameweekId: number): Promise<string> {
    try {
      const members = await prisma.leagueMember.findMany({
        where: { leagueId },
      });

      if (members.length < 2) throw new Error("League needs at least 2 members");

      const totalRounds = Math.ceil(Math.log2(members.length));
      const bracket = await prisma.playoffBracket.create({
        data: {
          leagueId,
          format: 32,
          startGameweekId,
          totalRounds,
          status: "CREATED",
        },
      });

      logger.info({ leagueId, bracketId: bracket.id, totalRounds }, "Created bracket");
      return bracket.id;
    } catch (error) {
      logger.error({ error, leagueId }, "Failed to create bracket");
      throw error;
    }
  }

  public async resolveMatch(fixtureId: number, homeScore: number, awayScore: number): Promise<string> {
    try {
      const winner = homeScore > awayScore ? "home" : "away";
      await prisma.leagueFixture.update({
        where: { id: fixtureId },
        data: {
          homeScore,
          awayScore,
          isFinished: true,
        },
      });
      return winner;
    } catch (error) {
      logger.error({ error }, "Failed to resolve match");
      throw error;
    }
  }
}

export const tournamentBracketService = new TournamentBracketService();
