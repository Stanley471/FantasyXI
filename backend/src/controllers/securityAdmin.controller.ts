import { Request, Response, NextFunction } from "express";
import { securityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";

/**
 * Security Administration Controller (issue #117).
 *
 * Read-only view of detected anomalies (failed-login spikes, new-device
 * logins) for admin review. Automated account actions are out of scope -
 * this endpoint only surfaces what was detected.
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
