/**
 * Distributed Lock-Free Payout Dead-Letter Reprocessing Worker
 *
 * Multiple worker instances compete to claim and process failed payouts
 * concurrently using database row-level locking (SELECT ... FOR UPDATE SKIP LOCKED).
 *
 * Key Design Decisions:
 * - No distributed mutexes or central coordination: Workers query the database
 *   directly and let PostgreSQL's row-level locking resolve conflicts.
 * - Exponential backoff with full jitter prevents thundering herd collisions when
 *   many retries become eligible at once.
 * - SKIP LOCKED allows workers to gracefully skip locked rows and move to the next,
 *   ensuring fair distribution and no worker pile-ups waiting for locks.
 * - Detailed audit trails record every attempt, decision, and state transition.
 *
 * USAGE:
 *   const worker = new PayoutDeadLetterWorker(deadLetterService, financialService);
 *   const result = await worker.processPendingPayouts(leagueId, transactionType);
 *   console.log(`Processed ${result.processed}, succeeded ${result.succeeded}, failed ${result.failed}`);
 */

import { PayoutDeadLetterService, MAX_AUTOMATIC_ATTEMPTS } from "./payoutDeadLetterService.js";
import { FinancialService } from "./financialService.js";
import { TransactionType } from "../../types/index.js";

export interface PayoutWorkerResult {
  /** Total entries processed in this cycle */
  processed: number;
  /** Entries successfully resolved */
  succeeded: number;
  /** Entries failed and re-queued for backoff */
  failed: number;
  /** Entries that exceeded max attempts and need manual review */
  maxAttemptsExceeded: number;
  /** Processing duration in milliseconds */
  durationMs: number;
  /** Any errors that occurred during processing */
  errors: Array<{ entryId: string; error: string }>;
}

export class PayoutDeadLetterWorker {
  constructor(
    private readonly deadLetterService: PayoutDeadLetterService,
    private readonly financialService: FinancialService
  ) {}

  /**
   * Processes a batch of pending payouts for a specific league.
   * This is the main worker entry point, safe for concurrent execution.
   *
   * Flow:
   * 1. Claim a batch of retry-eligible entries using lock-free SELECT FOR UPDATE SKIP LOCKED
   * 2. For each entry:
   *    a. Dispatch the payout (via FinancialService)
   *    b. If success: mark resolved
   *    c. If failure: re-classify error and schedule backoff retry
   * 3. Return detailed metrics for monitoring
   *
   * CONCURRENCY GUARANTEES:
   * - Multiple workers can call this simultaneously; each claims its own batch
   * - Workers process independently without coordination
   * - Failed entries are re-queued for future workers to retry
   */
  public async processPendingPayouts(
    leagueId: string,
    transactionType: TransactionType,
    startTime: Date = new Date()
  ): Promise<PayoutWorkerResult> {
    const result: PayoutWorkerResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      maxAttemptsExceeded: 0,
      durationMs: 0,
      errors: [],
    };

    try {
      // 1. Claim a lock-free batch of entries eligible for retry
      const batch = await this.deadLetterService.claimRetryBatchLockFree(
        leagueId,
        transactionType,
        startTime
      );

      result.processed = batch.length;

      // 2. Process each claimed entry
      for (const entry of batch) {
        try {
          // Check if entry has exceeded maximum automatic attempts
          if (entry.attempts >= MAX_AUTOMATIC_ATTEMPTS) {
            result.maxAttemptsExceeded++;
            console.warn(
              `[payout-worker] Entry ${entry.id} exceeded MAX_AUTOMATIC_ATTEMPTS (${entry.attempts}). ` +
                `Requires manual admin intervention.`
            );
            // Don't re-schedule; wait for admin action
            continue;
          }

          // Attempt to redispatch the payout
          // retryDeadLetteredPayout internally calls claimForRetry and marks resolved/failed
          const redispatchResult = await this.financialService.retryDeadLetteredPayout(
            entry.id,
            "payout-worker"
          );

          if (redispatchResult.success) {
            result.succeeded++;
            console.log(
              `[payout-worker] Entry ${entry.id} resolved successfully. ` +
                `Paid ${redispatchResult.paidMemberIds?.length || 0} members.`
            );
          } else {
            // Retry failed; schedule backoff for next worker to try
            const backoffState = await this.deadLetterService.scheduleRetryWithBackoff(
              entry.id,
              new Date()
            );
            result.failed++;
            console.warn(
              `[payout-worker] Entry ${entry.id} retry failed. ` +
                `Scheduled next attempt in ${backoffState.minDelayMs}-${backoffState.maxDelayMs}ms. ` +
                `Attempt ${backoffState.attemptNumber}/${MAX_AUTOMATIC_ATTEMPTS}.`
            );
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          result.errors.push({ entryId: entry.id, error: errorMsg });
          result.failed++;
          console.error(`[payout-worker] Error processing entry ${entry.id}: ${errorMsg}`);

          // Try to schedule backoff for the failed entry
          try {
            await this.deadLetterService.scheduleRetryWithBackoff(entry.id, new Date());
          } catch (scheduleErr) {
            console.error(`[payout-worker] Failed to schedule backoff for ${entry.id}: ${scheduleErr}`);
          }
        }
      }

      result.durationMs = Date.now() - startTime.getTime();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({ entryId: "batch-claim", error: errorMsg });
      console.error(`[payout-worker] Failed to claim batch: ${errorMsg}`);
    }

    return result;
  }

  /**
   * Processes all pending payouts across all leagues (multi-league worker).
   * Useful for periodic background jobs that handle all failed payouts.
   *
   * Returns aggregated metrics across all leagues.
   */
  public async processAllPendingPayouts(
    leagueIds: string[],
    transactionType: TransactionType = TransactionType.REFUND
  ): Promise<PayoutWorkerResult> {
    const startTime = new Date();
    const aggregated: PayoutWorkerResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      maxAttemptsExceeded: 0,
      durationMs: 0,
      errors: [],
    };

    for (const leagueId of leagueIds) {
      try {
        const result = await this.processPendingPayouts(leagueId, transactionType, new Date());
        aggregated.processed += result.processed;
        aggregated.succeeded += result.succeeded;
        aggregated.failed += result.failed;
        aggregated.maxAttemptsExceeded += result.maxAttemptsExceeded;
        aggregated.errors.push(...result.errors);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        aggregated.errors.push({ entryId: `league-${leagueId}`, error: errorMsg });
        console.error(`[payout-worker] Error processing league ${leagueId}: ${errorMsg}`);
      }
    }

    aggregated.durationMs = Date.now() - startTime.getTime();
    return aggregated;
  }

  /**
   * Returns diagnostic metrics about worker activity and backlog.
   */
  public async getWorkerMetrics() {
    return this.deadLetterService.getWorkerActivityMetrics();
  }
}

export const createPayoutDeadLetterWorker = (
  deadLetterService: PayoutDeadLetterService,
  financialService: FinancialService
) => new PayoutDeadLetterWorker(deadLetterService, financialService);
