import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../config/db.js";
import {
  FinancialAuditAction,
  FinancialAuditRecorder,
  financialAuditLog,
  SYSTEM_ACTOR,
} from "../audit/financialAuditLog.js";
import {
  adminAlertNotifier,
  AdminAlertSink,
} from "../notifications/adminAlertNotifier.js";
import {
  LeagueStatus,
  TransactionStatus,
  TransactionType,
} from "../../types/index.js";
import { toContractLeagueId } from "./contractLeagueId.js";
import {
  decimalToStroops,
  formatStroops,
  STROOPS_PER_UNIT,
} from "./ledgerReconciliationService.js";
import { stellarService, StellarService } from "./stellarService.js";

export type DeltaAnomalyKind =
  | "BALANCE_DRIFT"
  | "MISSING_DEPOSIT_RECORD"
  | "PARTIAL_DEPOSIT_MISMATCH"
  | "UNCREDITED_PAYOUT"
  | "REFUND_DELTA_MISMATCH"
  | "CONTRACT_FEE_MISMATCH"
  | "SEQUENCE_REGRESSION";

export interface HorizonChainMovementRecord {
  txHash: string;
  sequenceId: string;
  ledgerSeq: number;
  kind: "DEPOSIT" | "PAYOUT" | "REFUND" | "FEE";
  leagueId?: string;
  participantAddress?: string;
  userId?: string;
  amountStroops: bigint;
}

export interface HorizonAccountStateSnapshot {
  accountId: string;
  accountSequence: string;
  latestLedgerSeq: number;
  usdcBalanceStroops: bigint;
  recentMovements?: HorizonChainMovementRecord[];
}

export interface HorizonStateProvider {
  getEscrowAccountSnapshot(): Promise<HorizonAccountStateSnapshot>;
}

export interface DeltaDiscrepancyFinding {
  kind: DeltaAnomalyKind;
  severity: "critical" | "warning";
  leagueId: string;
  contractLeagueId: string;
  participantAddress?: string;
  userId?: string;
  dbAmountUsdc: string;
  onChainAmountUsdc: string;
  deltaUsdc: string;
  deltaStroops: string;
  txHashes: string[];
  sequenceIds: string[];
  ledgerSequences: number[];
  message: string;
}

export interface LeagueDeltaReconciliationSummary {
  leagueId: string;
  leagueName: string;
  contractLeagueId: string;
  status: "BALANCED" | "DISCREPANCY_DETECTED";
  horizonLedgerSeq: number;
  accountSequence: string;
  dbGrossDepositsUsdc: string;
  dbRefundsUsdc: string;
  dbPayoutsUsdc: string;
  dbContractFeesUsdc: string;
  dbExpectedEscrowUsdc: string;
  onChainEscrowBalanceUsdc: string;
  netDriftUsdc: string;
  netDriftStroops: string;
  txHashes: string[];
  sequenceIds: string[];
  findings: DeltaDiscrepancyFinding[];
}

export interface LedgerDeltaAuditReport {
  runId: string;
  generatedAt: string;
  trigger: "scheduled" | "manual";
  status: "BALANCED" | "DISCREPANCIES_FOUND";
  horizonLedgerSeq: number;
  escrowAccountSequence: string;
  discrepancyThresholdUsdc: string;
  totalDiscrepancyUsdc: string;
  highPriorityAlertTriggered: boolean;
  leaguesAudited: number;
  balancedLeagues: number;
  driftedLeagues: number;
  leagueSummaries: LeagueDeltaReconciliationSummary[];
  findings: DeltaDiscrepancyFinding[];
  integrityDigest: string;
}

export interface LedgerDeltaAuditorOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  stellar?: StellarService;
  horizonProvider?: HorizonStateProvider;
  audit?: FinancialAuditRecorder;
  alerts?: AdminAlertSink;
  /** Threshold in stroops above which high-priority alerts fire (default 10 stroops = 0.000001 USDC). */
  discrepancyThresholdStroops?: bigint;
  now?: () => Date;
}

function computeTamperEvidentDigest(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function stroopsToNumberUsdc(stroops: bigint): number {
  return Number(stroops) / Number(STROOPS_PER_UNIT);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Default Horizon state provider querying StellarService for ledger & escrow state.
 */
export class DefaultHorizonStateProvider implements HorizonStateProvider {
  constructor(private readonly stellar: StellarService = stellarService) {}

  public async getEscrowAccountSnapshot(): Promise<HorizonAccountStateSnapshot> {
    let latestLedgerSeq = 0;
    try {
      const range = await this.stellar.getRpcLedgerRange();
      latestLedgerSeq = range.latestLedger;
    } catch {
      latestLedgerSeq = 0;
    }

    return {
      accountId: "ESCROW_CONTRACT",
      accountSequence: String(latestLedgerSeq),
      latestLedgerSeq,
      usdcBalanceStroops: 0n,
      recentMovements: [],
    };
  }
}

/**
 * Automated Ledger Delta Auditor (#345).
 *
 * Reconciles PostgreSQL league financial records (deposits, partial deposits,
 * refunds, prize payouts, and contract fees) against Stellar Horizon ledger
 * sequences and Soroban contract escrow balances.
 */
export class LedgerDeltaAuditor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly stellar: StellarService;
  private readonly horizonProvider: HorizonStateProvider;
  private readonly audit: FinancialAuditRecorder;
  private readonly alerts: AdminAlertSink;
  private readonly thresholdStroops: bigint;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: LedgerDeltaAuditorOptions = {}) {
    this.db = options.db ?? prisma;
    this.stellar = options.stellar ?? stellarService;
    this.horizonProvider =
      options.horizonProvider ?? new DefaultHorizonStateProvider(this.stellar);
    this.audit = options.audit ?? financialAuditLog;
    this.alerts = options.alerts ?? adminAlertNotifier;
    this.thresholdStroops = options.discrepancyThresholdStroops ?? 10n;
    this.now = options.now ?? (() => new Date());
  }

  public startScheduled(intervalMs: number = 15 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runDeltaAudit({ trigger: "scheduled" }).catch((err) => {
        console.error("[LedgerDeltaAuditor] Scheduled audit failed:", err);
      });
    }, intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async auditLeagueDelta(
    leagueId: string,
    snapshotOverride?: HorizonAccountStateSnapshot
  ): Promise<LeagueDeltaReconciliationSummary> {
    const snapshot =
      snapshotOverride ?? (await this.horizonProvider.getEscrowAccountSnapshot());

    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: {
        members: { include: { user: true } },
        transactions: true,
      },
    });

    if (!league) {
      throw new Error(`League ${leagueId} not found`);
    }

    let contractLeagueId: bigint;
    try {
      contractLeagueId = toContractLeagueId(league.id);
    } catch {
      contractLeagueId = BigInt(Math.abs(Number(league.id) || 1));
    }

    const contractState = (await this.stellar.getContractLeagueState(
      contractLeagueId
    )) as
      | (Awaited<ReturnType<StellarService["getContractLeagueState"]>> & {
          escrow_balance?: bigint | number | string;
          platform_fee?: bigint | number | string;
        })
      | null;
    if (!contractState) {
      throw new Error(`League ${league.id} not found on Soroban contract`);
    }

    const allTxs: Array<Record<string, any>> = league.transactions || [];
    const confirmedTxs = allTxs.filter(
      (tx) =>
        tx.status === TransactionStatus.CONFIRMED || tx.status === "CONFIRMED"
    );

    let dbGrossDepositsStroops = 0n;
    let dbRefundsStroops = 0n;
    let dbPayoutsStroops = 0n;
    let dbContractFeesStroops = 0n;

    const txHashesSet = new Set<string>();
    const sequenceIdsSet = new Set<string>();
    const ledgerSequencesSet = new Set<number>();
    let maxDbLedgerSeq = 0;

    for (const tx of confirmedTxs) {
      const amountStroops = decimalToStroops(tx.amount ?? 0);
      if (tx.stellarTxHash) {
        txHashesSet.add(String(tx.stellarTxHash));
      }
      if (tx.sequenceNumber || tx.sequenceId) {
        sequenceIdsSet.add(String(tx.sequenceNumber || tx.sequenceId));
      }
      if (typeof tx.ledgerSeq === "number" && tx.ledgerSeq > 0) {
        ledgerSequencesSet.add(tx.ledgerSeq);
        sequenceIdsSet.add(String(tx.ledgerSeq));
        if (tx.ledgerSeq > maxDbLedgerSeq) {
          maxDbLedgerSeq = tx.ledgerSeq;
        }
      }

      switch (tx.type) {
        case TransactionType.ENTRY_FEE:
        case "ENTRY_FEE":
        case "DEPOSIT":
          dbGrossDepositsStroops += amountStroops;
          break;
        case TransactionType.REFUND:
        case "REFUND":
          dbRefundsStroops += amountStroops;
          break;
        case TransactionType.PRIZE_PAYOUT:
        case "PRIZE_PAYOUT":
          dbPayoutsStroops += amountStroops;
          break;
        case TransactionType.PLATFORM_FEE:
        case "PLATFORM_FEE":
          dbContractFeesStroops += amountStroops;
          break;
        default:
          break;
      }
    }

    const dbExpectedEscrowStroops =
      dbGrossDepositsStroops -
      dbRefundsStroops -
      dbPayoutsStroops -
      dbContractFeesStroops;

    const onChainEscrowStroops =
      contractState.escrow_balance !== undefined
        ? BigInt(contractState.escrow_balance)
        : BigInt(contractState.total_deposited ?? 0n);

    const findings: DeltaDiscrepancyFinding[] = [];

    // 1. Check Horizon ledger sequence regression
    if (
      snapshot.latestLedgerSeq > 0 &&
      maxDbLedgerSeq > snapshot.latestLedgerSeq
    ) {
      findings.push({
        kind: "SEQUENCE_REGRESSION",
        severity: "critical",
        leagueId: league.id,
        contractLeagueId: contractLeagueId.toString(),
        dbAmountUsdc: formatStroops(dbExpectedEscrowStroops),
        onChainAmountUsdc: formatStroops(onChainEscrowStroops),
        deltaUsdc: "0.0000000",
        deltaStroops: "0",
        txHashes: [...txHashesSet],
        sequenceIds: [snapshot.accountSequence, String(maxDbLedgerSeq)],
        ledgerSequences: [snapshot.latestLedgerSeq, maxDbLedgerSeq],
        message: `Database contains confirmed ledger sequence ${maxDbLedgerSeq} ahead of Horizon ledger sequence ${snapshot.latestLedgerSeq}`,
      });
    }

    // 2. Check per-participant deposit delta (partial deposits / missing deposit records)
    for (const member of league.members || []) {
      const walletAddress = member.walletAddress || member.user?.walletAddress;
      if (!walletAddress) continue;

      let onChainMemberStroops = 0n;
      try {
        onChainMemberStroops = BigInt(
          await this.stellar.getContractDeposit(contractLeagueId, walletAddress)
        );
      } catch {
        continue;
      }

      const memberDepositTxs = confirmedTxs.filter(
        (tx) =>
          (tx.type === TransactionType.ENTRY_FEE ||
            tx.type === "ENTRY_FEE" ||
            tx.type === "DEPOSIT") &&
          (tx.userId === member.userId || tx.memberId === member.id)
      );
      const memberRefundTxs = confirmedTxs.filter(
        (tx) =>
          (tx.type === TransactionType.REFUND || tx.type === "REFUND") &&
          (tx.userId === member.userId || tx.memberId === member.id)
      );

      const dbMemberGrossStroops = memberDepositTxs.reduce(
        (sum, tx) => sum + decimalToStroops(tx.amount ?? 0),
        0n
      );
      const dbMemberRefundStroops = memberRefundTxs.reduce(
        (sum, tx) => sum + decimalToStroops(tx.amount ?? 0),
        0n
      );
      const dbMemberNetStroops = dbMemberGrossStroops - dbMemberRefundStroops;

      const memberChainMovements = (snapshot.recentMovements || []).filter(
        (m) =>
          (m.leagueId === league.id ||
            m.leagueId === contractLeagueId.toString() ||
            !m.leagueId) &&
          (m.participantAddress === walletAddress || m.userId === member.userId)
      );

      for (const m of memberChainMovements) {
        txHashesSet.add(m.txHash);
        sequenceIdsSet.add(m.sequenceId);
        ledgerSequencesSet.add(m.ledgerSeq);
      }

      const memberDelta = dbMemberNetStroops - onChainMemberStroops;
      if (absBigInt(memberDelta) > this.thresholdStroops) {
        const memberHashes = [
          ...new Set([
            ...memberDepositTxs
              .map((tx) => tx.stellarTxHash)
              .filter(Boolean)
              .map(String),
            ...memberChainMovements.map((m) => m.txHash),
          ]),
        ];
        const memberSeqs = [
          ...new Set([
            ...memberDepositTxs
              .map((tx) => tx.sequenceNumber || tx.sequenceId || tx.ledgerSeq)
              .filter(Boolean)
              .map(String),
            ...memberChainMovements.map((m) => m.sequenceId),
            snapshot.accountSequence,
          ]),
        ];

        const anomalyKind: DeltaAnomalyKind =
          dbMemberGrossStroops === 0n && onChainMemberStroops > 0n
            ? "MISSING_DEPOSIT_RECORD"
            : "PARTIAL_DEPOSIT_MISMATCH";

        findings.push({
          kind: anomalyKind,
          severity: "critical",
          leagueId: league.id,
          contractLeagueId: contractLeagueId.toString(),
          participantAddress: walletAddress,
          userId: member.userId,
          dbAmountUsdc: formatStroops(dbMemberNetStroops),
          onChainAmountUsdc: formatStroops(onChainMemberStroops),
          deltaUsdc: formatStroops(memberDelta),
          deltaStroops: memberDelta.toString(),
          txHashes: memberHashes,
          sequenceIds: memberSeqs,
          ledgerSequences: [...ledgerSequencesSet],
          message:
            anomalyKind === "MISSING_DEPOSIT_RECORD"
              ? `Missing DB deposit record for wallet ${walletAddress}: on-chain deposit is ${formatStroops(onChainMemberStroops)} USDC`
              : `Participant ${walletAddress} deposit mismatch: DB net ${formatStroops(dbMemberNetStroops)} USDC vs on-chain ${formatStroops(onChainMemberStroops)} USDC`,
        });
      }
    }

    // 3. Inspect Horizon recent movements for unindexed deposits, uncredited payouts, refunds, and contract fees
    const leagueChainMovements = (snapshot.recentMovements || []).filter(
      (m) =>
        m.leagueId === league.id ||
        m.leagueId === contractLeagueId.toString() ||
        !m.leagueId
    );

    for (const movement of leagueChainMovements) {
      txHashesSet.add(movement.txHash);
      sequenceIdsSet.add(movement.sequenceId);
      ledgerSequencesSet.add(movement.ledgerSeq);

      const matchingConfirmed = confirmedTxs.find(
        (tx) =>
          tx.stellarTxHash &&
          String(tx.stellarTxHash).toLowerCase().startsWith(movement.txHash.toLowerCase())
      );

      if (movement.kind === "PAYOUT" && !matchingConfirmed) {
        findings.push({
          kind: "UNCREDITED_PAYOUT",
          severity: "critical",
          leagueId: league.id,
          contractLeagueId: contractLeagueId.toString(),
          participantAddress: movement.participantAddress,
          userId: movement.userId,
          dbAmountUsdc: "0.0000000",
          onChainAmountUsdc: formatStroops(movement.amountStroops),
          deltaUsdc: formatStroops(-movement.amountStroops),
          deltaStroops: (-movement.amountStroops).toString(),
          txHashes: [movement.txHash],
          sequenceIds: [movement.sequenceId],
          ledgerSequences: [movement.ledgerSeq],
          message: `On-chain payout of ${formatStroops(movement.amountStroops)} USDC in tx ${movement.txHash} (seq ${movement.sequenceId}) is uncredited in DB`,
        });
      } else if (movement.kind === "REFUND" && !matchingConfirmed) {
        findings.push({
          kind: "REFUND_DELTA_MISMATCH",
          severity: "critical",
          leagueId: league.id,
          contractLeagueId: contractLeagueId.toString(),
          participantAddress: movement.participantAddress,
          userId: movement.userId,
          dbAmountUsdc: "0.0000000",
          onChainAmountUsdc: formatStroops(movement.amountStroops),
          deltaUsdc: formatStroops(-movement.amountStroops),
          deltaStroops: (-movement.amountStroops).toString(),
          txHashes: [movement.txHash],
          sequenceIds: [movement.sequenceId],
          ledgerSequences: [movement.ledgerSeq],
          message: `On-chain refund of ${formatStroops(movement.amountStroops)} USDC in tx ${movement.txHash} (seq ${movement.sequenceId}) is missing from DB`,
        });
      } else if (
        movement.kind === "DEPOSIT" &&
        !matchingConfirmed &&
        !findings.some((f) => f.txHashes.includes(movement.txHash))
      ) {
        findings.push({
          kind: "MISSING_DEPOSIT_RECORD",
          severity: "critical",
          leagueId: league.id,
          contractLeagueId: contractLeagueId.toString(),
          participantAddress: movement.participantAddress,
          userId: movement.userId,
          dbAmountUsdc: "0.0000000",
          onChainAmountUsdc: formatStroops(movement.amountStroops),
          deltaUsdc: formatStroops(-movement.amountStroops),
          deltaStroops: (-movement.amountStroops).toString(),
          txHashes: [movement.txHash],
          sequenceIds: [movement.sequenceId],
          ledgerSequences: [movement.ledgerSeq],
          message: `On-chain deposit of ${formatStroops(movement.amountStroops)} USDC in tx ${movement.txHash} (seq ${movement.sequenceId}) has no confirmed DB record`,
        });
      }
    }

    // 4. Check contract platform fee consistency if exposed on contract state
    if (contractState.platform_fee !== undefined) {
      const onChainFeeStroops = BigInt(contractState.platform_fee);
      const feeDelta = dbContractFeesStroops - onChainFeeStroops;
      if (absBigInt(feeDelta) > this.thresholdStroops) {
        findings.push({
          kind: "CONTRACT_FEE_MISMATCH",
          severity: "critical",
          leagueId: league.id,
          contractLeagueId: contractLeagueId.toString(),
          dbAmountUsdc: formatStroops(dbContractFeesStroops),
          onChainAmountUsdc: formatStroops(onChainFeeStroops),
          deltaUsdc: formatStroops(feeDelta),
          deltaStroops: feeDelta.toString(),
          txHashes: [...txHashesSet],
          sequenceIds: [...sequenceIdsSet, snapshot.accountSequence],
          ledgerSequences: [...ledgerSequencesSet],
          message: `Contract fee mismatch: DB recorded ${formatStroops(dbContractFeesStroops)} USDC vs contract ${formatStroops(onChainFeeStroops)} USDC`,
        });
      }
    }

    // 5. Overall league escrow balance drift check
    const netDriftStroops = dbExpectedEscrowStroops - onChainEscrowStroops;
    if (absBigInt(netDriftStroops) > this.thresholdStroops) {
      findings.push({
        kind: "BALANCE_DRIFT",
        severity: "critical",
        leagueId: league.id,
        contractLeagueId: contractLeagueId.toString(),
        dbAmountUsdc: formatStroops(dbExpectedEscrowStroops),
        onChainAmountUsdc: formatStroops(onChainEscrowStroops),
        deltaUsdc: formatStroops(netDriftStroops),
        deltaStroops: netDriftStroops.toString(),
        txHashes: [...txHashesSet],
        sequenceIds: [...sequenceIdsSet, snapshot.accountSequence],
        ledgerSequences: [...ledgerSequencesSet, snapshot.latestLedgerSeq].filter((n) => n > 0),
        message: `Escrow balance drift of ${formatStroops(netDriftStroops)} USDC detected for league ${league.id}`,
      });
    }

    const status = findings.length === 0 ? "BALANCED" : "DISCREPANCY_DETECTED";

    return {
      leagueId: league.id,
      leagueName: league.name || "",
      contractLeagueId: contractLeagueId.toString(),
      status,
      horizonLedgerSeq: snapshot.latestLedgerSeq,
      accountSequence: snapshot.accountSequence,
      dbGrossDepositsUsdc: formatStroops(dbGrossDepositsStroops),
      dbRefundsUsdc: formatStroops(dbRefundsStroops),
      dbPayoutsUsdc: formatStroops(dbPayoutsStroops),
      dbContractFeesUsdc: formatStroops(dbContractFeesStroops),
      dbExpectedEscrowUsdc: formatStroops(dbExpectedEscrowStroops),
      onChainEscrowBalanceUsdc: formatStroops(onChainEscrowStroops),
      netDriftUsdc: formatStroops(netDriftStroops),
      netDriftStroops: netDriftStroops.toString(),
      txHashes: [...txHashesSet],
      sequenceIds: [...sequenceIdsSet, snapshot.accountSequence],
      findings,
    };
  }

  public async runDeltaAudit(
    options: { trigger?: "scheduled" | "manual"; notify?: boolean } = {}
  ): Promise<LedgerDeltaAuditReport> {
    const trigger = options.trigger ?? "manual";
    const snapshot = await this.horizonProvider.getEscrowAccountSnapshot();
    const leagues = await this.db.league.findMany({
      where: {
        status: { in: [LeagueStatus.ACTIVE, LeagueStatus.UPCOMING] },
      },
      select: { id: true },
    });

    const leagueSummaries: LeagueDeltaReconciliationSummary[] = [];
    const allFindings: DeltaDiscrepancyFinding[] = [];
    let totalDiscrepancyStroops = 0n;

    for (const { id } of leagues) {
      const summary = await this.auditLeagueDelta(id, snapshot);
      leagueSummaries.push(summary);
      allFindings.push(...summary.findings);
      totalDiscrepancyStroops += absBigInt(BigInt(summary.netDriftStroops));
    }

    const balancedLeagues = leagueSummaries.filter(
      (s) => s.status === "BALANCED"
    ).length;
    const driftedLeagues = leagueSummaries.length - balancedLeagues;
    const status: "BALANCED" | "DISCREPANCIES_FOUND" =
      allFindings.length === 0 ? "BALANCED" : "DISCREPANCIES_FOUND";
    const highPriorityAlertTriggered =
      totalDiscrepancyStroops > this.thresholdStroops || allFindings.length > 0;

    const runId = randomUUID();
    const generatedAt = this.now().toISOString();

    const coreReport = {
      runId,
      generatedAt,
      trigger,
      status,
      horizonLedgerSeq: snapshot.latestLedgerSeq,
      escrowAccountSequence: snapshot.accountSequence,
      discrepancyThresholdUsdc: formatStroops(this.thresholdStroops),
      totalDiscrepancyUsdc: formatStroops(totalDiscrepancyStroops),
      highPriorityAlertTriggered,
      leaguesAudited: leagueSummaries.length,
      balancedLeagues,
      driftedLeagues,
      leagueSummaries,
      findings: allFindings,
    };

    const integrityDigest = computeTamperEvidentDigest(coreReport);
    const fullReport: LedgerDeltaAuditReport = {
      ...coreReport,
      integrityDigest,
    };

    // Record tamper-evident audit entry
    this.audit.record({
      action:
        status === "BALANCED"
          ? FinancialAuditAction.RECONCILIATION_BALANCED
          : FinancialAuditAction.RECONCILIATION_DISCREPANCY,
      actorId: SYSTEM_ACTOR,
      amount: stroopsToNumberUsdc(totalDiscrepancyStroops),
      metadata: {
        source: "ledger-delta-auditor",
        runId,
        trigger,
        status,
        horizonLedgerSeq: snapshot.latestLedgerSeq,
        escrowAccountSequence: snapshot.accountSequence,
        totalDiscrepancyUsdc: fullReport.totalDiscrepancyUsdc,
        findingsCount: allFindings.length,
        integrityDigest,
      },
    });

    if (highPriorityAlertTriggered && options.notify !== false) {
      const findingLines = allFindings
        .slice(0, 15)
        .map(
          (f) =>
            `- [${f.severity.toUpperCase()}] ${f.kind} (league=${f.leagueId}, delta=${f.deltaUsdc} USDC, txs=${f.txHashes.join(",") || "none"}, seqs=${f.sequenceIds.join(",") || "none"}): ${f.message}`
        );

      await this.alerts.notify({
        title: `[HIGH PRIORITY] Ledger Delta Auditor detected ${allFindings.length} discrepancy finding(s)`,
        severity: "critical",
        text: [
          `Run ID: ${runId} | Horizon Ledger: ${snapshot.latestLedgerSeq} | Account Seq: ${snapshot.accountSequence}`,
          `Total Discrepancy: ${fullReport.totalDiscrepancyUsdc} USDC (Threshold: ${fullReport.discrepancyThresholdUsdc} USDC)`,
          `Integrity Digest: ${integrityDigest}`,
          ...findingLines,
        ].join("\n"),
      });
    }

    return fullReport;
  }
}

export const ledgerDeltaAuditor = new LedgerDeltaAuditor();
