import { Router, text } from "express";
import { ingestClientTelemetry } from "../controllers/telemetry.controller.js";

const router = Router();
// sendBeacon sends a string payload as text/plain. Parse that small body here;
// normal fetch requests have already been parsed by the app-level JSON parser.
router.post("/", text({ type: "text/plain", limit: "64kb" }), ingestClientTelemetry);

export default router;
