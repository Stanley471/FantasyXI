/**
 * Automated Stellar Fee-Bump Service (SEP-0015 / Issue #363)
 *
 * Monitors pending platform transactions (gameweek settlements, refunds, league
 * escrow operations) and automatically submits Stellar Fee-Bump transactions
 * (`TransactionBuilder.buildFeeBumpTransaction`) when network surge pricing
 * leaves initial fee bids stuck in the mempool:
 *
 * 1. Mempool Monitor:
 *    - Detects pending transactions exceeding `stuckThresholdMs` or approaching
 *      their ledger timebounds expiration (`approachingTimeoutMs`).
 *    - Enforces platform scope: only sponsors transactions tied to registered
 *      platform leagues (`leagueId`), rejecting arbitrary external user txs.
 *
 * 2. Dynamic Fee Calculation with Strict Safety Caps:
 *    - Escalates per-operation and total fees using exponential step multipliers
 *      combined with live network surge fee statistics (`p90` / `p95`).
 *    - Strictly enforces `maxFeeStroopsPerTx`, `maxBumpAttempts`, and sponsorship
 *      reserve balance floors (`minSponsorBalanceStroops`) so surge events can
 *      never drain platform sponsorship reserves.
 *
 * 3. Internal Accounting & Financial Audit Trail:
 *    - Records every bumped fee (`previousFeeStroops`, `bumpedFeeStroops`,
 *      `incrementalFeeStroops`, `sponsorPublicKey`, `innerTxHash`, `feeBumpTxHash`,
 *      `leagueId`) in internal accounting records and `FinancialAuditLog`.
 */

import { EventEmitter } from "node:events";
import {
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  LocalSecretTransactionSigner,
  type StellarTransactionSigner,
} from "./transactionSigner.js";
import type {
  FinancialAuditEntryInput,
  FinancialAuditRecorder,
} from "../audit/financialAuditLog.js";

const SYSTEM_ACTOR = "system";
const FEE_COLLECTED_ACTION = "FEE_COLLECTED" as FinancialAuditEntryInput["action"];

const defaultAuditRecorder: FinancialAuditRecorder = {
  record(entry: FinancialAuditEntryInput): void {
    void import("../audit/financialAuditLog.js")
      .then((m) => m.financialAuditLog.record(entry))
      .catch(() => {
        // Ignore when running in unit-test environments without Prisma client
      });
  },
};

export type FeeBumpStatus =
  | "PENDING"
  | "BUMPED"
  | "CONFIRMED"
  | "FAILED"
  | "CAPPED";

export interface TrackedPendingTransaction {
  innerTxHash: string;
  latestTxHash: string;
  envelopeXdr: string;
  leagueId: string;
  kind: "SETTLEMENT" | "REFUND" | "ESCROW_DEPOSIT" | string;
  initialFeeStroops: number;
  currentTotalFeeStroops: number;
  currentPerOpFeeStroops: number;
  operationCount: number;
  submittedAt: Date;
  timeoutAt: Date | null;
  bumpCount: number;
  feeBumpHashes: string[];
  status: FeeBumpStatus;
  lastBumpedAt: Date | null;
  lastError: string | null;
}

export interface RegisterPendingTxInput {
  envelopeXdr: string;
  leagueId: string;
  kind?: "SETTLEMENT" | "REFUND" | "ESCROW_DEPOSIT" | string;
  submittedAt?: Date;
  timeoutAt?: Date | null;
}

export interface NetworkFeeStats {
  baseFeeStroops: number;
  p90FeeStroops: number;
  p95FeeStroops: number;
  p99FeeStroops: number;
}

export interface FeeBumpRpcPort {
  getTransactionStatus(txHash: string): Promise<{
    status: "NOT_FOUND" | "PENDING" | "SUCCESS" | "FAILED";
    ledger?: number;
  }>;
  sendFeeBumpTransaction(feeBumpTx: FeeBumpTransaction): Promise<{
    hash: string;
    status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
    error?: string;
  }>;
  getFeeStats?(): Promise<NetworkFeeStats>;
  getSponsorBalanceStroops?(sponsorPublicKey: string): Promise<bigint>;
}

export interface FeeBumpAccountingEntry {
  id: string;
  innerTxHash: string;
  feeBumpTxHash: string;
  leagueId: string;
  kind: string;
  sponsorPublicKey: string;
  previousTotalFeeStroops: number;
  bumpedTotalFeeStroops: number;
  bumpedPerOpFeeStroops: number;
  incrementalFeeStroops: number;
  bumpAttempt: number;
  networkSurgeP95Stroops: number;
  createdAt: Date;
}

export interface LeagueFeeAccountingSummary {
  leagueId: string;
  totalBumpCount: number;
  totalBumpedFeeStroops: number;
  totalIncrementalFeeStroops: number;
  entries: FeeBumpAccountingEntry[];
}

export interface FeeBumpCycleSummary {
  scanned: number;
  confirmed: number;
  bumped: number;
  capped: number;
  failed: number;
}

export class UnauthorizedFeeSponsorshipError extends Error {
  public readonly code = "UNAUTHORIZED_FEE_SPONSORSHIP";

  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedFeeSponsorshipError";
  }
}

export class FeeCapExceededError extends Error {
  public readonly code = "FEE_CAP_EXCEEDED";

  constructor(message: string) {
    super(message);
    this.name = "FeeCapExceededError";
  }
}

export class SponsorshipReserveExhaustedError extends Error {
  public readonly code = "SPONSORSHIP_RESERVE_EXHAUSTED";

  constructor(message: string) {
    super(message);
    this.name = "SponsorshipReserveExhaustedError";
  }
}

export interface AutomatedFeeBumpServiceOptions {
  /** Secret key or KMS key reference for the dedicated fee-sponsorship account */
  sponsorKeyReference: string;
  /** Optional explicit public key for the sponsorship account */
  sponsorPublicKey?: string;
  networkPassphrase?: string;
  signer?: StellarTransactionSigner;
  rpc: FeeBumpRpcPort;
  audit?: FinancialAuditRecorder;
  /** Optional set or validator of allowed platform league IDs */
  isAllowedLeague?: (leagueId: string) => boolean | Promise<boolean>;
  /** Time in ms after submission before an unconfirmed tx is considered stuck (default: 15,000ms) */
  stuckThresholdMs?: number;
  /** Time in ms before tx timebounds expiry that triggers an urgent fee bump (default: 10,000ms) */
  approachingTimeoutThresholdMs?: number;
  /** Escalation multiplier per bump attempt (default: 2.0) */
  escalationMultiplier?: number;
  /** Maximum total fee in stroops allowed for any single fee-bump transaction (default: 1,000,000 stroops = 0.1 XLM) */
  maxFeeStroopsPerTx?: number;
  /** Maximum number of fee-bump attempts per inner transaction (default: 3) */
  maxBumpAttempts?: number;
  /** Minimum XLM balance in stroops that must remain in the sponsorship account (default: 20,000,000 stroops = 2 XLM) */
  minSponsorReserveStroops?: bigint;
  /** Maximum cumulative stroops the service may sponsor across its budget window (default: 100,000,000 stroops = 10 XLM) */
  maxTotalSponsoredBudgetStroops?: bigint;
  /** Poll interval in ms when running as background monitor (default: 5,000ms) */
  pollIntervalMs?: number;
  now?: () => Date;
  emitter?: EventEmitter;
}

export class AutomatedFeeBumpService {
  private readonly sponsorKeyReference: string;
  private readonly explicitSponsorPublicKey?: string;
  private readonly networkPassphrase: string;
  private readonly signer: StellarTransactionSigner;
  private readonly rpc: FeeBumpRpcPort;
  private readonly audit: FinancialAuditRecorder;
  private readonly isAllowedLeague: (leagueId: string) => boolean | Promise<boolean>;
  private readonly stuckThresholdMs: number;
  private readonly approachingTimeoutThresholdMs: number;
  private readonly escalationMultiplier: number;
  private readonly maxFeeStroopsPerTx: number;
  private readonly maxBumpAttempts: number;
  private readonly minSponsorReserveStroops: bigint;
  private readonly maxTotalSponsoredBudgetStroops: bigint;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  public readonly events: EventEmitter;

  private readonly pendingTxs = new Map<string, TrackedPendingTransaction>();
  private readonly accountingLedger: FeeBumpAccountingEntry[] = [];
  private totalSponsoredStroops = 0n;
  private entrySeq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: AutomatedFeeBumpServiceOptions) {
    if (!options.sponsorKeyReference) {
      throw new Error("sponsorKeyReference is required for AutomatedFeeBumpService");
    }
    this.sponsorKeyReference = options.sponsorKeyReference;
    this.explicitSponsorPublicKey = options.sponsorPublicKey;
    this.networkPassphrase =
      options.networkPassphrase ||
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      Networks.TESTNET;
    this.signer = options.signer ?? new LocalSecretTransactionSigner();
    this.rpc = options.rpc;
    this.audit = options.audit ?? defaultAuditRecorder;
    this.isAllowedLeague =
      options.isAllowedLeague ??
      ((leagueId: string) => typeof leagueId === "string" && leagueId.trim().length > 0);
    this.stuckThresholdMs = options.stuckThresholdMs ?? 15_000;
    this.approachingTimeoutThresholdMs = options.approachingTimeoutThresholdMs ?? 10_000;
    this.escalationMultiplier = options.escalationMultiplier ?? 2.0;
    this.maxFeeStroopsPerTx = options.maxFeeStroopsPerTx ?? 1_000_000; // 0.1 XLM
    this.maxBumpAttempts = options.maxBumpAttempts ?? 3;
    this.minSponsorReserveStroops = options.minSponsorReserveStroops ?? 20_000_000n; // 2 XLM
    this.maxTotalSponsoredBudgetStroops =
      options.maxTotalSponsoredBudgetStroops ?? 100_000_000n; // 10 XLM
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
    this.events = options.emitter ?? new EventEmitter();
  }

  public async getSponsorPublicKey(): Promise<string> {
    if (this.explicitSponsorPublicKey) {
      return this.explicitSponsorPublicKey;
    }
    return this.signer.publicKey(this.sponsorKeyReference);
  }

  /**
   * Registers a signed inner Stellar transaction for mempool monitoring and
   * automatic fee-bumping. Rejects non-platform transactions outside leagues.
   */
  public async registerPendingTransaction(
    input: RegisterPendingTxInput
  ): Promise<TrackedPendingTransaction> {
    const leagueId = (input.leagueId ?? "").trim();
    if (!leagueId || !(await this.isAllowedLeague(leagueId))) {
      throw new UnauthorizedFeeSponsorshipError(
        `Refusing to sponsor transaction outside authorized platform leagues (leagueId="${leagueId}")`
      );
    }

    const parsed = TransactionBuilder.fromXDR(
      input.envelopeXdr,
      this.networkPassphrase
    );
    if (parsed instanceof FeeBumpTransaction) {
      throw new UnauthorizedFeeSponsorshipError(
        "Inner transaction must be a standard Stellar Transaction, not an already-wrapped FeeBumpTransaction"
      );
    }

    const innerTx = parsed as Transaction;
    const innerTxHash = Buffer.from(innerTx.hash()).toString("hex");
    const initialFeeStroops = Number(innerTx.fee);
    const operationCount = Math.max(1, innerTx.operations.length);
    const currentPerOpFeeStroops = Math.ceil(initialFeeStroops / operationCount);

    let timeoutAt = input.timeoutAt ?? null;
    if (!timeoutAt && innerTx.timeBounds?.maxTime && Number(innerTx.timeBounds.maxTime) > 0) {
      timeoutAt = new Date(Number(innerTx.timeBounds.maxTime) * 1000);
    }

    const record: TrackedPendingTransaction = {
      innerTxHash,
      latestTxHash: innerTxHash,
      envelopeXdr: input.envelopeXdr,
      leagueId,
      kind: input.kind ?? "SETTLEMENT",
      initialFeeStroops,
      currentTotalFeeStroops: initialFeeStroops,
      currentPerOpFeeStroops,
      operationCount,
      submittedAt: input.submittedAt ?? this.now(),
      timeoutAt,
      bumpCount: 0,
      feeBumpHashes: [],
      status: "PENDING",
      lastBumpedAt: null,
      lastError: null,
    };

    this.pendingTxs.set(innerTxHash, record);
    return { ...record, feeBumpHashes: [...record.feeBumpHashes] };
  }

  /**
   * Computes the next per-operation and total fee (in stroops) for a stuck transaction,
   * incorporating network surge stats and strictly enforcing `maxFeeStroopsPerTx`.
   *
   * Note: Stellar `TransactionBuilder.buildFeeBumpTransaction` takes a per-operation
   * fee in stroops and multiplies it by `(innerTx.operations.length + 1)` to set the
   * outer FeeBumpTransaction's total fee.
   */
  public calculateNextBumpFee(
    tx: TrackedPendingTransaction,
    feeStats?: NetworkFeeStats
  ): { perOpFeeStroops: number; totalFeeStroops: number; clampedToCap: boolean } {
    const outerOpCount = tx.operationCount + 1;
    const maxPerOpCap = Math.floor(this.maxFeeStroopsPerTx / outerOpCount);

    if (tx.currentTotalFeeStroops >= this.maxFeeStroopsPerTx || tx.currentPerOpFeeStroops >= maxPerOpCap) {
      throw new FeeCapExceededError(
        `Transaction ${tx.innerTxHash} has already reached maximum fee cap (${this.maxFeeStroopsPerTx} stroops)`
      );
    }

    const nextAttempt = tx.bumpCount + 1;
    const escalatedPerOp = Math.ceil(
      tx.currentPerOpFeeStroops * Math.pow(this.escalationMultiplier, nextAttempt)
    );
    const surgePerOp = feeStats
      ? Math.max(feeStats.p95FeeStroops, feeStats.p90FeeStroops, Number(BASE_FEE))
      : Number(BASE_FEE);

    // SEP-0015 requires outer per-op fee > inner per-op fee
    const minRequiredPerOp = Math.max(
      Number(BASE_FEE),
      tx.currentPerOpFeeStroops + 1
    );

    const unclampedPerOp = Math.max(minRequiredPerOp, escalatedPerOp, surgePerOp);
    const clampedToCap = unclampedPerOp >= maxPerOpCap;
    const perOpFeeStroops = Math.min(unclampedPerOp, maxPerOpCap);

    if (perOpFeeStroops <= tx.currentPerOpFeeStroops) {
      throw new FeeCapExceededError(
        `Calculated per-op fee (${perOpFeeStroops}) cannot exceed current per-op fee (${tx.currentPerOpFeeStroops}) within cap (${this.maxFeeStroopsPerTx} stroops)`
      );
    }

    const totalFeeStroops = perOpFeeStroops * outerOpCount;
    return { perOpFeeStroops, totalFeeStroops, clampedToCap };
  }

  /**
   * Evaluates whether a tracked pending transaction is stuck in the mempool or
   * approaching its timebounds expiration.
   */
  public isTransactionStuck(tx: TrackedPendingTransaction, nowDate: Date = this.now()): boolean {
    if (tx.status !== "PENDING" && tx.status !== "BUMPED") {
      return false;
    }

    const referenceTime = tx.lastBumpedAt ?? tx.submittedAt;
    const elapsedMs = nowDate.getTime() - referenceTime.getTime();
    if (elapsedMs >= this.stuckThresholdMs) {
      return true;
    }

    if (tx.timeoutAt) {
      const remainingToTimeoutMs = tx.timeoutAt.getTime() - nowDate.getTime();
      if (
        remainingToTimeoutMs > 0 &&
        remainingToTimeoutMs <= this.approachingTimeoutThresholdMs
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Builds, signs, and submits a SEP-0015 FeeBumpTransaction for a tracked transaction,
   * enforcing reserve & cap guards and recording internal accounting entries.
   */
  public async bumpTransactionFee(
    innerTxHash: string
  ): Promise<FeeBumpAccountingEntry> {
    const tx = this.pendingTxs.get(innerTxHash);
    if (!tx) {
      throw new Error(`Pending transaction ${innerTxHash} is not registered`);
    }

    if (tx.bumpCount >= this.maxBumpAttempts) {
      tx.status = "CAPPED";
      tx.lastError = `Reached maximum bump attempts (${this.maxBumpAttempts})`;
      throw new FeeCapExceededError(tx.lastError);
    }

    const feeStats = this.rpc.getFeeStats
      ? await this.rpc.getFeeStats()
      : undefined;

    let feeCalc: {
      perOpFeeStroops: number;
      totalFeeStroops: number;
      clampedToCap: boolean;
    };
    try {
      feeCalc = this.calculateNextBumpFee(tx, feeStats);
    } catch (err) {
      if (err instanceof FeeCapExceededError) {
        tx.status = "CAPPED";
        tx.lastError = err.message;
      }
      throw err;
    }

    const incrementalFeeStroops =
      feeCalc.totalFeeStroops -
      (tx.bumpCount === 0 ? 0 : tx.currentTotalFeeStroops);

    // Enforce cumulative sponsorship budget cap
    if (
      this.totalSponsoredStroops + BigInt(incrementalFeeStroops) >
      this.maxTotalSponsoredBudgetStroops
    ) {
      tx.status = "CAPPED";
      tx.lastError = `Sponsorship budget cap (${this.maxTotalSponsoredBudgetStroops} stroops) would be exceeded`;
      throw new SponsorshipReserveExhaustedError(tx.lastError);
    }

    const sponsorPublicKey = await this.getSponsorPublicKey();

    // Enforce sponsorship account reserve floor if balance query is provided
    if (this.rpc.getSponsorBalanceStroops) {
      const balanceStroops = await this.rpc.getSponsorBalanceStroops(sponsorPublicKey);
      if (
        balanceStroops - BigInt(feeCalc.totalFeeStroops) <
        this.minSponsorReserveStroops
      ) {
        tx.status = "CAPPED";
        tx.lastError = `Sponsor account balance (${balanceStroops} stroops) would fall below reserve floor (${this.minSponsorReserveStroops} stroops)`;
        this.events.emit("sponsor:low_reserve", {
          sponsorPublicKey,
          balanceStroops: balanceStroops.toString(),
          minReserveStroops: this.minSponsorReserveStroops.toString(),
        });
        throw new SponsorshipReserveExhaustedError(tx.lastError);
      }
    }

    const innerTx = TransactionBuilder.fromXDR(
      tx.envelopeXdr,
      this.networkPassphrase
    ) as Transaction;

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsorPublicKey,
      String(feeCalc.perOpFeeStroops),
      innerTx,
      this.networkPassphrase
    );

    await this.signer.sign(feeBumpTx, this.sponsorKeyReference);

    const sendRes = await this.rpc.sendFeeBumpTransaction(feeBumpTx);
    if (sendRes.status === "ERROR") {
      tx.lastError = sendRes.error ?? "Fee-bump submission rejected by network";
      throw new Error(tx.lastError);
    }

    const previousTotalFeeStroops = tx.currentTotalFeeStroops;
    const feeBumpHash = sendRes.hash || Buffer.from(feeBumpTx.hash()).toString("hex");
    const nowDate = this.now();

    tx.latestTxHash = feeBumpHash;
    tx.currentTotalFeeStroops = Number(feeBumpTx.fee);
    tx.currentPerOpFeeStroops = feeCalc.perOpFeeStroops;
    tx.bumpCount += 1;
    tx.feeBumpHashes.push(feeBumpHash);
    tx.status = "BUMPED";
    tx.lastBumpedAt = nowDate;
    tx.lastError = null;

    this.totalSponsoredStroops += BigInt(incrementalFeeStroops);

    const accountingEntry: FeeBumpAccountingEntry = {
      id: `feebump-${++this.entrySeq}`,
      innerTxHash: tx.innerTxHash,
      feeBumpTxHash: feeBumpHash,
      leagueId: tx.leagueId,
      kind: tx.kind,
      sponsorPublicKey,
      previousTotalFeeStroops,
      bumpedTotalFeeStroops: tx.currentTotalFeeStroops,
      bumpedPerOpFeeStroops: feeCalc.perOpFeeStroops,
      incrementalFeeStroops,
      bumpAttempt: tx.bumpCount,
      networkSurgeP95Stroops: feeStats?.p95FeeStroops ?? Number(BASE_FEE),
      createdAt: nowDate,
    };

    this.accountingLedger.push(accountingEntry);

    // Record in append-only FinancialAuditLog for permanent accounting reconciliation
    this.audit.record({
      action: FEE_COLLECTED_ACTION,
      actorId: SYSTEM_ACTOR,
      leagueId: tx.leagueId,
      amount: (tx.currentTotalFeeStroops / 1e7).toFixed(7),
      asset: "XLM",
      stellarTxHash: feeBumpHash,
      metadata: {
        type: "STELLAR_FEE_BUMP",
        innerTxHash: tx.innerTxHash,
        feeBumpTxHash: feeBumpHash,
        kind: tx.kind,
        sponsorPublicKey,
        previousTotalFeeStroops,
        bumpedTotalFeeStroops: tx.currentTotalFeeStroops,
        incrementalFeeStroops,
        bumpAttempt: tx.bumpCount,
      },
    });

    this.events.emit("tx:fee_bumped", accountingEntry);
    return accountingEntry;
  }

  /**
   * Scans all tracked pending transactions, updates confirmed/failed statuses,
   * and automatically fee-bumps any stuck transactions.
   */
  public async pollMempoolOnce(): Promise<FeeBumpCycleSummary> {
    const summary: FeeBumpCycleSummary = {
      scanned: 0,
      confirmed: 0,
      bumped: 0,
      capped: 0,
      failed: 0,
    };

    const nowDate = this.now();

    for (const tx of this.pendingTxs.values()) {
      if (tx.status !== "PENDING" && tx.status !== "BUMPED") {
        continue;
      }

      summary.scanned += 1;

      const statusRes = await this.rpc.getTransactionStatus(tx.latestTxHash);
      if (statusRes.status === "SUCCESS") {
        tx.status = "CONFIRMED";
        summary.confirmed += 1;
        this.events.emit("tx:confirmed", {
          innerTxHash: tx.innerTxHash,
          confirmedTxHash: tx.latestTxHash,
          ledger: statusRes.ledger,
          bumpCount: tx.bumpCount,
        });
        continue;
      }

      if (statusRes.status === "FAILED") {
        tx.status = "FAILED";
        summary.failed += 1;
        continue;
      }

      if (this.isTransactionStuck(tx, nowDate)) {
        try {
          await this.bumpTransactionFee(tx.innerTxHash);
          summary.bumped += 1;
        } catch (err) {
          if (
            err instanceof FeeCapExceededError ||
            err instanceof SponsorshipReserveExhaustedError
          ) {
            summary.capped += 1;
          } else {
            summary.failed += 1;
          }
        }
      }
    }

    return summary;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollMempoolOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getTrackedTransaction(
    innerTxHash: string
  ): TrackedPendingTransaction | undefined {
    const tx = this.pendingTxs.get(innerTxHash);
    return tx ? { ...tx, feeBumpHashes: [...tx.feeBumpHashes] } : undefined;
  }

  public getAccountingRecords(): FeeBumpAccountingEntry[] {
    return [...this.accountingLedger];
  }

  public getTotalSponsoredStroops(): bigint {
    return this.totalSponsoredStroops;
  }

  public getLeagueFeeSummary(leagueId: string): LeagueFeeAccountingSummary {
    const entries = this.accountingLedger.filter((e) => e.leagueId === leagueId);
    const totalIncrementalFeeStroops = entries.reduce(
      (sum, e) => sum + e.incrementalFeeStroops,
      0
    );
    const latestByTx = new Map<string, number>();
    for (const entry of entries) {
      latestByTx.set(entry.innerTxHash, entry.bumpedTotalFeeStroops);
    }
    const totalBumpedFeeStroops = Array.from(latestByTx.values()).reduce(
      (sum, fee) => sum + fee,
      0
    );

    return {
      leagueId,
      totalBumpCount: entries.length,
      totalBumpedFeeStroops,
      totalIncrementalFeeStroops,
      entries,
    };
  }
}

export { Keypair };
