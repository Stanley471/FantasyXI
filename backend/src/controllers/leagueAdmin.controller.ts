import { Request, Response, NextFunction } from "express";
import { leagueService } from "../services/league/leagueService.js";

/**
 * League Admin Controller — operational tooling for classic-league standings.
 *
 * Exposes `recalculateClassicStandings` over HTTP so it can be triggered
 * manually (e.g. after a scoring correction) and so it has an endpoint to
 * target for load testing (see backend/loadtest/leaderboard-recalc.js).
 * Normal end-of-gameweek recalculation runs automatically from the
 * settlement job (see jobs/gameweekSettlement.ts) — this route is for
 * ops/manual re-runs, not part of that pipeline.
 */
export async function recalculateStandings(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const gameweekId = Number(req.body?.gameweekId ?? req.query.gameweekId);
    if (!Number.isInteger(gameweekId) || gameweekId <= 0) {
      res.status(400).json({
        success: false,
        message: "A valid positive integer gameweekId is required",
      });
      return;
    }

    const result = await leagueService.recalculateClassicStandings(gameweekId);

    res.json({
      success: true,
      message: `Recalculated standings for ${result.membersUpdated} members`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
