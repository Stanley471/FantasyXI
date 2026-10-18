import { Request, Response, NextFunction } from "express";
import { liveTimelineService } from "../services/live/liveTimelineService.js";
import { liveProvisionalLeaderboard } from "../services/live/liveProvisionalLeaderboard.js";

/**
 * GET /api/v1/live/timeline/:gameweekId
 *
 * Returns the chronological match event timeline (goals, assists, cards, saves)
 * for the requested gameweek.
 */
export async function getLiveTimeline(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const gameweekId = parseInt(req.params.gameweekId as string, 10);

  if (isNaN(gameweekId)) {
    res.status(400).json({
      success: false,
      message: "gameweekId must be a valid number",
    });
    return;
  }

  try {
    const timeline = await liveTimelineService.getGameweekTimeline(gameweekId);

    if (!timeline) {
      res.status(404).json({
        success: false,
        message: `Gameweek with ID ${gameweekId} was not found`,
      });
      return;
    }

    res.json({
      success: true,
      data: timeline,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/live/timeline/:gameweekId/stream
 *
 * Real-time Server-Sent Events (SSE) feed for the match event timeline.
 */
export async function streamLiveTimeline(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const gameweekId = parseInt(req.params.gameweekId as string, 10);

  if (isNaN(gameweekId)) {
    res.status(400).json({
      success: false,
      message: "gameweekId must be a valid number",
    });
    return;
  }

  try {
    const first = await liveTimelineService.getGameweekTimeline(gameweekId);
    if (!first) {
      res.status(404).json({
        success: false,
        message: `Gameweek with ID ${gameweekId} was not found`,
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

    send("timeline", first);

    const intervalMs = Number(process.env.LIVE_FEED_INTERVAL_MS) || 15_000;
    const timer = setInterval(async () => {
      try {
        const update = await liveTimelineService.getGameweekTimeline(gameweekId);
        if (update) send("timeline", update);
      } catch (err) {
        send("error", { message: (err as Error).message });
      }
    }, intervalMs);

    req.on("close", () => clearInterval(timer));
  } catch (error) {
    next(error);
  }
}

function parseProvisionalParams(req: Request): { leagueId: string; gameweekId: number } | null {
  const gameweekId = Number(req.query.gameweekId);
  const leagueId = req.params.leagueId as string;
  if (!Number.isInteger(gameweekId) || gameweekId < 1 || !leagueId) return null;
  return { leagueId, gameweekId };
}

/**
 * GET /api/v1/live/leagues/:leagueId/provisional?gameweekId=N
 *
 * Live provisional standings served from Redis only (issue #268).
 */
export async function getProvisionalStandings(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const params = parseProvisionalParams(req);
  if (!params) {
    res.status(400).json({ success: false, message: "gameweekId must be a positive integer" });
    return;
  }

  try {
    const standings = await liveProvisionalLeaderboard.getStandings(params.gameweekId, params.leagueId);
    res.json({ success: true, data: { ...params, provisional: true, standings } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/live/leagues/:leagueId/provisional/stream?gameweekId=N
 *
 * Server-Sent Events: an initial `standings` snapshot followed by a
 * `rank-update` event (rank and point diffs) whenever a match event moves the league.
 */
export async function streamProvisionalStandings(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const params = parseProvisionalParams(req);
  if (!params) {
    res.status(400).json({ success: false, message: "gameweekId must be a positive integer" });
    return;
  }

  try {
    const standings = await liveProvisionalLeaderboard.getStandings(params.gameweekId, params.leagueId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("standings", { ...params, provisional: true, standings });

    const unsubscribe = liveProvisionalLeaderboard.subscribe(params.leagueId, (update) => {
      if (update.gameweekId === params.gameweekId) send("rank-update", update);
    });
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);

    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  } catch (error) {
    next(error);
  }
}
