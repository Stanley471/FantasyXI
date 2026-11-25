import { Router } from "express";
import {
  getLiveTimeline,
  streamLiveTimeline,
  getLiveProvisionalLeaderboard,
  streamLiveProvisionalLeaderboard,
} from "../controllers/live.controller.js";
import { optionalAuth } from "../middleware/authMiddleware.js";

const router = Router();

// REST timeline endpoint
router.get("/timeline/:gameweekId", getLiveTimeline);

// Real-time SSE timeline stream
router.get("/timeline/:gameweekId/stream", streamLiveTimeline);

// Live provisional leaderboard snapshot and SSE delta stream
// (optionalAuth so the viewer themselves / admins see real names, issue #511)
router.get("/leaderboard/:leagueId", optionalAuth, getLiveProvisionalLeaderboard);
router.get("/leaderboard/:leagueId/stream", optionalAuth, streamLiveProvisionalLeaderboard);

export default router;
