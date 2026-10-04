import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db.js";
import { Position } from "../types/index.js";

/**
 * Player Controller.
 *
 * Provides endpoints for searching, filtering, and retrieving footballer data.
 *
 * Laravel equivalent: Like app/Http/Controllers/PlayerController.php using
 * Player::with('team')->when(...)->paginate().
 */

export async function getPlayers(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const {
      search,
      position,
      teamId,
      minPrice,
      maxPrice,
      isAvailable,
      sortBy = "totalPoints",
      sortOrder = "desc",
      page = "1",
      limit = "50",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    // Build Prisma where filter
    const where: any = {};

    if (search && typeof search === "string" && search.trim().length > 0) {
      where.OR = [
        { displayName: { contains: search.trim(), mode: "insensitive" } },
        { firstName: { contains: search.trim(), mode: "insensitive" } },
        { lastName: { contains: search.trim(), mode: "insensitive" } },
      ];
    }

    if (position && typeof position === "string" && position in Position) {
      where.position = position as Position;
    }

    if (teamId) {
      const parsedTeamId = parseInt(teamId as string, 10);
      if (!isNaN(parsedTeamId)) {
        where.teamId = parsedTeamId;
      }
    }

    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) {
        where.price.gte = parseFloat(minPrice as string);
      }
      if (maxPrice) {
        where.price.lte = parseFloat(maxPrice as string);
      }
    }

    if (isAvailable !== undefined) {
      where.isAvailable = isAvailable === "true";
    }

    // Build orderBy
    const allowedSortFields = [
      "price",
      "totalPoints",
      "minutesPlayed",
      "goalsScored",
      "assists",
      "cleanSheets",
      "form",
    ];
    const sortField = allowedSortFields.includes(sortBy as string)
      ? (sortBy as string)
      : "totalPoints";
    const orderDirection = sortOrder === "asc" ? "asc" : "desc";

    const [players, total] = await Promise.all([
      prisma.player.findMany({
        where,
        include: {
          team: {
            select: {
              id: true,
              fplId: true,
              name: true,
              shortName: true,
              logoUrl: true,
            },
          },
        },
        orderBy: { [sortField]: orderDirection },
        skip,
        take: limitNum,
      }),
      prisma.player.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limitNum);
    const nextPage = pageNum < totalPages ? pageNum + 1 : null;
    const prevPage = pageNum > 1 && pageNum <= totalPages + 1 ? pageNum - 1 : null;

    res.json({
      success: true,
      data: players,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalCount: total,
        totalPages,
        nextPage,
        prevPage,
        hasNextPage: nextPage !== null,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getPlayerById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        message: "Invalid player ID",
      });
      return;
    }

    const player = await prisma.player.findUnique({
      where: { id },
      include: {
        team: true,
        gameweekStats: {
          include: { gameweek: true },
          orderBy: { gameweekId: "desc" },
          take: 10,
        },
      },
    });

    if (!player) {
      res.status(404).json({
        success: false,
        message: `Player with ID ${id} not found`,
      });
      return;
    }

    res.json({
      success: true,
      data: player,
    });
  } catch (error) {
    next(error);
  }
}

interface CachedStats {
  timestamp: number;
  data: {
    totalSquads: number;
    topOwned: Array<{
      id: number;
      displayName: string;
      position: string;
      teamName: string;
      price: number;
      totalPoints: number;
      selectedCount: number;
      selectedByPercent: number;
      ppm: number;
    }>;
    ownershipVsPrice: Array<{
      id: number;
      displayName: string;
      position: string;
      teamName: string;
      price: number;
      totalPoints: number;
      selectedCount: number;
      selectedByPercent: number;
      ppm: number;
    }>;
  };
}

let statsCache: CachedStats | null = null;
const CACHE_TTL_MS = 60 * 1000;

export function clearOwnershipStatsCache(): void {
  statsCache = null;
}

export async function getPlayerOwnershipStats(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const now = Date.now();
    if (statsCache && now - statsCache.timestamp < CACHE_TTL_MS) {
      res.json({
        success: true,
        data: statsCache.data,
        cached: true,
      });
      return;
    }

    const totalSquads = await prisma.squad.count();
    const players = await prisma.player.findMany({
      include: {
        team: { select: { name: true, shortName: true } },
        _count: { select: { squadPlayers: true } },
      },
    });

    const formatted = players.map((p) => {
      const priceNum = typeof p.price === "number" ? p.price : parseFloat(p.price.toString()) || 1.0;
      const selectedCount = p._count?.squadPlayers || 0;
      const selectedByPercent =
        totalSquads > 0
          ? parseFloat(((selectedCount / totalSquads) * 100).toFixed(1))
          : p.selectedByPercent
          ? parseFloat(p.selectedByPercent.toString())
          : 0;
      const ppm = priceNum > 0 ? parseFloat((p.totalPoints / priceNum).toFixed(2)) : 0;

      return {
        id: p.id,
        displayName: p.displayName,
        position: p.position,
        teamName: p.team?.name || p.team?.shortName || "Unknown",
        price: priceNum,
        totalPoints: p.totalPoints,
        selectedCount,
        selectedByPercent,
        ppm,
      };
    });

    const topOwned = [...formatted]
      .sort((a, b) => b.selectedByPercent - a.selectedByPercent)
      .slice(0, 20);
    const ownershipVsPrice = [...formatted].sort((a, b) => b.totalPoints - a.totalPoints);

    const resultData = {
      totalSquads,
      topOwned,
      ownershipVsPrice,
    };

    statsCache = {
      timestamp: now,
      data: resultData,
    };

    res.json({
      success: true,
      data: resultData,
      cached: false,
    });
  } catch (error) {
    next(error);
  }
}

