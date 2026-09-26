import { Request, Response, NextFunction } from "express";
import {
  payoutDeadLetterService,
  DeadLetterNotFoundError,
  DeadLetterConflictError,
  FailedPayoutStatus,
} from "../services/financial/payoutDeadLetterService.js";
import {
  financialService,
  FinancialNotFoundError,
  FinancialValidationError,
} from "../services/financial/financialService.js";
import {
  financialAuditLog,
  FinancialAuditAction,
} from "../services/audit/financialAuditLog.js";
import { TransactionType } from "../types/index.js";

/**
 * Payout Admin Controller — manual intervention tooling for failed payouts.
 *
 * Laravel equivalent: an admin-only controller wrapping `queue:failed`,
 * `queue:retry` and `queue:forget` for the payout dead-letter queue.
 *
 * All routes are mounted behind requireAuth + RBAC (see admin.routes.ts); the
 * acting admin is always taken from the verified token, never from the body.
 */

const MAX_NOTE_LENGTH = 500;

function handleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof DeadLetterNotFoundError || error instanceof FinancialNotFoundError) {
    res.status(404).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof DeadLetterConflictError) {
    res.status(409).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof FinancialValidationError) {
    res.status(400).json({ success: false, message: error.message });
    return;
  }
  next(error);
}

function parseEnum<T extends string>(value: unknown, allowed: Record<string, T>): T | undefined | null {
  if (value === undefined || value === "") return undefined;
  return Object.values(allowed).includes(value as T) ? (value as T) : null;
}

function parseNote(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_NOTE_LENGTH) return null;
  return value.trim() || undefined;
}

/**
 * GET /api/v1/admin/payouts/dead-letter
 * Query: status, leagueId, type, limit, offset
 */
export async function listFailedPayouts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const status = parseEnum(req.query.status, FailedPayoutStatus);
    const type = parseEnum(req.query.type, TransactionType);
    if (status === null || type === null) {
      res.status(400).json({ success: false, message: "Invalid status or type filter" });
      return;
    }

    const result = await payoutDeadLetterService.list({
      status,
      type,
      leagueId: typeof req.query.leagueId === "string" ? req.query.leagueId : undefined,
      limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
      offset: req.query.offset ? Number(req.query.offset) || undefined : undefined,
    });

    res.json({
      success: true,
      data: result.items,
      meta: { total: result.total, limit: result.limit, offset: result.offset },
    });
  } catch (error) {
    handleError(error, res, next);
  }
}

/**
 * GET /api/v1/admin/payouts/dead-letter/:id
 */
export async function getFailedPayout(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const entry = await payoutDeadLetterService.get(req.params.id as string);
    res.json({ success: true, data: entry });
  } catch (error) {
    handleError(error, res, next);
  }
}

/**
 * POST /api/v1/admin/payouts/dead-letter/:id/retry
 * Body: { note?: string }
 */
export async function retryFailedPayout(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const note = parseNote(req.body?.note);
    if (note === null) {
      res.status(400).json({
        success: false,
        message: `note must be a string of at most ${MAX_NOTE_LENGTH} characters`,
      });
      return;
    }

    const result = await financialService.retryDeadLetteredPayout(
      req.params.id as string,
      req.user.id,
      note
    );

    // A failed retry is a valid outcome of the request (the entry is re-queued),
    // reported as 502 because the upstream payout rail rejected it.
    res.status(result.success ? 200 : 502).json({
      success: result.success,
      message: result.success
        ? "Payout retried successfully"
        : `Payout retry failed: ${result.error}`,
      data: result,
    });
  } catch (error) {
    handleError(error, res, next);
  }
}

/**
 * POST /api/v1/admin/payouts/dead-letter/:id/discard
 * Body: { reason: string }
 */
export async function discardFailedPayout(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const reason = parseNote(req.body?.reason);
    if (!reason) {
      res.status(400).json({
        success: false,
        message: `reason is required (max ${MAX_NOTE_LENGTH} characters) to discard a payout`,
      });
      return;
    }

    const entry = await payoutDeadLetterService.discard(req.params.id as string, req.user.id, reason);
    res.json({ success: true, message: "Payout discarded", data: entry });
  } catch (error) {
    handleError(error, res, next);
  }
}

/**
 * GET /api/v1/admin/audit/financial
 * Query: userId, leagueId, action, from, to, limit
 */
export async function listFinancialAuditLog(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const action = parseEnum(req.query.action, FinancialAuditAction);
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    if (action === null || (from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
      res.status(400).json({ success: false, message: "Invalid action or date filter" });
      return;
    }

    const entries = await financialAuditLog.query({
      action,
      from,
      to,
      userId: typeof req.query.userId === "string" ? req.query.userId : undefined,
      leagueId: typeof req.query.leagueId === "string" ? req.query.leagueId : undefined,
      limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
    });

    res.json({ success: true, data: entries });
  } catch (error) {
    next(error);
  }
}
