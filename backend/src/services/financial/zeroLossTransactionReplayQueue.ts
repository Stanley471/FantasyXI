import { eventBus } from "../events/eventBus.js";
import { parseSorobanError } from "./sorobanErrorRecovery.js";

export type ReplayTransactionState =
  | "SUBMITTING"
  | "PENDING_VERIFICATION"
  | "SUCCESS"
  | "DROPPED"
  | "FAILED";

export interface StateTransitionEntry {
  from: ReplayTransactionState | null;
  to: ReplayTransactionState;
  at: string;
  reason: string;
  txHash: string;
  sequenceNumber: string;
  pollAttempt: number;
}

export interface ZeroLossTrackedTransaction {
  id: string;
  idempotencyKey: string;
  ledgerRecordId?: string;
  txHash: string;
  historicalTxHashes: string[];
  sourceAccount: string;
  sequenceNumber: string;
  status: ReplayTransactionState;
  pollAttempts: number;
  consecutiveNotFoundCount: number;
  resubmissionCount: number;
  submittedAt: Date;
  lastPolledAt?: Date;
  nextPollAt: Date;
  confirmedAt?: Date;
  confirmedLedger?: number;
  lastError?: string;
  transitions: StateTransitionEntry[];
  payload: Record<string, unknown>;
}

export interface SorobanRpcGetTransactionResponse {
  status: "SUCCESS" | "PENDING" | "NOT_FOUND" | "FAILED";
  ledger?: number;
  resultXdr?: string;
  error?: string;
}

export interface ZeroLossSorobanRpcEndpoint {
  sendTransaction?(envelopeInfo: {
    id: string;
    txHash: string;
    sourceAccount: string;
    sequenceNumber: string;
    payload: Record<string, unknown>;
  }): Promise<{
    status: "PENDING" | "SUCCESS" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
    txHash?: string;
    ledger?: number;
    error?: string;
  }>;
  getTransaction(txHash: string): Promise<SorobanRpcGetTransactionResponse>;
}

export interface ZeroLossResubmitter {
  rebuildAndSubmit(params: {
    tx: ZeroLossTrackedTransaction;
    nextSequenceNumber: string;
  }): Promise<{
    txHash: string;
    sequenceNumber: string;
    status?: "PENDING" | "SUCCESS";
    ledger?: number;
  }>;
}

export interface ZeroLossLedgerDbAdapter {
  markTransactionPendingVerification?(params: {
    ledgerRecordId: string;
    txHash: string;
    sequenceNumber: string;
  }): Promise<void>;
  markTransactionSuccess(params: {
    ledgerRecordId: string;
    txHash: string;
    sequenceNumber: string;
    ledgerSeq?: number;
    confirmedAt: Date;
  }): Promise<void>;
  markTransactionFailed?(params: {
    ledgerRecordId: string;
    txHash: string;
    reason: string;
  }): Promise<void>;
}

export interface ZeroLossReplayQueueOptions {
  rpc: ZeroLossSorobanRpcEndpoint;
  resubmitter?: ZeroLossResubmitter;
  dbAdapter?: ZeroLossLedgerDbAdapter;
  basePollDelayMs?: number;
  maxPollDelayMs?: number;
  backoffFactor?: number;
  /** Number of consecutive NOT_FOUND polls required before declaring a tx DROPPED. */
  notFoundDropThreshold?: number;
  maxResubmissions?: number;
  maxPollAttempts?: number;
  clock?: () => Date;
}

function isNetworkOrGatewayTimeout(error: unknown): boolean {
  const parsed = parseSorobanError(error);
  if (parsed.isRetryable) return true;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("504") ||
    msg.includes("gateway timeout") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("provisional")
  );
}

/**
 * Zero-Loss Transaction Replay Queue & Confirmation Daemon (#344).
 *
 * Guarantees that Soroban transactions experiencing HTTP 504 gateway timeouts
 * or provisional RPC errors transition to `PENDING_VERIFICATION`, are polled
 * with exponential backoff until ledger inclusion (`SUCCESS`), and if verified
 * as dropped from the mempool (`DROPPED`), are safely re-submitted with
 * collision-free incremented sequence numbers.
 */
export class ZeroLossTransactionReplayQueue {
  private readonly store = new Map<string, ZeroLossTrackedTransaction>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly accountHighestSequence = new Map<string, bigint>();
  private readonly recordLocks = new Set<string>();

  private readonly rpc: ZeroLossSorobanRpcEndpoint;
  private readonly resubmitter?: ZeroLossResubmitter;
  private readonly dbAdapter?: ZeroLossLedgerDbAdapter;
  private readonly basePollDelayMs: number;
  private readonly maxPollDelayMs: number;
  private readonly backoffFactor: number;
  private readonly notFoundDropThreshold: number;
  private readonly maxResubmissions: number;
  private readonly maxPollAttempts: number;
  private readonly clock: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ZeroLossReplayQueueOptions) {
    this.rpc = options.rpc;
    this.resubmitter = options.resubmitter;
    this.dbAdapter = options.dbAdapter;
    this.basePollDelayMs = options.basePollDelayMs ?? 500;
    this.maxPollDelayMs = options.maxPollDelayMs ?? 16_000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.notFoundDropThreshold = options.notFoundDropThreshold ?? 2;
    this.maxResubmissions = options.maxResubmissions ?? 3;
    this.maxPollAttempts = options.maxPollAttempts ?? 12;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Computes exponential polling delay for a given 1-based attempt number.
   */
  public computeBackoffDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const delay = this.basePollDelayMs * Math.pow(this.backoffFactor, exponent);
    return Math.min(delay, this.maxPollDelayMs);
  }

  /**
   * Allocates the next collision-free sequence number for a source account.
   */
  public allocateNextSequenceNumber(
    sourceAccount: string,
    currentSequenceNumber: string
  ): string {
    const currentBig = BigInt(currentSequenceNumber);
    const highestTracked = this.accountHighestSequence.get(sourceAccount) ?? currentBig;
    const base = highestTracked > currentBig ? highestTracked : currentBig;
    const nextSeq = base + 1n;
    this.accountHighestSequence.set(sourceAccount, nextSeq);
    return nextSeq.toString();
  }

  private recordAccountSequence(sourceAccount: string, sequenceNumber: string): void {
    const seqBig = BigInt(sequenceNumber);
    const existing = this.accountHighestSequence.get(sourceAccount);
    if (existing === undefined || seqBig > existing) {
      this.accountHighestSequence.set(sourceAccount, seqBig);
    }
  }

  private transition(
    tx: ZeroLossTrackedTransaction,
    nextState: ReplayTransactionState,
    reason: string
  ): void {
    const prev = tx.status;
    tx.status = nextState;
    tx.transitions.push({
      from: prev,
      to: nextState,
      at: this.clock().toISOString(),
      reason,
      txHash: tx.txHash,
      sequenceNumber: tx.sequenceNumber,
      pollAttempt: tx.pollAttempts,
    });
  }

  /**
   * Submits a Soroban transaction with zero-loss timeout recovery.
   * If RPC times out (e.g., 504 Gateway Timeout) or returns PENDING/TRY_AGAIN_LATER,
   * transitions the transaction to `PENDING_VERIFICATION` for exponential polling.
   */
  public async submitTransaction(params: {
    id: string;
    idempotencyKey: string;
    ledgerRecordId?: string;
    txHash: string;
    sourceAccount: string;
    sequenceNumber: string;
    payload?: Record<string, unknown>;
  }): Promise<ZeroLossTrackedTransaction> {
    const existingId = this.idempotencyIndex.get(params.idempotencyKey);
    if (existingId) {
      const existing = this.store.get(existingId);
      if (existing) return existing;
    }

    const now = this.clock();
    this.recordAccountSequence(params.sourceAccount, params.sequenceNumber);

    const tracked: ZeroLossTrackedTransaction = {
      id: params.id,
      idempotencyKey: params.idempotencyKey,
      ledgerRecordId: params.ledgerRecordId,
      txHash: params.txHash,
      historicalTxHashes: [params.txHash],
      sourceAccount: params.sourceAccount,
      sequenceNumber: params.sequenceNumber,
      status: "SUBMITTING",
      pollAttempts: 0,
      consecutiveNotFoundCount: 0,
      resubmissionCount: 0,
      submittedAt: now,
      nextPollAt: now,
      transitions: [
        {
          from: null,
          to: "SUBMITTING",
          at: now.toISOString(),
          reason: "Initial transaction submission started",
          txHash: params.txHash,
          sequenceNumber: params.sequenceNumber,
          pollAttempt: 0,
        },
      ],
      payload: params.payload ?? {},
    };

    this.store.set(tracked.id, tracked);
    this.idempotencyIndex.set(tracked.idempotencyKey, tracked.id);

    if (!this.rpc.sendTransaction) {
      this.transition(
        tracked,
        "PENDING_VERIFICATION",
        "Registered directly for verification polling"
      );
      tracked.nextPollAt = new Date(
        now.getTime() + this.computeBackoffDelayMs(1)
      );
      if (tracked.ledgerRecordId && this.dbAdapter?.markTransactionPendingVerification) {
        await this.dbAdapter.markTransactionPendingVerification({
          ledgerRecordId: tracked.ledgerRecordId,
          txHash: tracked.txHash,
          sequenceNumber: tracked.sequenceNumber,
        });
      }
      return tracked;
    }

    try {
      const sendResult = await this.rpc.sendTransaction({
        id: tracked.id,
        txHash: tracked.txHash,
        sourceAccount: tracked.sourceAccount,
        sequenceNumber: tracked.sequenceNumber,
        payload: tracked.payload,
      });

      if (sendResult.txHash && sendResult.txHash !== tracked.txHash) {
        tracked.txHash = sendResult.txHash;
        if (!tracked.historicalTxHashes.includes(sendResult.txHash)) {
          tracked.historicalTxHashes.push(sendResult.txHash);
        }
      }

      if (sendResult.status === "SUCCESS") {
        await this.finalizeSuccess(
          tracked,
          tracked.txHash,
          sendResult.ledger,
          "Immediate RPC submission confirmation"
        );
        return tracked;
      }

      if (
        sendResult.status === "PENDING" ||
        sendResult.status === "DUPLICATE" ||
        sendResult.status === "TRY_AGAIN_LATER"
      ) {
        this.transition(
          tracked,
          "PENDING_VERIFICATION",
          `RPC sendTransaction returned ${sendResult.status}`
        );
        tracked.nextPollAt = new Date(
          this.clock().getTime() + this.computeBackoffDelayMs(1)
        );
        if (
          tracked.ledgerRecordId &&
          this.dbAdapter?.markTransactionPendingVerification
        ) {
          await this.dbAdapter.markTransactionPendingVerification({
            ledgerRecordId: tracked.ledgerRecordId,
            txHash: tracked.txHash,
            sequenceNumber: tracked.sequenceNumber,
          });
        }
        return tracked;
      }

      // Deterministic non-timeout rejection
      this.transition(
        tracked,
        "FAILED",
        sendResult.error || "Transaction rejected by Soroban RPC"
      );
      if (tracked.ledgerRecordId && this.dbAdapter?.markTransactionFailed) {
        await this.dbAdapter.markTransactionFailed({
          ledgerRecordId: tracked.ledgerRecordId,
          txHash: tracked.txHash,
          reason: sendResult.error || "Transaction rejected",
        });
      }
      return tracked;
    } catch (error) {
      if (isNetworkOrGatewayTimeout(error)) {
        const errMsg = error instanceof Error ? error.message : String(error);
        tracked.lastError = errMsg;
        this.transition(
          tracked,
          "PENDING_VERIFICATION",
          `Network timeout during submission (${errMsg}); queued for verification`
        );
        tracked.nextPollAt = new Date(
          this.clock().getTime() + this.computeBackoffDelayMs(1)
        );
        if (
          tracked.ledgerRecordId &&
          this.dbAdapter?.markTransactionPendingVerification
        ) {
          await this.dbAdapter.markTransactionPendingVerification({
            ledgerRecordId: tracked.ledgerRecordId,
            txHash: tracked.txHash,
            sequenceNumber: tracked.sequenceNumber,
          });
        }
        return tracked;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      tracked.lastError = errMsg;
      this.transition(tracked, "FAILED", `Unrecoverable submission error: ${errMsg}`);
      if (tracked.ledgerRecordId && this.dbAdapter?.markTransactionFailed) {
        await this.dbAdapter.markTransactionFailed({
          ledgerRecordId: tracked.ledgerRecordId,
          txHash: tracked.txHash,
          reason: errMsg,
        });
      }
      throw error;
    }
  }

  private async finalizeSuccess(
    tx: ZeroLossTrackedTransaction,
    confirmedHash: string,
    ledgerSeq: number | undefined,
    reason: string
  ): Promise<void> {
    const now = this.clock();
    tx.txHash = confirmedHash;
    tx.confirmedAt = now;
    tx.confirmedLedger = ledgerSeq;
    tx.consecutiveNotFoundCount = 0;
    this.transition(tx, "SUCCESS", reason);

    if (tx.ledgerRecordId && this.dbAdapter) {
      await this.dbAdapter.markTransactionSuccess({
        ledgerRecordId: tx.ledgerRecordId,
        txHash: confirmedHash,
        sequenceNumber: tx.sequenceNumber,
        ledgerSeq,
        confirmedAt: now,
      });
    }

    eventBus.publish("TRANSACTION_CONFIRMED", {
      txId: tx.id,
      idempotencyKey: tx.idempotencyKey,
      txHash: confirmedHash,
      sequenceNumber: tx.sequenceNumber,
      ledger: ledgerSeq,
      confirmedAt: now.toISOString(),
    });
  }

  /**
   * Executes a single polling pass over all `PENDING_VERIFICATION` transactions
   * whose exponential backoff window has elapsed.
   * Uses per-record isolation locks so concurrent pollers cannot double-mutate state.
   */
  public async pollOnce(nowOverride?: Date): Promise<{
    confirmed: string[];
    replayed: string[];
    stillPending: string[];
    failed: string[];
  }> {
    const now = nowOverride ?? this.clock();
    const confirmed: string[] = [];
    const replayed: string[] = [];
    const stillPending: string[] = [];
    const failed: string[] = [];

    const dueTransactions = Array.from(this.store.values()).filter(
      (tx) =>
        tx.status === "PENDING_VERIFICATION" &&
        tx.nextPollAt.getTime() <= now.getTime()
    );

    for (const tx of dueTransactions) {
      if (this.recordLocks.has(tx.id)) {
        stillPending.push(tx.id);
        continue;
      }

      this.recordLocks.add(tx.id);
      try {
        tx.pollAttempts += 1;
        tx.lastPolledAt = now;

        // Check all historical hashes (in case an earlier timed-out hash actually landed on-chain!)
        let matchedSuccess: { hash: string; ledger?: number } | null = null;
        let sawPending = false;
        let sawDeterministicFailure: string | null = null;

        for (const candidateHash of [...tx.historicalTxHashes].reverse()) {
          try {
            const rpcRes = await this.rpc.getTransaction(candidateHash);
            if (rpcRes.status === "SUCCESS") {
              matchedSuccess = { hash: candidateHash, ledger: rpcRes.ledger };
              break;
            }
            if (rpcRes.status === "PENDING") {
              sawPending = true;
            } else if (rpcRes.status === "FAILED") {
              sawDeterministicFailure =
                rpcRes.error || `Transaction ${candidateHash} failed on-chain`;
            }
          } catch (pollErr) {
            // Transient RPC error during polling must NOT mark pending tx failed
            if (isNetworkOrGatewayTimeout(pollErr)) {
              sawPending = true;
            } else {
              throw pollErr;
            }
          }
        }

        if (matchedSuccess) {
          await this.finalizeSuccess(
            tx,
            matchedSuccess.hash,
            matchedSuccess.ledger,
            `Confirmed on-chain at ledger ${matchedSuccess.ledger ?? "unknown"}`
          );
          confirmed.push(tx.id);
          continue;
        }

        if (sawPending) {
          tx.consecutiveNotFoundCount = 0;
          const delayMs = this.computeBackoffDelayMs(tx.pollAttempts + 1);
          tx.nextPollAt = new Date(now.getTime() + delayMs);
          stillPending.push(tx.id);
          continue;
        }

        if (sawDeterministicFailure && tx.historicalTxHashes.length === 1) {
          this.transition(tx, "FAILED", sawDeterministicFailure);
          if (tx.ledgerRecordId && this.dbAdapter?.markTransactionFailed) {
            await this.dbAdapter.markTransactionFailed({
              ledgerRecordId: tx.ledgerRecordId,
              txHash: tx.txHash,
              reason: sawDeterministicFailure,
            });
          }
          failed.push(tx.id);
          continue;
        }

        // All hashes returned NOT_FOUND
        tx.consecutiveNotFoundCount += 1;

        if (tx.consecutiveNotFoundCount >= this.notFoundDropThreshold) {
          this.transition(
            tx,
            "DROPPED",
            `Transaction not found after ${tx.consecutiveNotFoundCount} verification polls`
          );

          if (this.resubmitter && tx.resubmissionCount < this.maxResubmissions) {
            const nextSequenceNumber = this.allocateNextSequenceNumber(
              tx.sourceAccount,
              tx.sequenceNumber
            );
            tx.resubmissionCount += 1;
            const rebuilt = await this.resubmitter.rebuildAndSubmit({
              tx,
              nextSequenceNumber,
            });

            tx.txHash = rebuilt.txHash;
            tx.sequenceNumber = rebuilt.sequenceNumber;
            this.recordAccountSequence(tx.sourceAccount, rebuilt.sequenceNumber);
            if (!tx.historicalTxHashes.includes(rebuilt.txHash)) {
              tx.historicalTxHashes.push(rebuilt.txHash);
            }
            tx.consecutiveNotFoundCount = 0;

            if (rebuilt.status === "SUCCESS") {
              await this.finalizeSuccess(
                tx,
                rebuilt.txHash,
                rebuilt.ledger,
                `Confirmed immediately on replay #${tx.resubmissionCount}`
              );
              confirmed.push(tx.id);
              continue;
            }

            this.transition(
              tx,
              "PENDING_VERIFICATION",
              `Re-submitted dropped transaction (attempt #${tx.resubmissionCount}) with sequence ${rebuilt.sequenceNumber}`
            );
            tx.nextPollAt = new Date(
              now.getTime() + this.computeBackoffDelayMs(1)
            );
            replayed.push(tx.id);

            eventBus.publish("TRANSACTION_REPLAYED", {
              txId: tx.id,
              idempotencyKey: tx.idempotencyKey,
              newTxHash: rebuilt.txHash,
              newSequenceNumber: rebuilt.sequenceNumber,
              resubmissionCount: tx.resubmissionCount,
            });
            continue;
          }

          this.transition(
            tx,
            "FAILED",
            "Transaction dropped and max resubmissions reached or no resubmitter configured"
          );
          if (tx.ledgerRecordId && this.dbAdapter?.markTransactionFailed) {
            await this.dbAdapter.markTransactionFailed({
              ledgerRecordId: tx.ledgerRecordId,
              txHash: tx.txHash,
              reason: "Transaction dropped after max resubmissions",
            });
          }
          failed.push(tx.id);
          continue;
        }

        if (tx.pollAttempts >= this.maxPollAttempts) {
          this.transition(
            tx,
            "FAILED",
            `Exceeded maximum verification poll attempts (${this.maxPollAttempts})`
          );
          failed.push(tx.id);
          continue;
        }

        const nextDelay = this.computeBackoffDelayMs(tx.pollAttempts + 1);
        tx.nextPollAt = new Date(now.getTime() + nextDelay);
        stillPending.push(tx.id);
      } finally {
        this.recordLocks.delete(tx.id);
      }
    }

    return { confirmed, replayed, stillPending, failed };
  }

  public getTransaction(id: string): ZeroLossTrackedTransaction | undefined {
    return this.store.get(id);
  }

  public getAllTransactions(): ZeroLossTrackedTransaction[] {
    return Array.from(this.store.values());
  }

  public start(intervalMs: number = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) => {
        console.error("[ZeroLossTransactionReplayQueue] Poll error:", err);
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
}
