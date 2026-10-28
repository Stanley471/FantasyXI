/**
 * Ledger Reconciliation Service — transaction-level reconciliation between the
 * PostgreSQL ledger (`transactions`) and what actually happened on Stellar.
 *
 * Complements LedgerReconciliationScheduler (financialService.ts), which
 * compares per-league escrow *balances*. This service compares individual
 * *transactions*, so it can say which hash is wrong and why:
 *
 *   PHANTOM_DB_RECORD      a CONFIRMED row whose hash is unknown to (or failed on)
 *                          the network — e.g. a DB write that survived a rollback
 *   UNINDEXED_ON_CHAIN     an escrow event with no matching ledger row — e.g. a
 *                          dropped indexer event or a rolled-back DB write
 *   AMOUNT_MISMATCH        both sides exist but the amounts differ
 *   COUNT_MISMATCH         a refund event covers a different number of members
 *   LEAGUE_MISMATCH        the row and the event belong to different leagues
 *   DUPLICATE_DB_RECORD    several rows describe the same on-chain movement
 *   MISSING_CONTRACT_EVENT the hash succeeded on Horizon but moved no USDC
 *                          and emitted no matching escrow event
 *
 * On-chain data comes from Soroban RPC `getEvents` (deposit / settle / refund /
 * claimed escrow events). Ledger rows with no event (classic USDC payments
 * verified through Horizon) are checked against Horizon transactions and
 * operations before being reported.
 *
 * The service is read-only: it never edits the ledger. Each run is recorded in
 * the financial audit log and, when discrepancies are found, administrators
 * are notified (Slack / email via AdminAlertNotifier).
 */

import { randomUUID } from "node:crypto";
import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { prisma } from "../../config/db.js";
import { stellarConfig, withHorizonFailover } from "../../config/stellar.js";
import { StellarService, stellarService } from "./stellarService.js";
import { toContractLeagueId } from "./contractLeagueId.js";
import {
  FinancialAuditAction,
  FinancialAuditRecorder,
  financialAuditLog,
  SYSTEM_ACTOR,
} from "../audit/financialAuditLog.js";
import { adminAlertNotifier, AdminAlertSink } from "../notifications/adminAlertNotifier.js";
import { TransactionStatus, TransactionType } from "../../types/index.js";

export const STROOPS_PER_UNIT = 10_000_000n;
/** The ledger stores 2 decimal places, so each row may be off by up to half a cent. */
export const ROUNDING_TOLERANCE_STROOPS = 50_000n;
/** ~1 day of ledgers at 5s per ledger. */
export const DEFAULT_LOOKBACK_LEDGERS = 17_280;

/**
 * Logical ledger movements compared on both sides.
 * PRIZE_ALLOCATION is the winners' share written at settlement; PRIZE_CLAIM is
 * a winner withdrawing it later.
 */
export type LedgerMovementKind = "DEPOSIT" | "PRIZE_ALLOCATION" | "PLATFORM_FEE" | "PRIZE_CLAIM" | "REFUND";

export type DiscrepancyType =
  | "PHANTOM_DB_RECORD"
  | "UNINDEXED_ON_CHAIN"
  | "AMOUNT_MISMATCH"
  | "COUNT_MISMATCH"
  | "LEAGUE_MISMATCH"
  | "DUPLICATE_DB_RECORD"
  | "MISSING_CONTRACT_EVENT";

export type DiscrepancySeverity = "critical" | "warning";

/** One movement parsed from an escrow contract event. */
export interface OnChainMovement {
  kind: LedgerMovementKind;
  txHash: string;
  ledgerSeq: number;
  closedAt: string | null;
  eventType: string;
  contractLeagueId: string;
  address?: string;
  amountStroops?: bigint;
  /** Participants covered (refund events only carry a count) */
  count?: number;
}

export interface OnChainEventBatch {
  movements: OnChainMovement[];
  fromLedger: number;
  toLedger: number;
}

export interface OnChainEventSource {
  fetchMovements(range: { fromLedger?: number; toLedger?: number; lookbackLedgers: number }): Promise<OnChainEventBatch>;
}

export interface HorizonLookupResult {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  ledgerSeq?: number;
  closedAt?: string;
  /** USDC moved by the transaction's payment / contract-transfer operations */
  usdcTransferredStroops?: bigint;
}

export interface HorizonTransactionLookup {
  lookup(txHash: string): Promise<HorizonLookupResult>;
}

export interface ReconciliationDiscrepancy {
  type: DiscrepancyType;
  severity: DiscrepancySeverity;
  kind: LedgerMovementKind;
  txHash: string;
  ledgerSeq: number | null;
  timestamp: string | null;
  leagueId: string | null;
  contractLeagueId: string | null;
  transactionIds: string[];
  dbAmount: string | null;
  onChainAmount: string | null;
  dbCount?: number;
  onChainCount?: number;
  message: string;
}

export interface LedgerReconciliationReport {
  runId: string;
  generatedAt: string;
  trigger: "scheduled" | "manual" | "cli";
  ledgerRange: { from: number; to: number };
  status: "BALANCED" | "DISCREPANCIES_FOUND";
  summary: {
    dbRecords: number;
    onChainMovements: number;
    matched: number;
    verifiedViaHorizon: number;
    discrepancies: number;
    bySeverity: Record<DiscrepancySeverity, number>;
    byType: Partial<Record<DiscrepancyType, number>>;
  };
  discrepancies: ReconciliationDiscrepancy[];
}

export interface ReconcileOptions {
  fromLedger?: number;
  toLedger?: number;
  lookbackLedgers?: number;
  /** Rows without a ledger sequence are included when confirmed after this time */
  since?: Date;
  trigger?: LedgerReconciliationReport["trigger"];
  /** Send the admin alert when discrepancies are found (default true) */
  notify?: boolean;
}

interface DbLedgerRow {
  id: string;
  userId: string | null;
  leagueId: string | null;
  memberId: string | null;
  type: TransactionType;
  amount: { toString(): string } | number | string;
  stellarTxHash: string;
  ledgerSeq: number | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

interface DbGroup {
  kind: LedgerMovementKind;
  txHash: string;
  rows: DbLedgerRow[];
}

interface ChainGroup {
  kind: LedgerMovementKind;
  txHash: string;
  movements: OnChainMovement[];
}

// ------------------------------------------------------------
// Amount helpers (exact integer arithmetic in stroops)
// ------------------------------------------------------------

export function decimalToStroops(value: { toString(): string } | number | string): bigint {
  const text = (typeof value === "number" ? value.toFixed(7) : value.toString()).trim();
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) throw new Error(`Invalid decimal amount: ${text}`);
  const [, sign, whole = "", fraction = ""] = match;
  const stroops = BigInt(whole || "0") * STROOPS_PER_UNIT + BigInt((fraction + "0000000").slice(0, 7));
  return sign ? -stroops : stroops;
}

export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = (abs % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** First 64 hex characters: ledger rows may suffix the hash (`-fee`, `-<memberId>`, `-<winner>`). */
export function baseTxHash(hash: string): string {
  return hash.slice(0, 64).toLowerCase();
}

function dbKind(row: DbLedgerRow): LedgerMovementKind | null {
  switch (row.type) {
    case TransactionType.ENTRY_FEE:
      return "DEPOSIT";
    case TransactionType.PLATFORM_FEE:
      return "PLATFORM_FEE";
    case TransactionType.REFUND:
      return "REFUND";
    case TransactionType.PRIZE_PAYOUT:
      // Settlement rows carry the bare settle hash; indexed claims are `<hash>-<winner>`
      return row.stellarTxHash.length > 64 ? "PRIZE_CLAIM" : "PRIZE_ALLOCATION";
    default:
      return null;
  }
}

/** Stable identity of the on-chain movement a row describes, used to spot duplicates. */
function rowIdentity(kind: LedgerMovementKind, row: DbLedgerRow): string {
  switch (kind) {
    case "REFUND":
      return row.memberId ?? row.userId ?? row.id;
    case "PRIZE_ALLOCATION":
    case "PRIZE_CLAIM":
      return row.userId ?? row.id;
    default:
      return "single";
  }
}

// ------------------------------------------------------------
// Default data sources
// ------------------------------------------------------------

/** Parses escrow events (see contracts/src/lib.rs) into ledger movements. */
export function parseEscrowEvent(event: rpc.Api.EventResponse): OnChainMovement[] {
  if (!event.inSuccessfulContractCall) return [];
  const name = String(scValToNative(event.topic[0]));
  const contractLeagueId = BigInt(scValToNative(event.topic[1])).toString();
  const base = {
    txHash: event.txHash.toLowerCase(),
    ledgerSeq: event.ledger,
    closedAt: event.ledgerClosedAt ?? null,
    eventType: name,
    contractLeagueId,
  };
  const value = scValToNative(event.value);

  switch (name) {
    case "deposit": {
      const [participant, amount] = value as [string, bigint];
      return [{ ...base, kind: "DEPOSIT", address: participant, amountStroops: BigInt(amount) }];
    }
    case "settle": {
      const [totalPayout, platformFee] = value as [bigint, bigint];
      // total_payout = platform_fee + every winner's allocation (= total deposited)
      return [
        { ...base, kind: "PRIZE_ALLOCATION", amountStroops: BigInt(totalPayout) - BigInt(platformFee) },
        { ...base, kind: "PLATFORM_FEE", amountStroops: BigInt(platformFee) },
      ];
    }
    case "claimed": {
      const [winner, amount] = value as [string, bigint];
      return [{ ...base, kind: "PRIZE_CLAIM", address: winner, amountStroops: BigInt(amount) }];
    }
    case "refund":
      return [{ ...base, kind: "REFUND", count: Number(value) }];
    default:
      return [];
  }
}

export class SorobanEscrowEventSource implements OnChainEventSource {
  constructor(
    private readonly stellar: StellarService = stellarService,
    private readonly pageSize: number = 200,
    private readonly maxPages: number = 500
  ) {}

  public async fetchMovements(range: {
    fromLedger?: number;
    toLedger?: number;
    lookbackLedgers: number;
  }): Promise<OnChainEventBatch> {
    const { oldestLedger, latestLedger } = await this.stellar.getRpcLedgerRange();
    const toLedger = Math.min(range.toLedger ?? latestLedger, latestLedger);
    const requestedFrom = range.fromLedger ?? toLedger - range.lookbackLedgers;
    // Events older than the RPC node's retention window cannot be fetched
    const fromLedger = Math.max(requestedFrom, oldestLedger);

    const movements: OnChainMovement[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const response = cursor
        ? await this.stellar.getEscrowContractEvents({ cursor, limit: this.pageSize })
        : await this.stellar.getEscrowContractEvents({ startLedger: fromLedger, limit: this.pageSize });

      let reachedEnd = false;
      for (const event of response.events) {
        if (event.ledger > toLedger) {
          reachedEnd = true;
          break;
        }
        try {
          movements.push(...parseEscrowEvent(event));
        } catch (error) {
          console.warn(`[reconciliation] Unparseable event in tx ${event.txHash}:`, (error as Error).message);
        }
      }
      if (reachedEnd || response.events.length < this.pageSize) break;
      cursor = response.cursor;
    }
    return { movements, fromLedger, toLedger };
  }
}

export class HorizonLedgerLookup implements HorizonTransactionLookup {
  public async lookup(txHash: string): Promise<HorizonLookupResult> {
    let tx;
    try {
      tx = await withHorizonFailover((server) =>
        server.transactions().transaction(txHash).call()
      );
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404 || (error as Error)?.name === "NotFoundError") return { status: "NOT_FOUND" };
      throw error;
    }
    if (!tx.successful) {
      return { status: "FAILED", ledgerSeq: tx.ledger_attr, closedAt: tx.created_at };
    }

    const ops = await withHorizonFailover((server) =>
      server.operations().forTransaction(txHash).limit(200).call()
    );
    let transferred = 0n;
    for (const op of ops.records as unknown as Array<Record<string, any>>) {
      if (op.type === "payment" && op.asset_code === stellarConfig.usdcAssetCode) {
        transferred += decimalToStroops(op.amount);
      }
      if (op.type === "invoke_host_function" && Array.isArray(op.asset_balance_changes)) {
        for (const change of op.asset_balance_changes) {
          if (change.type === "transfer" && change.asset_code === stellarConfig.usdcAssetCode) {
            transferred += decimalToStroops(change.amount);
          }
        }
      }
    }
    return {
      status: "SUCCESS",
      ledgerSeq: tx.ledger_attr,
      closedAt: tx.created_at,
      usdcTransferredStroops: transferred,
    };
  }
}

// ------------------------------------------------------------
// Service
// ------------------------------------------------------------

export interface LedgerReconciliationServiceOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  events?: OnChainEventSource;
  horizon?: HorizonTransactionLookup;
  audit?: FinancialAuditRecorder;
  alerts?: AdminAlertSink;
  now?: () => Date;
}

export class LedgerReconciliationService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly events: OnChainEventSource;
  private readonly horizon: HorizonTransactionLookup;
  private readonly audit: FinancialAuditRecorder;
  private readonly alerts: AdminAlertSink;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: LedgerReconciliationServiceOptions = {}) {
    this.db = options.db ?? prisma;
    this.events = options.events ?? new SorobanEscrowEventSource();
    this.horizon = options.horizon ?? new HorizonLedgerLookup();
    this.audit = options.audit ?? financialAuditLog;
    this.alerts = options.alerts ?? adminAlertNotifier;
    this.now = options.now ?? (() => new Date());
  }

  /** In-process daily schedule (the pg-boss `ledger-reconciliation` job is the default trigger). */
  public startDaily(intervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reconcile({ trigger: "scheduled" }).catch((error) => {
        console.error("[reconciliation] Scheduled run failed:", (error as Error).message);
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

  public async reconcile(options: ReconcileOptions = {}): Promise<LedgerReconciliationReport> {
    const lookbackLedgers = options.lookbackLedgers ?? DEFAULT_LOOKBACK_LEDGERS;
    const batch = await this.events.fetchMovements({
      fromLedger: options.fromLedger,
      toLedger: options.toLedger,
      lookbackLedgers,
    });
    // ~5s per ledger: rows without a ledger sequence are matched by confirmation time
    const since =
      options.since ?? new Date(this.now().getTime() - (batch.toLedger - batch.fromLedger + 1) * 5_000);

    const rows: DbLedgerRow[] = await this.db.transaction.findMany({
      where: {
        status: TransactionStatus.CONFIRMED,
        stellarTxHash: { not: null },
        OR: [
          { ledgerSeq: { gte: batch.fromLedger, lte: batch.toLedger } },
          { ledgerSeq: null, confirmedAt: { gte: since } },
        ],
      },
      select: {
        id: true,
        userId: true,
        leagueId: true,
        memberId: true,
        type: true,
        amount: true,
        stellarTxHash: true,
        ledgerSeq: true,
        confirmedAt: true,
        createdAt: true,
      },
    });

    const report = await this.compare(rows, batch, options.trigger ?? "manual");
    this.recordRun(report);
    if (report.status === "DISCREPANCIES_FOUND" && options.notify !== false) {
      await this.notifyAdmins(report);
    }
    return report;
  }

  /** Pure comparison step (exposed for tests and offline replays). */
  public async compare(
    rows: DbLedgerRow[],
    batch: OnChainEventBatch,
    trigger: LedgerReconciliationReport["trigger"] = "manual"
  ): Promise<LedgerReconciliationReport> {
    const dbGroups = new Map<string, DbGroup>();
    for (const row of rows) {
      const kind = dbKind(row);
      if (!kind || !row.stellarTxHash) continue;
      const txHash = baseTxHash(row.stellarTxHash);
      const key = `${kind}:${txHash}`;
      const group = dbGroups.get(key) ?? { kind, txHash, rows: [] };
      group.rows.push(row);
      dbGroups.set(key, group);
    }

    const chainGroups = new Map<string, ChainGroup>();
    for (const movement of batch.movements) {
      const key = `${movement.kind}:${movement.txHash}`;
      const group = chainGroups.get(key) ?? { kind: movement.kind, txHash: movement.txHash, movements: [] };
      group.movements.push(movement);
      chainGroups.set(key, group);
    }

    const discrepancies: ReconciliationDiscrepancy[] = [];
    let matched = 0;
    let verifiedViaHorizon = 0;

    for (const [key, chain] of chainGroups) {
      const db = dbGroups.get(key);
      if (!db) {
        discrepancies.push(this.unindexed(chain));
        continue;
      }
      const found = this.compareGroups(db, chain);
      discrepancies.push(...found);
      if (!found.some((d) => d.severity === "critical")) matched++;
    }

    const horizonCache = new Map<string, Promise<HorizonLookupResult>>();
    for (const [key, db] of dbGroups) {
      if (chainGroups.has(key)) continue;
      const lookup = horizonCache.get(db.txHash) ?? this.safeLookup(db.txHash);
      horizonCache.set(db.txHash, lookup);
      const found = await this.checkAgainstHorizon(db, await lookup);
      if (found.length === 0) {
        verifiedViaHorizon++;
      }
      discrepancies.push(...this.duplicates(db), ...found);
    }

    discrepancies.sort((a, b) =>
      a.severity === b.severity ? (a.ledgerSeq ?? 0) - (b.ledgerSeq ?? 0) : a.severity === "critical" ? -1 : 1
    );

    const bySeverity: Record<DiscrepancySeverity, number> = { critical: 0, warning: 0 };
    const byType: Partial<Record<DiscrepancyType, number>> = {};
    for (const d of discrepancies) {
      bySeverity[d.severity]++;
      byType[d.type] = (byType[d.type] ?? 0) + 1;
    }

    return {
      runId: randomUUID(),
      generatedAt: this.now().toISOString(),
      trigger,
      ledgerRange: { from: batch.fromLedger, to: batch.toLedger },
      status: discrepancies.length === 0 ? "BALANCED" : "DISCREPANCIES_FOUND",
      summary: {
        dbRecords: rows.length,
        onChainMovements: batch.movements.length,
        matched,
        verifiedViaHorizon,
        discrepancies: discrepancies.length,
        bySeverity,
        byType,
      },
      discrepancies,
    };
  }

  private async safeLookup(txHash: string): Promise<HorizonLookupResult> {
    try {
      return await this.horizon.lookup(txHash);
    } catch (error) {
      // Horizon unavailable: report as not verifiable rather than failing the run
      console.warn(`[reconciliation] Horizon lookup failed for ${txHash}:`, (error as Error).message);
      return { status: "NOT_FOUND" };
    }
  }

  private dbTotal(db: DbGroup): { stroops: bigint; distinct: DbLedgerRow[] } {
    const byIdentity = new Map<string, DbLedgerRow>();
    for (const row of db.rows) {
      const identity = rowIdentity(db.kind, row);
      if (!byIdentity.has(identity)) byIdentity.set(identity, row);
    }
    const distinct = [...byIdentity.values()];
    return { stroops: distinct.reduce((sum, row) => sum + decimalToStroops(row.amount), 0n), distinct };
  }

  private base(
    db: DbGroup | null,
    chain: ChainGroup | null
  ): Omit<ReconciliationDiscrepancy, "type" | "severity" | "message" | "dbAmount" | "onChainAmount"> {
    const first = chain?.movements[0];
    const row = db?.rows[0];
    return {
      kind: (db?.kind ?? chain?.kind)!,
      txHash: (db?.txHash ?? chain?.txHash)!,
      ledgerSeq: first?.ledgerSeq ?? row?.ledgerSeq ?? null,
      timestamp: first?.closedAt ?? (row ? (row.confirmedAt ?? row.createdAt).toISOString() : null),
      leagueId: row?.leagueId ?? null,
      contractLeagueId: first?.contractLeagueId ?? (row?.leagueId ? safeContractId(row.leagueId) : null),
      transactionIds: db?.rows.map((r) => r.id) ?? [],
    };
  }

  private unindexed(chain: ChainGroup): ReconciliationDiscrepancy {
    const total = chain.movements.reduce((sum, m) => sum + (m.amountStroops ?? 0n), 0n);
    const count = chain.movements.reduce((sum, m) => sum + (m.count ?? 0), 0);
    return {
      ...this.base(null, chain),
      type: "UNINDEXED_ON_CHAIN",
      severity: "critical",
      dbAmount: null,
      onChainAmount: chain.kind === "REFUND" ? null : formatStroops(total),
      ...(chain.kind === "REFUND" ? { onChainCount: count } : {}),
      message: `On-chain ${chain.movements[0].eventType} event has no matching ${chain.kind} ledger record`,
    };
  }

  private duplicates(db: DbGroup): ReconciliationDiscrepancy[] {
    const { distinct } = this.dbTotal(db);
    if (distinct.length === db.rows.length) return [];
    return [
      {
        ...this.base(db, null),
        type: "DUPLICATE_DB_RECORD",
        // Two members claiming one deposit is a fraud signal; a doubly indexed fee is bookkeeping noise
        severity: db.kind === "DEPOSIT" ? "critical" : "warning",
        dbAmount: null,
        onChainAmount: null,
        dbCount: db.rows.length,
        message: `${db.rows.length} ledger rows describe ${distinct.length} on-chain ${db.kind} movement(s)`,
      },
    ];
  }

  private compareGroups(db: DbGroup, chain: ChainGroup): ReconciliationDiscrepancy[] {
    const found = this.duplicates(db);
    const { stroops: dbStroops, distinct } = this.dbTotal(db);

    const eventLeague = chain.movements[0].contractLeagueId;
    const mismatchedLeague = distinct.find((row) => row.leagueId && safeContractId(row.leagueId) !== eventLeague);
    if (mismatchedLeague) {
      found.push({
        ...this.base(db, chain),
        leagueId: mismatchedLeague.leagueId,
        type: "LEAGUE_MISMATCH",
        severity: "critical",
        dbAmount: null,
        onChainAmount: null,
        message: `Ledger row belongs to league ${mismatchedLeague.leagueId} but the event was emitted for contract league ${eventLeague}`,
      });
    }

    if (db.kind === "REFUND") {
      const onChainCount = chain.movements.reduce((sum, m) => sum + (m.count ?? 0), 0);
      if (onChainCount !== distinct.length) {
        found.push({
          ...this.base(db, chain),
          type: "COUNT_MISMATCH",
          severity: "critical",
          dbAmount: formatStroops(dbStroops),
          onChainAmount: null,
          dbCount: distinct.length,
          onChainCount,
          message: `Refund event covers ${onChainCount} participant(s) but ${distinct.length} refund record(s) exist`,
        });
      }
      return found;
    }

    const chainStroops = chain.movements.reduce((sum, m) => sum + (m.amountStroops ?? 0n), 0n);
    const diff = dbStroops > chainStroops ? dbStroops - chainStroops : chainStroops - dbStroops;
    if (diff > ROUNDING_TOLERANCE_STROOPS * BigInt(Math.max(distinct.length, 1))) {
      found.push({
        ...this.base(db, chain),
        type: "AMOUNT_MISMATCH",
        severity: "critical",
        dbAmount: formatStroops(dbStroops),
        onChainAmount: formatStroops(chainStroops),
        message: `${db.kind} amount differs by ${formatStroops(dbStroops - chainStroops)} USDC (ledger - chain)`,
      });
    }
    return found;
  }

  private async checkAgainstHorizon(db: DbGroup, horizon: HorizonLookupResult): Promise<ReconciliationDiscrepancy[]> {
    const { stroops: dbStroops } = this.dbTotal(db);
    const base = this.base(db, null);

    if (horizon.status === "NOT_FOUND" || horizon.status === "FAILED") {
      return [
        {
          ...base,
          ledgerSeq: base.ledgerSeq ?? horizon.ledgerSeq ?? null,
          type: "PHANTOM_DB_RECORD",
          severity: "critical",
          dbAmount: formatStroops(dbStroops),
          onChainAmount: null,
          message:
            horizon.status === "FAILED"
              ? `Ledger marks ${db.kind} as CONFIRMED but the transaction failed on-chain`
              : `Ledger marks ${db.kind} as CONFIRMED but the transaction does not exist on the network`,
        },
      ];
    }

    // Classic USDC payments are verified through Horizon; contract movements need an event
    if (db.kind === "DEPOSIT" && (horizon.usdcTransferredStroops ?? 0n) > 0n) {
      const onChain = horizon.usdcTransferredStroops!;
      const diff = dbStroops > onChain ? dbStroops - onChain : onChain - dbStroops;
      if (diff <= ROUNDING_TOLERANCE_STROOPS) return [];
      return [
        {
          ...base,
          type: "AMOUNT_MISMATCH",
          severity: "critical",
          dbAmount: formatStroops(dbStroops),
          onChainAmount: formatStroops(onChain),
          message: `Deposit amount differs from the USDC moved on Horizon by ${formatStroops(dbStroops - onChain)} USDC`,
        },
      ];
    }

    return [
      {
        ...base,
        ledgerSeq: base.ledgerSeq ?? horizon.ledgerSeq ?? null,
        type: "MISSING_CONTRACT_EVENT",
        severity: db.kind === "DEPOSIT" ? "critical" : "warning",
        dbAmount: formatStroops(dbStroops),
        onChainAmount: null,
        message: `Transaction succeeded on Horizon but emitted no ${db.kind} escrow event in the scanned range`,
      },
    ];
  }

  private recordRun(report: LedgerReconciliationReport): void {
    this.audit.record({
      action:
        report.status === "BALANCED"
          ? FinancialAuditAction.RECONCILIATION_BALANCED
          : FinancialAuditAction.RECONCILIATION_DISCREPANCY,
      actorId: SYSTEM_ACTOR,
      metadata: {
        source: "ledger-reconciliation",
        runId: report.runId,
        trigger: report.trigger,
        ledgerRange: report.ledgerRange,
        summary: report.summary,
        discrepancies: report.discrepancies.slice(0, 50).map((d) => ({
          type: d.type,
          kind: d.kind,
          txHash: d.txHash,
          ledgerSeq: d.ledgerSeq,
          leagueId: d.leagueId,
        })),
      },
    });
  }

  private async notifyAdmins(report: LedgerReconciliationReport): Promise<void> {
    const lines = report.discrepancies
      .slice(0, 20)
      .map((d) => `- [${d.severity}] ${d.type} ${d.kind} ${d.txHash} (ledger ${d.ledgerSeq ?? "?"}): ${d.message}`);
    if (report.discrepancies.length > 20) lines.push(`- …and ${report.discrepancies.length - 20} more`);
    await this.alerts.notify({
      title: `Ledger reconciliation found ${report.summary.discrepancies} discrepanc${report.summary.discrepancies === 1 ? "y" : "ies"}`,
      severity: report.summary.bySeverity.critical > 0 ? "critical" : "warning",
      text: [
        `Run ${report.runId} over ledgers ${report.ledgerRange.from}-${report.ledgerRange.to}`,
        `Critical: ${report.summary.bySeverity.critical}, warnings: ${report.summary.bySeverity.warning}`,
        ...lines,
      ].join("\n"),
    });
  }
}

function safeContractId(leagueId: string): string | null {
  try {
    return toContractLeagueId(leagueId).toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Report rendering
// ------------------------------------------------------------

export function reportToJson(report: LedgerReconciliationReport): string {
  return JSON.stringify(report, null, 2);
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  // Escape backslashes before pipes so an input like "\|" cannot break out of the cell
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

export function reportToMarkdown(report: LedgerReconciliationReport): string {
  const { summary } = report;
  const lines = [
    `# Ledger Reconciliation Report`,
    ``,
    `- **Run:** \`${report.runId}\` (${report.trigger})`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Ledger range:** ${report.ledgerRange.from} - ${report.ledgerRange.to}`,
    `- **Status:** ${report.status === "BALANCED" ? "BALANCED" : "DISCREPANCIES FOUND"}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Ledger records scanned | ${summary.dbRecords} |`,
    `| On-chain movements scanned | ${summary.onChainMovements} |`,
    `| Matched against escrow events | ${summary.matched} |`,
    `| Verified via Horizon | ${summary.verifiedViaHorizon} |`,
    `| Discrepancies | ${summary.discrepancies} (critical ${summary.bySeverity.critical}, warning ${summary.bySeverity.warning}) |`,
    ``,
  ];

  if (report.discrepancies.length === 0) {
    lines.push(`No discrepancies found.`);
    return lines.join("\n") + "\n";
  }

  lines.push(
    `## Discrepancies`,
    ``,
    `| Severity | Type | Kind | Transaction hash | Ledger | Timestamp | League | Ledger amount | On-chain amount | Details |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`
  );
  for (const d of report.discrepancies) {
    lines.push(
      `| ${cell(d.severity)} | ${cell(d.type)} | ${cell(d.kind)} | \`${d.txHash}\` | ${cell(d.ledgerSeq)} | ${cell(d.timestamp)} | ${cell(d.leagueId ?? d.contractLeagueId)} | ${cell(d.dbAmount ?? d.dbCount)} | ${cell(d.onChainAmount ?? d.onChainCount)} | ${cell(d.message)} |`
    );
  }
  return lines.join("\n") + "\n";
}

export const ledgerReconciliationService = new LedgerReconciliationService();
