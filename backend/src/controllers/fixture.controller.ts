import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db.js";

/**
 * Fixture Controller.
 *
 * Provides endpoints for retrieving Premier League match fixtures.
 *
 * Errors use the API-wide shape `{ success: false, message }`, matching
 * league.controller.ts and the global error handler.
 */

function sendFixtureError(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, message });
}

/** Parses a strictly positive integer query value; null when malformed. */
function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function getFixtures(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { gameweekId, teamId, upcoming } = req.query;

    const where: any = {};

    if (gameweekId !== undefined) {
      const parsedGw = parsePositiveInt(gameweekId);
      if (parsedGw === null) {
        sendFixtureError(res, 400, "gameweekId must be a positive integer");
        return;
      }
      where.gameweekId = parsedGw;
    }

    if (teamId !== undefined) {
      const parsedTeam = parsePositiveInt(teamId);
      if (parsedTeam === null) {
        sendFixtureError(res, 400, "teamId must be a positive integer");
        return;
      }
      where.OR = [{ homeTeamId: parsedTeam }, { awayTeamId: parsedTeam }];
    }

    if (upcoming !== undefined) {
      if (upcoming !== "true" && upcoming !== "false") {
        sendFixtureError(res, 400, 'upcoming must be "true" or "false"');
        return;
      }
      if (upcoming === "true") {
        where.finished = false;
      }
    }

    const fixtures = await prisma.fixture.findMany({
      where,
      include: {
        homeTeam: {
          select: {
            id: true,
            fplId: true,
            name: true,
            shortName: true,
            logoUrl: true,
          },
        },
        awayTeam: {
          select: {
            id: true,
            fplId: true,
            name: true,
            shortName: true,
            logoUrl: true,
          },
        },
        gameweek: {
          select: {
            id: true,
            fplId: true,
            name: true,
            deadline: true,
          },
        },
      },
      orderBy: { kickoffTime: "asc" },
    });

    res.json({
      success: true,
      data: fixtures,
    });
  } catch (error) {
    next(error);
  }
}
