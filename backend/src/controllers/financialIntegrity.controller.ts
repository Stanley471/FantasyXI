import { Request, Response, NextFunction } from "express";
import {
  ledgerReconciliationService,
  reportToMarkdown,
} from "../services/financial/ledgerReconciliationService.js";
import { transactionCoordinator } from "../services/financial/transactionCoordinatorService.js";
import {
  retroactiveBpsAdjustmentService,
  ScoreAdjustmentConflictError,
  ScoreAdjustmentNotFoundError,
} from "../services/scoring/retroactiveBpsAdjustmentService.js";

/**
 * Admin tooling for ledger integrity and retroactive scoring.
 * Mounted behind requireAuth + RBAC in admin.routes.ts.
 */

const MAX_REASON_LENGTH = 200;
const MAX_LOOKBACK_LEDGERS = 120_960; // ~7 days, the usual Soroban RPC retention

function optionalPositiveInt(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * POST /api/v1/admin/reconciliation/ledger[?format=markdown]
 * Body: { fromLedger?, toLedger?, lookbackLedgers? }
 * Runs an on-demand PostgreSQL vs Stellar reconciliation and returns the report.
 */
export async function runLedgerReconciliation(req: Request, res: Response, next: NextFunction): Promise<void> {
  const body = req.body ?? {};
  const fromLedger = optionalPositiveInt(body.fromLedger);
  const toLedger = optionalPositiveInt(body.toLedger);
  const lookbackLedgers = optionalPositiveInt(body.lookbackLedgers);
  if (fromLedger === null || toLedger === null || lookbackLedgers === null) {
    res.status(400).json({ success: false, message: "fromLedger, toLedger and lookbackLedgers must be positive integers" });
    return;
  }
  if (fromLedger !== undefined && toLedger !== undefined && fromLedger > toLedger) {
    res.status(400).json({ success: false, message: "fromLedger must not be after toLedger" });
    return;
  }
  if (lookbackLedgers !== undefined && lookbackLedgers > MAX_LOOKBACK_LEDGERS) {
    res.status(400).json({ success: false, message: `lookbackLedgers must be at most ${MAX_LOOKBACK_LEDGERS}` });
    return;
  }

  try {
    const report = await ledgerReconciliationService.reconcile({
      fromLedger,
      toLedger,
      lookbackLedgers,
      trigger: "manual",
    });
    if (req.query.format === "markdown") {
      res.type("text/markdown").send(reportToMarkdown(report));
      return;
    }
    res.json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/admin/transactions/:txHash
 * Coordinator state for a tracked transaction hash.
 */
export async function getCoordinatedTransaction(req: Request, res: Response, next: NextFunction): Promise<void> {
  const txHash = String(req.params.txHash ?? "");
  if (!/^[a-fA-F0-9]{64}$/.test(txHash)) {
    res.status(400).json({ success: false, message: "txHash must be a 64-character hex string" });
    return;
  }
  try {
    const record = await transactionCoordinator.getByHash(txHash);
    if (!record) {
      res.status(404).json({ success: false, message: "Transaction is not tracked" });
      return;
    }
    res.json({ success: true, data: record });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/admin/scoring/gameweeks/:gameweekId/retroactive-adjustments
 * Body: { reason? }
 * Detects official FPL stat corrections for a gameweek (local id) and applies them.
 */
export async function runRetroactiveAdjustment(req: Request, res: Response, next: NextFunction): Promise<void> {
  const gameweekId = optionalPositiveInt(req.params.gameweekId);
  if (!gameweekId) {
    res.status(400).json({ success: false, message: "gameweekId must be a positive integer" });
    return;
  }
  const reason = req.body?.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON_LENGTH)) {
    res.status(400).json({ success: false, message: `reason must be a non-empty string of at most ${MAX_REASON_LENGTH} characters` });
    return;
  }

  try {
    const report = await retroactiveBpsAdjustmentService.detectAndApply(gameweekId, {
      reason: reason?.trim(),
      actorId: req.user!.id,
    });
    res.json({ success: true, data: report });
  } catch (error) {
    if (error instanceof ScoreAdjustmentNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof ScoreAdjustmentConflictError) {
      res.status(409).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}
