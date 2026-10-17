import { Request, Response, NextFunction } from "express";
import { securityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";
import {
  sybilDetectionGraphService,
  type AccountActivityNode,
} from "../services/security/sybilDetectionGraphService.js";

/**
 * Security Administration Controller (issue #117 & #274).
 *
 * Read-only view of detected anomalies (failed-login spikes, new-device
 * logins, and Sybil syndicate graph clusters) for admin review.
 */

function parseAnomalyType(value: unknown): SecurityAnomalyType | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (Object.values(SecurityAnomalyType) as string[]).includes(value)) {
    return value as SecurityAnomalyType;
  }
  return null;
}

export async function listSecurityAnomalies(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const type = parseAnomalyType(req.query.type);
    if (type === null) {
      res.status(400).json({ success: false, message: "Invalid anomaly type filter" });
      return;
    }

    const entries = securityAnomalyLog.query({
      type: type ?? undefined,
      userId: typeof req.query.userId === "string" ? req.query.userId : undefined,
      limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
    });

    res.json({ success: true, data: entries });
  } catch (error) {
    next(error);
  }
}

export async function getSybilGraphReport(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const accounts = Array.isArray(req.body?.accounts)
      ? (req.body.accounts as AccountActivityNode[])
      : undefined;

    const report = accounts
      ? sybilDetectionGraphService.analyzeAccounts(accounts)
      : sybilDetectionGraphService.getLatestReport() ??
        sybilDetectionGraphService.analyzeAccounts([]);

    res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    next(error);
  }
}

