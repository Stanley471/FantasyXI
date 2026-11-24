import type { NextFunction, Request, Response } from "express";
import { clientTelemetryService } from "../services/telemetry/clientTelemetryService.js";

export function ingestClientTelemetry(req: Request, res: Response, next: NextFunction): void {
  try {
    let body: unknown = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).json({ success: false, message: "A valid telemetry event batch is required" });
        return;
      }
    }
    const accepted = clientTelemetryService.ingest(body, {
      ip: req.ip ?? req.socket.remoteAddress ?? "unknown",
      userAgent: req.headers["user-agent"] ?? null,
    });
    if (accepted.length === 0) {
      res.status(400).json({ success: false, message: "A valid telemetry event batch is required" });
      return;
    }
    res.status(202).json({ success: true, accepted: accepted.length });
  } catch (error) {
    next(error);
  }
}
