import { Router } from "express";
import {
  getLiveTimeline,
  streamLiveTimeline,
  getLiveProvisionalLeaderboard,
  streamLiveProvisionalLeaderboard,
} from "../controllers/live.controller.js";

const router = Router();

// REST timeline endpoint
router.get("/timeline/:gameweekId", getLiveTimeline);

// Real-time SSE timeline stream
router.get("/timeline/:gameweekId/stream", streamLiveTimeline);

// Live provisional leaderboard snapshot and SSE delta stream
router.get("/leaderboard/:leagueId", getLiveProvisionalLeaderboard);
router.get("/leaderboard/:leagueId/stream", streamLiveProvisionalLeaderboard);

export default router;
