import { Request, Response, NextFunction } from "express";
import { securityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";
import {
  sybilDetectionGraphService,
  SybilDetectionGraphService,
} from "../services/security/sybilDetectionGraphService.js";

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

function parseSybilQuery(query: Request["query"]): {
  leagueId?: string;
  refresh: boolean;
  minRisk: number;
} | null {
  const leagueId = typeof query.leagueId === "string" && query.leagueId.trim() ? query.leagueId.trim() : undefined;
  const refresh = query.refresh === "true" || query.refresh === "1";
  const minRisk = query.minRisk === undefined ? 0 : Number(query.minRisk);
  if (!Number.isFinite(minRisk) || minRisk < 0 || minRisk > 1) return null;
  return { leagueId, refresh, minRisk };
}

/**
 * GET /api/v1/admin/security/sybil-report (issue #274)
 * Query: leagueId? (scope to one league), refresh=true (bypass the cached
 * report), minRisk? (0-1, filters flagged accounts and clusters).
 *
 * Returns suspected multi-account clusters with the evidence edges joining
 * them, flagged accounts with risk scores, and coordinated squad submission
 * patterns with confidence ratings. Review only: no automated action is taken.
 */
export function createSybilReportHandler(service: Pick<SybilDetectionGraphService, "generateReport"> = sybilDetectionGraphService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = parseSybilQuery(req.query);
      if (!query) {
        res.status(400).json({ success: false, message: "minRisk must be a number between 0 and 1" });
        return;
      }
      const report = await service.generateReport({ leagueId: query.leagueId }, { refresh: query.refresh });
      res.json({
        success: true,
        data: {
          ...report,
          clusters: report.clusters.filter((c) => c.riskScore >= query.minRisk),
          flaggedUsers: report.flaggedUsers.filter((u) => u.riskScore >= query.minRisk),
        },
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * GET /api/v1/admin/security/sybil-report/users/:userId (issue #274)
 * One account's risk score, cluster membership and connecting evidence.
 */
export function createSybilUserBreakdownHandler(
  service: Pick<SybilDetectionGraphService, "getUserBreakdown"> = sybilDetectionGraphService
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = parseSybilQuery(req.query);
      if (!query) {
        res.status(400).json({ success: false, message: "minRisk must be a number between 0 and 1" });
        return;
      }
      const data = await service.getUserBreakdown(
        req.params.userId as string,
        { leagueId: query.leagueId },
        { refresh: query.refresh }
      );
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}

export const getSybilReport = createSybilReportHandler();
export const getSybilUserBreakdown = createSybilUserBreakdownHandler();
