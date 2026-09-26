import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db.js";

/**
 * Gameweek Controller.
 *
 * Provides endpoints for retrieving gameweek schedules and active gameweek state.
 */

export async function getGameweeks(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const gameweeks = await prisma.gameweek.findMany({
      orderBy: { fplId: "asc" },
    });

    res.json({
      success: true,
      data: gameweeks,
    });
  } catch (error) {
    next(error);
  }
}

export async function getCurrentGameweek(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const current = await prisma.gameweek.findFirst({
      where: { isCurrent: true },
      include: {
        fixtures: {
          include: {
            homeTeam: true,
            awayTeam: true,
          },
          orderBy: { kickoffTime: "asc" },
        },
      },
    });

    if (!current) {
      // If none marked current, find the next upcoming deadline
      const nextUpcoming = await prisma.gameweek.findFirst({
        where: { isFinished: false },
        orderBy: { deadline: "asc" },
        include: {
          fixtures: {
            include: {
              homeTeam: true,
              awayTeam: true,
            },
            orderBy: { kickoffTime: "asc" },
          },
        },
      });

      res.json({
        success: true,
        data: nextUpcoming || null,
      });
      return;
    }

    res.json({
      success: true,
      data: current,
    });
  } catch (error) {
    next(error);
  }
}

export async function getGameweekById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid gameweek ID",
      });
      return;
    }

    const gameweek = await prisma.gameweek.findUnique({
      where: { id },
      include: {
        fixtures: {
          include: {
            homeTeam: true,
            awayTeam: true,
          },
          orderBy: { kickoffTime: "asc" },
        },
      },
    });

    if (!gameweek) {
      res.status(404).json({
        success: false,
        message: `Gameweek with ID ${id} not found`,
      });
      return;
    }

    res.json({
      success: true,
      data: gameweek,
    });
  } catch (error) {
    next(error);
  }
}

export async function getMyGameweekHistory(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const scores = await prisma.squadGameweekScore.findMany({
      where: { squad: { userId: req.user.id } },
      orderBy: { gameweekId: "asc" },
      include: {
        gameweek: true,
        squad: {
          include: {
            players: {
              orderBy: { positionOrder: "asc" },
              include: { player: { include: { team: true } } },
            },
          },
        },
      },
    });

    res.json({
      success: true,
      data: scores.map((score) => ({
        id: score.id,
        gameweek: score.gameweek,
        points: score.points,
        benchPoints: score.benchPoints,
        captainPoints: score.captainPoints,
        transferCost: score.transferCost,
        squad: score.squad,
      })),
    });
  } catch (error) {
    next(error);
  }
}
