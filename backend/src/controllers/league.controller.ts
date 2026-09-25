import { Request, Response, NextFunction } from "express";
import {
  leagueService,
  LeagueValidationError,
  LeagueNotFoundError,
  LeagueForbiddenError,
} from "../services/league/leagueService.js";
import { LeagueStatus } from "../types/index.js";
import { liveService } from "../services/live/liveService.js";

/**
 * League Controller.
 *
 * Handles HTTP requests for league creation, joining, standings, and lifecycle operations.
 *
 * Laravel equivalent: Like app/Http/Controllers/LeagueController.php using
 * LeaguePolicy and LeagueService.
 */

export async function createLeague(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required to create a league",
      });
      return;
    }

    // Always derive creator identity from authenticated user
    const userId = req.user.id;
    const { userId: _bodyUserId, creatorId: _bodyCreatorId, ...leagueInput } = req.body;

    const league = await leagueService.createLeague(userId, leagueInput);
    res.status(201).json({
      success: true,
      message: "League created successfully",
      data: league,
    });
  } catch (error) {
    if (error instanceof LeagueValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function getLeagues(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { status, creatorId } = req.query;

    const leagues = await leagueService.getLeagues({
      status: status ? (status as LeagueStatus) : undefined,
      creatorId: creatorId ? (creatorId as string) : undefined,
    });

    res.json({
      success: true,
      data: leagues,
    });
  } catch (error) {
    next(error);
  }
}

export async function getLeagueById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const league = await leagueService.getLeagueById(id as string);

    res.json({
      success: true,
      data: league,
    });
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function joinLeague(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required to join a league",
      });
      return;
    }

    const { id } = req.params;
    const userId = req.user.id;
    const { squadId } = req.body;

    if (!squadId) {
      res.status(400).json({
        success: false,
        message: "squadId is required to join a league",
      });
      return;
    }

    const member = await leagueService.joinLeague(id as string, userId, squadId);

    res.status(201).json({
      success: true,
      message: "Joined league successfully",
      data: member,
    });
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof LeagueValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function getLeagueMembers(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const requestedPage = Number.parseInt(req.query.page as string, 10);
    const requestedLimit = Number.parseInt(req.query.limit as string, 10);
    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 50;
    const membersPage = await leagueService.getLeagueMembers(id as string, page, limit);

    res.json({
      success: true,
      data: membersPage.members,
      pagination: {
        page: membersPage.page,
        limit: membersPage.limit,
        total: membersPage.total,
        totalPages: membersPage.totalPages,
      },
    });
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function getLeagueStandings(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const standingsData = await leagueService.getLeagueStandings(id as string);

    res.json({
      success: true,
      data: standingsData,
    });
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function getH2HStandings(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const standings = await leagueService.getH2HStandings(id as string);

    res.json({
      success: true,
      data: standings,
    });
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof LeagueValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function cancelLeague(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required to cancel a league",
      });
      return;
    }

    const { id } = req.params;
    const userId = req.user.id;

    const cancelled = await leagueService.cancelLeague(id as string, userId);

    res.json({
      success: true,
      message: "League has been cancelled",
      data: cancelled,
    });
  } catch (error) {
    if (error instanceof LeagueNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof LeagueForbiddenError) {
      res.status(403).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof LeagueValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

/**
 * GET /api/v1/leagues/:id/live — Server-Sent Events stream of live matchday snapshots.
 * Pushes a snapshot on connect and every LIVE_FEED_INTERVAL_MS (default 15s).
 */
export async function streamLeagueLive(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const leagueId = req.params.id as string;

  try {
    const first = await liveService.getLeagueSnapshot(leagueId);
    if (!first) {
      res.status(404).json({
        success: false,
        message: `League with ID ${leagueId} was not found`,
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("snapshot", first);

    const intervalMs = Number(process.env.LIVE_FEED_INTERVAL_MS) || 15_000;
    const timer = setInterval(async () => {
      try {
        const snapshot = await liveService.getLeagueSnapshot(leagueId);
        if (snapshot) send("snapshot", snapshot);
      } catch (error) {
        send("feed-error", { message: (error as Error).message });
      }
    }, intervalMs);

    req.on("close", () => clearInterval(timer));
  } catch (error) {
    next(error);
  }
}
