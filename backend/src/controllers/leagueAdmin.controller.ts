import { Request, Response, NextFunction } from "express";
import { leagueService } from "../services/league/leagueService.js";

export async function createTierGroup(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const group = await leagueService.createLeagueTierGroup({
      name: String(req.body?.name ?? ""),
      season: String(req.body?.season ?? ""),
      slug: req.body?.slug ? String(req.body.slug) : undefined,
      description: req.body?.description ? String(req.body.description) : undefined,
      isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : true,
    });

    res.status(201).json({ success: true, data: group });
  } catch (error) {
    next(error);
  }
}

export async function createTier(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const groupId = String(req.params.groupId ?? req.body?.groupId ?? "");
    const tier = await leagueService.createLeagueTier({
      groupId,
      name: String(req.body?.name ?? ""),
      rank: Number(req.body?.rank ?? 0),
      slug: req.body?.slug ? String(req.body.slug) : undefined,
      description: req.body?.description ? String(req.body.description) : undefined,
      promotionTargetTierId: req.body?.promotionTargetTierId
        ? String(req.body.promotionTargetTierId)
        : null,
      relegationTargetTierId: req.body?.relegationTargetTierId
        ? String(req.body.relegationTargetTierId)
        : null,
    });

    res.status(201).json({ success: true, data: tier });
  } catch (error) {
    next(error);
  }
}

export async function applyTierTransitions(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const groupId = String(req.params.groupId ?? req.body?.groupId ?? "");
    const season = String(req.body?.season ?? "");

    if (!groupId || !season) {
      res.status(400).json({
        success: false,
        message: "Both groupId and season are required",
      });
      return;
    }

    const result = await leagueService.applySeasonEndTierTransitions(season, groupId);

    res.json({
      success: true,
      message: `Applied tier transitions for ${result.processed} leagues`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

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
