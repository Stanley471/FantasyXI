import { Request, Response, NextFunction } from "express";
import { securityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";
import {
  sybilDetectionGraphService,
  SybilLeagueNotFoundError,
} from "../services/security/sybilDetectionGraph.js";
import { prisma } from "../config/db.js";

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

/**
 * GET /api/v1/admin/security/sybil/leagues/:leagueId[?refresh=true] (issue #274)
 *
 * Sybil-ring review for one league: suspected account clusters with the
 * evidence behind every link, per-account risk scores and the hub signals
 * that were ignored. Review only - fund actions stay a manual decision.
 */
export async function getLeagueSybilReport(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const report = await sybilDetectionGraphService.analyzeLeague(String(req.params.leagueId), {
      refresh: req.query.refresh === "true",
    });
    res.json({ success: true, data: report });
  } catch (error) {
    if (error instanceof SybilLeagueNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

/** Clears an automated payout hold after an administrator completes review. */
export async function releaseSybilPayoutHold(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = String(req.params.leagueId);
    const userId = String(req.params.userId);
    const member = await prisma.leagueMember.findUnique({
      where: { leagueId_userId: { leagueId, userId } },
      select: { payoutHoldAt: true, payoutRiskScore: true },
    });
    if (!member) {
      res.status(404).json({ success: false, message: "League member not found" });
      return;
    }
    if (!member.payoutHoldAt) {
      res.status(409).json({ success: false, message: "This account does not have an active payout hold" });
      return;
    }

    await prisma.$transaction([
      prisma.leagueMember.update({
        where: { leagueId_userId: { leagueId, userId } },
        data: { payoutHoldAt: null, payoutHoldReason: null, payoutRiskScore: null },
      }),
      prisma.accountSecurityEvent.create({
        data: {
          userId,
          type: "SYBIL_PAYOUT_HOLD_RELEASED",
          detail: {
            leagueId,
            previousRiskScore: member.payoutRiskScore,
            reviewedBy: req.user?.id ?? null,
          },
        },
      }),
    ]);

    res.json({ success: true, message: "Payout hold released" });
  } catch (error) {
    next(error);
  }
}
