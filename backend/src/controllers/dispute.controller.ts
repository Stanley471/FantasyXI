import { Request, Response, NextFunction } from "express";
import {
  disputeResolutionService,
  DisputeStatus,
} from "../services/financial/disputeResolutionService.js";
import {
  FinancialValidationError,
  FinancialNotFoundError,
  FinancialForbiddenError,
  FinancialConflictError,
} from "../services/financial/financialService.js";

function handleDisputeError(
  error: unknown,
  res: Response,
  next: NextFunction
): void {
  if (error instanceof FinancialValidationError) {
    res.status(400).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof FinancialForbiddenError) {
    res.status(403).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof FinancialNotFoundError) {
    res.status(404).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof FinancialConflictError) {
    res.status(409).json({ success: false, message: error.message });
    return;
  }
  next(error);
}

/**
 * POST /api/v1/leagues/:leagueId/financial/disputes
 * Raises a payment/scoring dispute on a league and automatically freezes on-chain escrow.
 */
export async function fileLeagueDispute(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const { category, reason, evidence } = req.body ?? {};

    const result = await disputeResolutionService.fileDispute({
      leagueId,
      reporterId: req.user.id,
      category,
      reason,
      evidence:
        evidence && typeof evidence === "object" && !Array.isArray(evidence)
          ? evidence
          : null,
    });

    res.status(201).json({
      success: true,
      message:
        "Dispute filed and league escrow automatically frozen pending administrative review",
      data: result,
    });
  } catch (error) {
    handleDisputeError(error, res, next);
  }
}

/**
 * GET /api/v1/leagues/:leagueId/financial/disputes
 * Lists all payment disputes for a specific league.
 */
export async function listLeagueDisputes(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const disputes = await disputeResolutionService.listDisputes({ leagueId });

    res.status(200).json({
      success: true,
      data: disputes,
    });
  } catch (error) {
    handleDisputeError(error, res, next);
  }
}

/**
 * GET /api/v1/admin/disputes
 * Administrative dashboard endpoint to list disputes across all leagues with optional status/leagueId filters.
 */
export async function listAdminDisputes(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const statusParam =
      typeof req.query.status === "string"
        ? req.query.status.toUpperCase()
        : undefined;
    let statusFilter: DisputeStatus | undefined;

    if (statusParam) {
      if (!Object.values(DisputeStatus).includes(statusParam as DisputeStatus)) {
        res.status(400).json({
          success: false,
          message: `Invalid dispute status filter '${statusParam}'`,
        });
        return;
      }
      statusFilter = statusParam as DisputeStatus;
    }

    const leagueId =
      typeof req.query.leagueId === "string" ? req.query.leagueId : undefined;

    const disputes = await disputeResolutionService.listDisputes({
      leagueId,
      status: statusFilter,
    });

    res.status(200).json({
      success: true,
      data: disputes,
    });
  } catch (error) {
    handleDisputeError(error, res, next);
  }
}

/**
 * GET /api/v1/admin/disputes/:disputeId
 * Retrieves a single dispute with its immutable ruling logs and chain integrity status.
 */
export async function getAdminDispute(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const disputeId = req.params.disputeId as string;
    const dispute = await disputeResolutionService.getDisputeById(disputeId);
    const integrity =
      await disputeResolutionService.verifyRulingLogIntegrity(disputeId);

    res.status(200).json({
      success: true,
      data: {
        dispute,
        rulingLogIntegrity: integrity,
      },
    });
  } catch (error) {
    handleDisputeError(error, res, next);
  }
}

/**
 * POST /api/v1/admin/disputes/:disputeId/review
 * Places an OPEN dispute into UNDER_REVIEW while maintaining the escrow freeze.
 */
export async function reviewAdminDispute(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const disputeId = req.params.disputeId as string;
    const { justification } = req.body ?? {};

    const result = await disputeResolutionService.markUnderReview(disputeId, {
      adminUserId: req.user.id,
      justification,
    });

    res.status(200).json({
      success: true,
      message: "Dispute placed under administrative review",
      data: result,
    });
  } catch (error) {
    handleDisputeError(error, res, next);
  }
}

/**
 * POST /api/v1/admin/disputes/:disputeId/resolve
 * Submits a final admin ruling (RESOLVED_PAYOUT or RESOLVED_REFUND), records an immutable
 * hash-chained ruling log, lifts the escrow freeze, and triggers either prize payout or refunds.
 */
export async function resolveAdminDispute(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const disputeId = req.params.disputeId as string;
    const { ruling, justification, refundProportionBps } = req.body ?? {};

    const result = await disputeResolutionService.resolveDispute(disputeId, {
      adminUserId: req.user.id,
      ruling,
      justification,
      refundProportionBps:
        refundProportionBps !== undefined
          ? Number(refundProportionBps)
          : undefined,
    });

    res.status(200).json({
      success: true,
      message: `Dispute resolved with ruling ${result.dispute.status}`,
      data: result,
    });
  } catch (error) {
    handleDisputeError(error, res, next);
  }
}

/**
 * GET /api/v1/admin/disputes/:disputeId/verify-log
 * Verifies the cryptographic SHA-256 hash chain of all ruling logs for a dispute.
 */
export async function verifyDisputeRulingLog(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const disputeId = req.params.disputeId as string;
    await disputeResolutionService.getDisputeById(disputeId);
    const verification =
      await disputeResolutionService.verifyRulingLogIntegrity(disputeId);

    res.status(200).json({
      success: true,
      data: verification,
    });
  } catch (error) {
    handleDisputeError(error, res, next);
  }
}
