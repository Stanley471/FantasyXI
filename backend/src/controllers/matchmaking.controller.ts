import { Request, Response, NextFunction } from "express";
import { findMatchmakingCandidates, joinMatchmakingQueue, MatchmakingQueueError } from "../services/league/matchRatingService.js";

export async function getMatchmakingCandidates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const tolerance = req.query.tolerance === undefined ? 200 : Number(req.query.tolerance);
    if (!Number.isInteger(tolerance) || tolerance < 100 || tolerance > 1000) {
      res.status(400).json({ success: false, message: "tolerance must be an integer between 100 and 1000" });
      return;
    }
    const candidates = await findMatchmakingCandidates(req.user.id, tolerance);
    res.json({ success: true, data: candidates, meta: { tolerance } });
  } catch (error) {
    next(error);
  }
}

export async function joinMatchmaking(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const tolerance = req.body?.tolerance === undefined ? 200 : Number(req.body.tolerance);
    if (!Number.isInteger(tolerance) || tolerance < 100 || tolerance > 1000) {
      res.status(400).json({ success: false, message: "tolerance must be an integer between 100 and 1000" });
      return;
    }
    const result = await joinMatchmakingQueue(req.user.id, tolerance);
    res.status(result.status === "MATCHED" ? 200 : 202).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof MatchmakingQueueError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    if ((error as { code?: string }).code === "P2034") {
      res.status(409).json({ success: false, message: "Matchmaking queue changed while pairing; retry the request" });
      return;
    }
    next(error);
  }
}
