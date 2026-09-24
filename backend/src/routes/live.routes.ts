import { Router } from "express";
import { getLiveTimeline, streamLiveTimeline } from "../controllers/live.controller.js";

const router = Router();

// REST timeline endpoint
router.get("/timeline/:gameweekId", getLiveTimeline);

// Real-time SSE timeline stream
router.get("/timeline/:gameweekId/stream", streamLiveTimeline);

export default router;
