import { Request, Response, NextFunction } from "express";
import {
  analyticsService,
  AnalyticsNotFoundError,
} from "../services/analytics/performanceAnalytics.js";

/**
 * GET /api/v1/analytics/me/performance?squadId=<uuid>
 *
 * Historical performance dashboard data for the authenticated user's squad:
 * per-gameweek, cumulative and rolling points benchmarked against the platform
 * average. Defaults to the user's first squad when squadId is omitted.
 */
export async function getMyPerformance(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }

  const { squadId } = req.query;
  if (squadId !== undefined && (typeof squadId !== "string" || squadId.trim() === "")) {
    res.status(400).json({ success: false, message: "squadId must be a non-empty string" });
    return;
  }

  try {
    const data = await analyticsService.getUserPerformance(req.user.id, squadId);
    res.json({ success: true, data });
  } catch (error) {
    if (error instanceof AnalyticsNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}
