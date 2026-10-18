import { Router } from "express";
import {
  getLiveTimeline,
  streamLiveTimeline,
  getProvisionalStandings,
  streamProvisionalStandings,
} from "../controllers/live.controller.js";

const router = Router();

// REST timeline endpoint
router.get("/timeline/:gameweekId", getLiveTimeline);

// Real-time SSE timeline stream
router.get("/timeline/:gameweekId/stream", streamLiveTimeline);

// Live provisional league standings from Redis (issue #268)
router.get("/leagues/:leagueId/provisional", getProvisionalStandings);
router.get("/leagues/:leagueId/provisional/stream", streamProvisionalStandings);

export default router;
