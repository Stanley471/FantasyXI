import { Request, Response, NextFunction } from "express";
import {
  LeaderboardService,
  leaderboardService,
  LeaderboardNotFoundError,
  LeaderboardValidationError,
} from "../services/leaderboard/leaderboardService.js";

/**
 * GET /api/v1/leaderboard
 * Query: page, pageSize (max 100), q (squad or manager name), gameweekId
 *
 * Global ranking of every squad by season points, or by points in one gameweek
 * when gameweekId is supplied. Signed-in viewers also receive their own rank and
 * the page it appears on.
 */
export async function getLeaderboard(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const query = LeaderboardService.parseQuery(req.query as Record<string, unknown>);
    const { entries, total, page, pageSize, totalPages, ...rest } = await leaderboardService.getLeaderboard(
      query,
      req.user?.id
    );

    res.json({
      success: true,
      data: { ...rest, entries },
      meta: { total, page, pageSize, totalPages },
    });
  } catch (error) {
    if (error instanceof LeaderboardValidationError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof LeaderboardNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}
