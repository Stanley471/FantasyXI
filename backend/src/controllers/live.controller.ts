import { Request, Response, NextFunction } from "express";
import { liveTimelineService } from "../services/live/liveTimelineService.js";
import { liveProvisionalLeaderboardService } from "../services/live/liveProvisionalLeaderboardService.js";

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

/**
 * GET /api/v1/live/leaderboard/:leagueId
 *
 * Returns the live provisional leaderboard rankings for a league without
 * hitting the database if the daemon is already hydrated.
 */
export async function getLiveProvisionalLeaderboard(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = String(req.params.leagueId ?? "");
    if (!leagueId) {
      res.status(400).json({ success: false, message: "leagueId is required" });
      return;
    }

    const rankings = liveProvisionalLeaderboardService.getLeagueLeaderboard(leagueId);
    res.json({
      success: true,
      data: {
        leagueId,
        rankings,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/live/leaderboard/:leagueId/stream
 *
 * Real-time SSE stream pushing rank & point delta diffs to clients whenever a
 * match event alters league standings.
 */
export async function streamLiveProvisionalLeaderboard(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = String(req.params.leagueId ?? "");
    if (!leagueId) {
      res.status(400).json({ success: false, message: "leagueId is required" });
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

    send("standings", {
      leagueId,
      rankings: liveProvisionalLeaderboardService.getLeagueLeaderboard(leagueId),
    });

    const unsubscribe = liveProvisionalLeaderboardService.subscribeLeagueDiffs(
      leagueId,
      (diff) => {
        send("diff", diff);
      }
    );

    req.on("close", () => {
      unsubscribe();
    });
  } catch (error) {
    next(error);
  }
}
