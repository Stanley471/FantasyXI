import { Request, Response, NextFunction } from "express";
import {
  leagueService,
  LeagueService,
  LeagueValidationError,
  LeagueNotFoundError,
  LeagueForbiddenError,
  LeagueInvitationError,
  INVITATION_DEFAULT_TTL_HOURS,
} from "../services/league/leagueService.js";
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

/**
 * Maps league domain errors to HTTP responses; returns false for unknown errors.
 */
function sendLeagueError(error: unknown, res: Response): boolean {
  if (error instanceof LeagueNotFoundError) {
    res.status(404).json({ success: false, message: error.message });
    return true;
  }
  if (error instanceof LeagueForbiddenError) {
    res.status(403).json({ success: false, message: error.message });
    return true;
  }
  if (error instanceof LeagueInvitationError) {
    // 410 Gone: the link is unusable (unknown, expired, revoked or already used)
    res.status(410).json({ success: false, message: error.message });
    return true;
  }
  if (error instanceof LeagueValidationError) {
    res.status(400).json({ success: false, message: error.message });
    return true;
  }
  return false;
}

/**
 * GET /api/v1/leagues
 * Query: q, status, scoringType, creatorId, minEntryFee, maxEntryFee, minSize,
 * maxSize, hasOpenSlots, sortBy, sortOrder, page, pageSize
 */
export async function getLeagues(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const filters = LeagueService.parseSearchFilters(req.query as Record<string, unknown>);
    const result = await leagueService.getLeagues(filters, req.user?.id);

    res.json({
      success: true,
      data: result.items,
      meta: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    });
  } catch (error) {
    if (sendLeagueError(error, res)) return;
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
    const league = await leagueService.getLeagueById(id as string, req.user?.id);

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
    if (error instanceof LeagueForbiddenError || error instanceof LeagueInvitationError) {
      sendLeagueError(error, res);
      return;
    }
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
    const league = await leagueService.getLeagueById(id as string);

    res.json({
      success: true,
      data: league.members,
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

// ============================================================
// Private league invitations
// ============================================================

/**
 * POST /api/v1/leagues/:id/invitations (creator only)
 * Body: { expiresInHours?: number }
 * Returns the raw token once; the client builds the shareable link from it.
 */
export async function createLeagueInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const raw = req.body?.expiresInHours;
    const expiresInHours = raw === undefined ? INVITATION_DEFAULT_TTL_HOURS : Number(raw);

    const invitation = await leagueService.createInvitation(
      req.params.id as string,
      req.user.id,
      expiresInHours
    );

    res.status(201).json({
      success: true,
      message: "Invitation created. The link can be used once and cannot be retrieved again.",
      data: invitation,
    });
  } catch (error) {
    if (sendLeagueError(error, res)) return;
    next(error);
  }
}

/**
 * GET /api/v1/leagues/:id/invitations (creator only)
 */
export async function listLeagueInvitations(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const invitations = await leagueService.listInvitations(req.params.id as string, req.user.id);
    res.json({ success: true, data: invitations });
  } catch (error) {
    if (sendLeagueError(error, res)) return;
    next(error);
  }
}

/**
 * DELETE /api/v1/leagues/:id/invitations/:invitationId (creator only)
 */
export async function revokeLeagueInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    await leagueService.revokeInvitation(
      req.params.id as string,
      req.params.invitationId as string,
      req.user.id
    );
    res.json({ success: true, message: "Invitation revoked" });
  } catch (error) {
    if (sendLeagueError(error, res)) return;
    next(error);
  }
}

/**
 * GET /api/v1/leagues/invitations/:token (public preview)
 */
export async function previewLeagueInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const preview = await leagueService.previewInvitation(req.params.token as string);
    res.json({ success: true, data: preview });
  } catch (error) {
    if (sendLeagueError(error, res)) return;
    next(error);
  }
}

/**
 * POST /api/v1/leagues/invitations/:token/accept
 * Body: { squadId: string }
 */
export async function acceptLeagueInvitation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required to join a league" });
      return;
    }

    const { squadId } = req.body ?? {};
    if (!squadId || typeof squadId !== "string") {
      res.status(400).json({ success: false, message: "squadId is required to join a league" });
      return;
    }

    const member = await leagueService.acceptInvitation(
      req.params.token as string,
      req.user.id,
      squadId
    );

    res.status(201).json({
      success: true,
      message: "Joined league successfully",
      data: member,
    });
  } catch (error) {
    if (sendLeagueError(error, res)) return;
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
