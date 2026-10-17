export type LedgerTxType = "DEPOSIT" | "PAYOUT" | "PLATFORM_FEE" | "REFUND";
export type LedgerTxStatus = "PENDING" | "CONFIRMED" | "FAILED";

export interface DbLedgerTransaction {
  id: string;
  leagueId: string;
  userId: string;
  type: LedgerTxType;
  status: LedgerTxStatus;
  amount: number;
  assetCode: string;
  stellarTxHash: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

export interface OnChainHorizonTransaction {
  txHash: string;
  ledgerSeq: number;
  successful: boolean;
  leagueId: string;
  userId?: string;
  type: LedgerTxType;
  amount: number;
  assetCode: string;
  timestamp: Date;
}

export type DiscrepancyCategory =
  | "PHANTOM_DB_RECORD"
  | "UNINDEXED_ONCHAIN_TX"
  | "AMOUNT_MISMATCH"
  | "ASSET_MISMATCH"
  | "STALE_PENDING_RECORD";

export interface ReconciliationDiscrepancy {
  category: DiscrepancyCategory;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  leagueId: string;
  txHash: string | null;
  dbTransactionId: string | null;
  dbAmount: number | null;
  onChainAmount: number | null;
  deltaAmount: number;
  description: string;
}

export interface LedgerReconciliationAuditReport {
  reportId: string;
  generatedAt: string;
  windowStartIso: string;
  windowEndIso: string;
  isBalanced: boolean;
  summary: {
    dbConfirmedCount: number;
    onChainSuccessfulCount: number;
    matchedCount: number;
    discrepancyCount: number;
    dbConfirmedDepositsTotal: number;
    onChainDepositsTotal: number;
    dbConfirmedPayoutsTotal: number;
    onChainPayoutsTotal: number;
    netDepositDrift: number;
    netPayoutDrift: number;
  };
  discrepancies: ReconciliationDiscrepancy[];
}

const STROOP_TOLERANCE = 1e-6;

export class LedgerReconciliationService {
  /**
   * Reconciles PostgreSQL financial ledger records against Stellar Horizon / Soroban
   * on-chain transactions over a target window.
   */
  public reconcileWindow(params: {
    reportId?: string;
    windowStart: Date;
    windowEnd: Date;
    dbTransactions: DbLedgerTransaction[];
    onChainTransactions: OnChainHorizonTransaction[];
    now?: Date;
  }): LedgerReconciliationAuditReport {
    const now = params.now ?? new Date();
    const reportId = params.reportId ?? `recon-${now.getTime()}`;

    const onChainByHash = new Map<string, OnChainHorizonTransaction>();
    for (const tx of params.onChainTransactions) {
      onChainByHash.set(tx.txHash, tx);
    }

    const seenOnChainHashes = new Set<string>();
    const discrepancies: ReconciliationDiscrepancy[] = [];
    let matchedCount = 0;

    let dbConfirmedDepositsTotal = 0;
    let dbConfirmedPayoutsTotal = 0;
    let onChainDepositsTotal = 0;
    let onChainPayoutsTotal = 0;

    for (const tx of params.onChainTransactions) {
      if (!tx.successful) continue;
      if (tx.type === "DEPOSIT") onChainDepositsTotal += tx.amount;
      if (tx.type === "PAYOUT") onChainPayoutsTotal += tx.amount;
    }

    for (const dbTx of params.dbTransactions) {
      if (dbTx.status === "CONFIRMED") {
        if (dbTx.type === "DEPOSIT") dbConfirmedDepositsTotal += dbTx.amount;
        if (dbTx.type === "PAYOUT") dbConfirmedPayoutsTotal += dbTx.amount;
      }

      if (!dbTx.stellarTxHash) {
        if (dbTx.status === "CONFIRMED") {
          discrepancies.push({
            category: "PHANTOM_DB_RECORD",
            severity: "CRITICAL",
            leagueId: dbTx.leagueId,
            txHash: null,
            dbTransactionId: dbTx.id,
            dbAmount: dbTx.amount,
            onChainAmount: null,
            deltaAmount: -dbTx.amount,
            description: `DB transaction ${dbTx.id} is marked CONFIRMED without a Stellar txHash`,
          });
        }
        continue;
      }

      const chainTx = onChainByHash.get(dbTx.stellarTxHash);

      if (!chainTx || !chainTx.successful) {
        if (dbTx.status === "CONFIRMED") {
          discrepancies.push({
            category: "PHANTOM_DB_RECORD",
            severity: "CRITICAL",
            leagueId: dbTx.leagueId,
            txHash: dbTx.stellarTxHash,
            dbTransactionId: dbTx.id,
            dbAmount: dbTx.amount,
            onChainAmount: null,
            deltaAmount: -dbTx.amount,
            description: chainTx
              ? `DB transaction ${dbTx.id} is CONFIRMED, but on-chain tx ${dbTx.stellarTxHash} failed`
              : `DB transaction ${dbTx.id} is CONFIRMED, but txHash ${dbTx.stellarTxHash} does not exist on Stellar Horizon`,
          });
        }
        if (chainTx) {
          seenOnChainHashes.add(chainTx.txHash);
        }
        continue;
      }

      seenOnChainHashes.add(chainTx.txHash);

      if (dbTx.status === "PENDING") {
        discrepancies.push({
          category: "STALE_PENDING_RECORD",
          severity: "HIGH",
          leagueId: dbTx.leagueId,
          txHash: dbTx.stellarTxHash,
          dbTransactionId: dbTx.id,
          dbAmount: dbTx.amount,
          onChainAmount: chainTx.amount,
          deltaAmount: chainTx.amount,
          description: `DB transaction ${dbTx.id} is stuck in PENDING, but on-chain tx ${chainTx.txHash} succeeded at ledger ${chainTx.ledgerSeq}`,
        });
        continue;
      }

      if (dbTx.status === "CONFIRMED") {
        if (dbTx.assetCode !== chainTx.assetCode) {
          discrepancies.push({
            category: "ASSET_MISMATCH",
            severity: "CRITICAL",
            leagueId: dbTx.leagueId,
            txHash: dbTx.stellarTxHash,
            dbTransactionId: dbTx.id,
            dbAmount: dbTx.amount,
            onChainAmount: chainTx.amount,
            deltaAmount: chainTx.amount - dbTx.amount,
            description: `Asset mismatch for tx ${dbTx.stellarTxHash}: DB recorded ${dbTx.assetCode}, Horizon recorded ${chainTx.assetCode}`,
          });
          continue;
        }

        const diff = Number((chainTx.amount - dbTx.amount).toFixed(7));
        if (Math.abs(diff) > STROOP_TOLERANCE) {
          discrepancies.push({
            category: "AMOUNT_MISMATCH",
            severity: "CRITICAL",
            leagueId: dbTx.leagueId,
            txHash: dbTx.stellarTxHash,
            dbTransactionId: dbTx.id,
            dbAmount: dbTx.amount,
            onChainAmount: chainTx.amount,
            deltaAmount: diff,
            description: `Amount mismatch for tx ${dbTx.stellarTxHash}: DB recorded ${dbTx.amount} ${dbTx.assetCode}, Horizon recorded ${chainTx.amount} ${chainTx.assetCode}`,
          });
          continue;
        }

        matchedCount += 1;
      }
    }

    // Check for confirmed on-chain transactions missing from PostgreSQL entirely
    for (const chainTx of params.onChainTransactions) {
      if (!chainTx.successful) continue;
      if (!seenOnChainHashes.has(chainTx.txHash)) {
        discrepancies.push({
          category: "UNINDEXED_ONCHAIN_TX",
          severity: "CRITICAL",
          leagueId: chainTx.leagueId,
          txHash: chainTx.txHash,
          dbTransactionId: null,
          dbAmount: null,
          onChainAmount: chainTx.amount,
          deltaAmount: chainTx.amount,
          description: `On-chain ${chainTx.type} tx ${chainTx.txHash} (${chainTx.amount} ${chainTx.assetCode}) at ledger ${chainTx.ledgerSeq} is missing from PostgreSQL`,
        });
      }
    }

    const netDepositDrift = Number(
      (onChainDepositsTotal - dbConfirmedDepositsTotal).toFixed(7)
    );
    const netPayoutDrift = Number(
      (onChainPayoutsTotal - dbConfirmedPayoutsTotal).toFixed(7)
    );

    const isBalanced =
      discrepancies.length === 0 &&
      Math.abs(netDepositDrift) <= STROOP_TOLERANCE &&
      Math.abs(netPayoutDrift) <= STROOP_TOLERANCE;

    return {
      reportId,
      generatedAt: now.toISOString(),
      windowStartIso: params.windowStart.toISOString(),
      windowEndIso: params.windowEnd.toISOString(),
      isBalanced,
      summary: {
        dbConfirmedCount: params.dbTransactions.filter(
          (t) => t.status === "CONFIRMED"
        ).length,
        onChainSuccessfulCount: params.onChainTransactions.filter(
          (t) => t.successful
        ).length,
        matchedCount,
        discrepancyCount: discrepancies.length,
        dbConfirmedDepositsTotal: Number(dbConfirmedDepositsTotal.toFixed(7)),
        onChainDepositsTotal: Number(onChainDepositsTotal.toFixed(7)),
        dbConfirmedPayoutsTotal: Number(dbConfirmedPayoutsTotal.toFixed(7)),
        onChainPayoutsTotal: Number(onChainPayoutsTotal.toFixed(7)),
        netDepositDrift,
        netPayoutDrift,
      },
      discrepancies,
    };
  }

  /**
   * Formats a structured reconciliation audit report as a human-readable Markdown document
   * for compliance archives and PagerDuty / Slack incident alerts.
   */
  public generateMarkdownAuditReport(
    report: LedgerReconciliationAuditReport
  ): string {
    const statusBadge = report.isBalanced ? "BALANCED" : "DISCREPANCY_DETECTED";
    const lines: string[] = [
      `# Ledger Reconciliation Report (${report.reportId})`,
      ``,
      `- **Status**: \`${statusBadge}\``,
      `- **Generated At**: ${report.generatedAt}`,
      `- **Window**: ${report.windowStartIso} to ${report.windowEndIso}`,
      ``,
      `## Summary Metrics`,
      `| Metric | Value |`,
      `| :--- | :--- |`,
      `| DB Confirmed Transactions | ${report.summary.dbConfirmedCount} |`,
      `| On-Chain Successful Transactions | ${report.summary.onChainSuccessfulCount} |`,
      `| Verified Exact Matches | ${report.summary.matchedCount} |`,
      `| Total Discrepancies | ${report.summary.discrepancyCount} |`,
      `| DB Confirmed Deposits | ${report.summary.dbConfirmedDepositsTotal} |`,
      `| On-Chain Deposits | ${report.summary.onChainDepositsTotal} |`,
      `| Net Deposit Drift | ${report.summary.netDepositDrift} |`,
      `| DB Confirmed Payouts | ${report.summary.dbConfirmedPayoutsTotal} |`,
      `| On-Chain Payouts | ${report.summary.onChainPayoutsTotal} |`,
      `| Net Payout Drift | ${report.summary.netPayoutDrift} |`,
      ``,
    ];

    if (report.discrepancies.length === 0) {
      lines.push(`## Discrepancies`, ``, `No discrepancies detected.`);
    } else {
      lines.push(
        `## Discrepancies (${report.discrepancies.length})`,
        ``,
        `| Category | Severity | League | TxHash | DB ID | Delta | Description |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`
      );
      for (const d of report.discrepancies) {
        lines.push(
          `| \`${d.category}\` | **${d.severity}** | ${d.leagueId} | ${d.txHash ?? "N/A"} | ${d.dbTransactionId ?? "N/A"} | ${d.deltaAmount} | ${d.description} |`
        );
      }
    }

    return lines.join("\n");
  }
}

export const ledgerReconciliationService = new LedgerReconciliationService();
