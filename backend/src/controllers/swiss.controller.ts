import { Request, Response, NextFunction } from "express";
import {
  swissTournamentService,
  SwissLeagueNotFoundError,
  SwissTournamentError,
} from "../services/league/swissTournamentService.js";

/**
 * Swiss-system tournament endpoints for SWISS leagues (issue #270).
 * Pairings are generated automatically on activation and after each settled
 * gameweek, so these endpoints are read-only.
 */

function sendSwissError(error: unknown, res: Response): boolean {
  if (error instanceof SwissLeagueNotFoundError) {
    res.status(404).json({ success: false, message: error.message });
    return true;
  }
  if (error instanceof SwissTournamentError) {
    res.status(400).json({ success: false, message: error.message });
    return true;
  }
  return false;
}

/** GET /api/v1/leagues/:id/swiss/standings */
export async function getSwissStandings(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = await swissTournamentService.getStandings(req.params.id as string);
    res.json({ success: true, data });
  } catch (error) {
    if (!sendSwissError(error, res)) next(error);
  }
}

/** GET /api/v1/leagues/:id/swiss/pairings?round=N */
export async function getSwissPairings(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let round: number | undefined;
    if (req.query.round !== undefined) {
      round = Number(req.query.round);
      if (!Number.isInteger(round) || round < 1) {
        res.status(400).json({ success: false, message: "round must be a positive integer" });
        return;
      }
    }
    const data = await swissTournamentService.getPairings(req.params.id as string, round);
    res.json({ success: true, data });
  } catch (error) {
    if (!sendSwissError(error, res)) next(error);
  }
}
