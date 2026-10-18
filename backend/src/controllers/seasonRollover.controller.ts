import { Request, Response, NextFunction } from "express";
import {
  seasonRolloverService,
  SeasonRolloverConflictError,
  SeasonRolloverError,
  SeasonRolloverForbiddenError,
  SeasonRolloverNotFoundError,
} from "../services/league/seasonRolloverService.js";

/**
 * Season rollover and historical archive endpoints (issue #271).
 */

function sendRolloverError(error: unknown, res: Response): boolean {
  const status =
    error instanceof SeasonRolloverNotFoundError ? 404
    : error instanceof SeasonRolloverForbiddenError ? 403
    : error instanceof SeasonRolloverConflictError ? 409
    : error instanceof SeasonRolloverError ? 400
    : null;
  if (status === null) return false;
  res.status(status).json({ success: false, message: (error as Error).message });
  return true;
}

/** POST /api/v1/leagues/:id/rollover (creator or admin) */
export async function rolloverLeague(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const result = await seasonRolloverService.rolloverLeague(
      req.params.id as string,
      { id: req.user.id, role: req.user.role },
      {
        startGameweekId: req.body?.startGameweekId,
        endGameweekId: req.body?.endGameweekId,
        season: typeof req.body?.season === "string" ? req.body.season : undefined,
      }
    );
    res.status(201).json({ success: true, message: "League rolled over to a new season", data: result });
  } catch (error) {
    if (!sendRolloverError(error, res)) next(error);
  }
}

async function assertCanView(req: Request, res: Response): Promise<boolean> {
  const allowed = await seasonRolloverService.canViewHistory(
    req.params.id as string,
    req.user ? { id: req.user.id, role: req.user.role } : null
  );
  if (!allowed) {
    res.status(403).json({ success: false, message: "This league's history is only visible to its members" });
  }
  return allowed;
}

/** GET /api/v1/leagues/:id/seasons */
export async function listLeagueSeasons(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!(await assertCanView(req, res))) return;
    res.json({ success: true, data: await seasonRolloverService.listSeasons(req.params.id as string) });
  } catch (error) {
    if (!sendRolloverError(error, res)) next(error);
  }
}

/** GET /api/v1/leagues/:id/seasons/:seasonNumber */
export async function getLeagueSeason(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const seasonNumber = Number(req.params.seasonNumber);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 1) {
      res.status(400).json({ success: false, message: "seasonNumber must be a positive integer" });
      return;
    }
    if (!(await assertCanView(req, res))) return;
    res.json({ success: true, data: await seasonRolloverService.getSeason(req.params.id as string, seasonNumber) });
  } catch (error) {
    if (!sendRolloverError(error, res)) next(error);
  }
}

/** GET /api/v1/auth/me/trophies */
export async function getMyTrophies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    res.json({ success: true, data: await seasonRolloverService.getUserTrophies(req.user.id) });
  } catch (error) {
    next(error);
  }
}
