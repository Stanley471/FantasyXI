import { ledgerReconciliationService } from "../services/financial/ledgerReconciliationService.js";
import {
  ledgerDeltaAuditor,
  LedgerDeltaAuditReport,
} from "../services/financial/ledgerDeltaAuditor.js";

/**
 * Daily Ledger Reconciliation Job (issue #261).
 *
 * Compares the last day of confirmed ledger rows with the escrow contract's
 * on-chain events and Horizon. Discrepancies are recorded in the financial
 * audit log and sent to administrators by the service itself; the job only
 * logs a one-line summary.
 */
export async function runLedgerReconciliationJob(): Promise<void> {
  const report = await ledgerReconciliationService.reconcile({ trigger: "scheduled" });
  const { summary } = report;
  const line =
    `[jobs] Ledger reconciliation ${report.runId} (ledgers ${report.ledgerRange.from}-${report.ledgerRange.to}): ` +
    `${summary.dbRecords} ledger rows, ${summary.onChainMovements} on-chain movements, ` +
    `${summary.discrepancies} discrepanc${summary.discrepancies === 1 ? "y" : "ies"}`;
  if (report.status === "BALANCED") console.log(line);
  else console.warn(line);
}

/**
 * Scheduled Ledger Delta Audit Job (issue #345).
 *
 * Compares contract escrow balances and Horizon ledger sequences against
 * active PostgreSQL league deposits, refunds, payouts, and contract fees.
 */
export async function runLedgerDeltaAuditJob(): Promise<LedgerDeltaAuditReport> {
  return ledgerDeltaAuditor.runDeltaAudit({ trigger: "scheduled" });
}

