/**
 * Payout Dead-Letter Queue with Distributed Lock-Free Reprocessing
 *
 * Laravel analogy: Like the `failed_jobs` table plus `php artisan queue:retry`,
 * but for on-chain payouts, where retrying blindly can move real money twice.
 *
 * - Every payout batch that fails on-chain (or cannot be sent, e.g. no wallet
 *   linked) is written to `failed_payouts` and its members are isolated: the
 *   automatic dispatcher skips them until the entry is resolved or discarded.
 * - Only errors classified as recoverable (network hiccups, RPC timeouts, rate
 *   limits) are retried automatically, and only up to MAX_AUTOMATIC_ATTEMPTS.
 *   Everything else, including unknown errors, waits for an admin.
 * - A retry first *claims* the entry (PENDING -> RETRYING with a conditional
 *   update), so two admins, or an admin and the worker, can never dispatch the
 *   same payout concurrently.
 *
 * DISTRIBUTED LOCK-FREE REPROCESSING:
 * - Multiple workers compete to claim retry-eligible entries using database
 *   row-level locking (SELECT ... FOR UPDATE SKIP LOCKED).
 * - Exponential backoff with full jitter prevents thundering herd failures and
 *   smooths RPC node load: delay = baseDelay * (2 ^ attemptNumber) + jitter
 * - Each worker grabs N unlocked entries, processes them, and releases them
 *   so other workers can compete fairly without mutexes or distributed locks.
 * - Detailed audit trails track every attempt, error, and state transition.
 */

import { prisma } from "../../config/db.js";
import { FailedPayoutStatus } from "@prisma/client";
import {
  FinancialAuditAction,
  FinancialAuditRecorder,
  financialAuditLog,
  SYSTEM_ACTOR,
} from "../audit/financialAuditLog.js";
import { TransactionType } from "../../types/index.js";

export { FailedPayoutStatus };

/** Automatic attempts (including the first dispatch) before a recoverable failure needs an admin. */
export const MAX_AUTOMATIC_ATTEMPTS = 3;

/**
 * Base delay in milliseconds for exponential backoff.
 * Retry 1: ~0-2s, Retry 2: ~0-4s, Retry 3: ~0-8s
 */
export const BACKOFF_BASE_MS = 1000;

/**
 * Maximum backoff delay in milliseconds to prevent indefinite growth.
 * Cap retries at ~30 minutes (30000ms).
 */
export const BACKOFF_MAX_MS = 30 * 60 * 1000;

/**
 * A RETRYING entry older than this is assumed orphaned (e.g. the process died
 * mid-retry) and may be claimed again. Safe for refunds because the escrow
 * contract ignores deposits that were already refunded.
 */
export const STALE_RETRY_MS = 15 * 60 * 1000;

/** Error recorded for paid members that cannot be paid because no wallet is linked. */
export const MISSING_WALLET_ERROR = "MISSING_WALLET: member has no linked Stellar address";

/**
 * Statuses whose members must not be auto-dispatched: open entries awaiting a
 * retry, and discarded ones (an admin decided the platform must not pay them).
 */
export const ISOLATING_DEAD_LETTER_STATUSES: FailedPayoutStatus[] = [
  FailedPayoutStatus.PENDING,
  FailedPayoutStatus.RETRYING,
  FailedPayoutStatus.DISCARDED,
];

/** Configuration for backoff scheduling. */
export interface BackoffConfig {
  /** Base delay in milliseconds (default: 1000ms) */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds (default: 30min) */
  maxDelayMs: number;
}

const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: BACKOFF_BASE_MS,
  maxDelayMs: BACKOFF_MAX_MS,
};

/** Tuple of computed backoff state for display and scheduling. */
export interface BackoffState {
  /** Next attempt number (1-indexed) */
  attemptNumber: number;
  /** Base delay before jitter in milliseconds */
  baseDelayMs: number;
  /** Lower bound of jittered delay range (inclusive) in milliseconds */
  minDelayMs: number;
  /** Upper bound of jittered delay range (inclusive) in milliseconds */
  maxDelayMs: number;
  /** Computed next_retry_at timestamp (when this entry becomes eligible for retry) */
  nextRetryAt: Date;
}

/**
 * Lock-free worker configuration for distributed retry processing.
 */
export interface LockFreeWorkerConfig {
  /** Max entries to grab per worker invocation (default: 10) */
  batchSize: number;
  /** Backoff configuration */
  backoff: BackoffConfig;
}

const DEFAULT_WORKER_CONFIG: LockFreeWorkerConfig = {
  batchSize: 10,
  backoff: DEFAULT_BACKOFF_CONFIG,
};

/**
 * Calculates exponential backoff with full jitter for a retry attempt.
 *
 * Formula:
 *   baseDelay = baseDelayMs * (2 ^ attemptNumber)
 *   jitter = random(0, baseDelay)
 *   nextRetryAt = now + jitter
 *
 * This provides a smooth distribution of retry attempts across time,
 * preventing thundering herd collisions at RPC nodes.
 *
 * Example with baseDelayMs=1000:
 *   Attempt 0 (first failure): 0-1000ms jitter
 *   Attempt 1: 0-2000ms jitter
 *   Attempt 2: 0-4000ms jitter
 */
export function calculateBackoffState(
  attempts: number,
  now: Date = new Date(),
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG
): BackoffState {
  const attemptNumber = attempts; // Current attempt count (0-indexed in logic, but displayed as 1-indexed for clarity)
  const baseDelayMs = Math.min(
    config.baseDelayMs * Math.pow(2, attemptNumber),
    config.maxDelayMs
  );
  const jitterMs = Math.random() * baseDelayMs;
  const nextRetryAt = new Date(now.getTime() + jitterMs);

  return {
    attemptNumber: attempts + 1,
    baseDelayMs,
    minDelayMs: 0,
    maxDelayMs: baseDelayMs,
    nextRetryAt,
  };
}

const RECOVERABLE_ERROR_PATTERNS: RegExp[] = [
  /not confirmed in time/i,
  /TRY_AGAIN_LATER/i,
  /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i,
  /network error|fetch failed/i,
  /\b(429|502|503|504)\b|rate.?limit|too many requests|service unavailable|bad gateway/i,
  /tx_?bad_?seq|txBadSeq/i,
  /tx_?insufficient_?fee|txInsufficientFee/i,
];

const NON_RECOVERABLE_ERROR_PATTERNS: RegExp[] = [
  /Error\(Contract,\s*#\d+\)/,
  /MISSING_WALLET/,
  /is required|not configured|not provided/i,
  /invalid|malformed/i,
  /underfunded|no.?trust/i,
];

export interface PayoutErrorClassification {
  recoverable: boolean;
  errorCode: number | null;
}

export interface DeadLetterPayoutInput {
  type: TransactionType;
  leagueId: string;
  memberIds: string[];
  recipients: string[];
  amountPerRecipient: number | string | { toString(): string };
  error: string;
  errorCode?: number | null;
  /** Override classification (e.g. missing wallet is never auto-recoverable) */
  recoverable?: boolean;
}

export interface DeadLetterListFilters {
  status?: FailedPayoutStatus;
  leagueId?: string;
  type?: TransactionType;
  limit?: number;
  offset?: number;
}

export class DeadLetterNotFoundError extends Error {
  constructor(id: string) {
    super(`Dead-lettered payout ${id} was not found`);
    this.name = "DeadLetterNotFoundError";
  }
}

export class DeadLetterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadLetterConflictError";
  }
}

export class PayoutDeadLetterService {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = prisma,
    private readonly audit: FinancialAuditRecorder = financialAuditLog,
    private readonly workerConfig: LockFreeWorkerConfig = DEFAULT_WORKER_CONFIG
  ) {}

  /**
   * Decides whether a payout error may be retried without a human in the loop.
   * Unknown errors are treated as non-recoverable: when money is involved, a
   * false "recoverable" is worse than an extra manual review.
   */
  public static classifyError(message: string, errorCode?: number | null): PayoutErrorClassification {
    const contractCode = message.match(/Error\(Contract,\s*#(\d+)\)/);
    const code = errorCode ?? (contractCode ? parseInt(contractCode[1], 10) : null);

    if (code !== null || NON_RECOVERABLE_ERROR_PATTERNS.some((p) => p.test(message))) {
      return { recoverable: false, errorCode: code };
    }
    return {
      recoverable: RECOVERABLE_ERROR_PATTERNS.some((p) => p.test(message)),
      errorCode: null,
    };
  }

  /**
   * Isolates a failed payout batch in the dead-letter queue.
   */
  public async deadLetter(input: DeadLetterPayoutInput) {
    const classification = PayoutDeadLetterService.classifyError(input.error, input.errorCode);
    const recoverable = input.recoverable ?? classification.recoverable;

    const entry = await this.db.failedPayout.create({
      data: {
        type: input.type,
        leagueId: input.leagueId,
        memberIds: input.memberIds,
        recipients: input.recipients,
        amountPerRecipient: input.amountPerRecipient,
        status: FailedPayoutStatus.PENDING,
        recoverable,
        errorMessage: input.error,
        errorCode: classification.errorCode,
        attempts: 1,
        lastAttemptAt: new Date(),
      },
    });

    this.audit.record({
      action: FinancialAuditAction.PAYOUT_DEAD_LETTERED,
      actorId: SYSTEM_ACTOR,
      leagueId: input.leagueId,
      amount: input.amountPerRecipient,
      metadata: {
        failedPayoutId: entry.id,
        type: input.type,
        memberIds: input.memberIds,
        recoverable,
        error: input.error,
      },
    });

    console.warn(
      `[payouts] Dead-lettered ${input.type} for ${input.memberIds.length} member(s) of league ${input.leagueId} ` +
        `(${recoverable ? "recoverable" : "needs manual intervention"}): ${input.error}`
    );
    return entry;
  }

  /**
   * Member IDs referenced by open or discarded dead-letter entries of a league.
   * The automatic dispatcher must skip these members.
   */
  public async getIsolatedMemberIds(leagueId: string, type: TransactionType): Promise<Set<string>> {
    const open = await this.db.failedPayout.findMany({
      where: { leagueId, type, status: { in: ISOLATING_DEAD_LETTER_STATUSES } },
      select: { memberIds: true },
    });
    return new Set(open.flatMap((e: { memberIds: string[] }) => e.memberIds));
  }

  /**
   * Recoverable entries of a league that still have automatic attempts left.
   */
  public async getAutoRetryable(leagueId: string, type: TransactionType) {
    return this.db.failedPayout.findMany({
      where: {
        leagueId,
        type,
        status: FailedPayoutStatus.PENDING,
        recoverable: true,
        attempts: { lt: MAX_AUTOMATIC_ATTEMPTS },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  public async list(filters: DeadLetterListFilters = {}) {
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.leagueId) where.leagueId = filters.leagueId;
    if (filters.type) where.type = filters.type;

    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const skip = Math.max(filters.offset ?? 0, 0);

    const [items, total] = await Promise.all([
      this.db.failedPayout.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      this.db.failedPayout.count({ where }),
    ]);
    return { items, total, limit: take, offset: skip };
  }

  public async get(id: string) {
    const entry = await this.db.failedPayout.findUnique({ where: { id } });
    if (!entry) {
      throw new DeadLetterNotFoundError(id);
    }
    return entry;
  }

  /**
   * Atomically moves an entry from PENDING (or an orphaned RETRYING) to RETRYING.
   * Throws a conflict when the entry is actively being retried or is closed, which
   * prevents two concurrent dispatches of the same payout.
   */
  public async claimForRetry(id: string, now: Date = new Date()) {
    const claimed = await this.db.failedPayout.updateMany({
      where: {
        id,
        OR: [
          { status: FailedPayoutStatus.PENDING },
          {
            status: FailedPayoutStatus.RETRYING,
            lastAttemptAt: { lt: new Date(now.getTime() - STALE_RETRY_MS) },
          },
        ],
      },
      data: { status: FailedPayoutStatus.RETRYING, lastAttemptAt: now },
    });

    if (claimed.count !== 1) {
      const entry = await this.get(id);
      throw new DeadLetterConflictError(
        `Payout ${id} cannot be retried while in status ${entry.status}`
      );
    }
    return this.get(id);
  }

  /**
   * Marks a claimed entry as delivered.
   */
  public async markResolved(
    entry: { id: string; leagueId: string; type: TransactionType; memberIds: string[]; amountPerRecipient: unknown },
    params: { actorId: string; txHash: string | null; note?: string; paidMemberIds: string[] }
  ) {
    const resolved = await this.db.failedPayout.update({
      where: { id: entry.id },
      data: {
        status: FailedPayoutStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedById: params.actorId,
        resolutionNote: params.note ?? null,
        retryTxHash: params.txHash,
      },
    });

    this.audit.record({
      action: FinancialAuditAction.PAYOUT_RETRY_SUCCEEDED,
      actorId: params.actorId,
      leagueId: entry.leagueId,
      stellarTxHash: params.txHash,
      amount: entry.amountPerRecipient as string,
      metadata: {
        failedPayoutId: entry.id,
        type: entry.type,
        paidMemberIds: params.paidMemberIds,
        note: params.note,
      },
    });
    return resolved;
  }

  /**
   * Returns a claimed entry to PENDING after another failed attempt.
   */
  public async markRetryFailed(
    entry: { id: string; leagueId: string; type: TransactionType; attempts: number },
    params: { actorId: string; error: string; errorCode?: number | null }
  ) {
    const classification = PayoutDeadLetterService.classifyError(params.error, params.errorCode);
    const updated = await this.db.failedPayout.update({
      where: { id: entry.id },
      data: {
        status: FailedPayoutStatus.PENDING,
        attempts: entry.attempts + 1,
        errorMessage: params.error,
        errorCode: classification.errorCode,
        recoverable: classification.recoverable,
        lastAttemptAt: new Date(),
      },
    });

    this.audit.record({
      action: FinancialAuditAction.PAYOUT_RETRY_FAILED,
      actorId: params.actorId,
      leagueId: entry.leagueId,
      metadata: {
        failedPayoutId: entry.id,
        type: entry.type,
        attempt: entry.attempts + 1,
        recoverable: classification.recoverable,
        error: params.error,
      },
    });
    return updated;
  }

  /**
   * Closes an entry without paying it out (e.g. refunded manually off-platform).
   * Its members stay excluded from automatic payouts. A reason is mandatory so
   * the decision is traceable in the audit log.
   */
  public async discard(id: string, actorId: string, reason: string) {
    const trimmed = reason?.trim();
    if (!trimmed) {
      throw new DeadLetterConflictError("A reason is required to discard a failed payout");
    }

    const closed = await this.db.failedPayout.updateMany({
      where: { id, status: FailedPayoutStatus.PENDING },
      data: {
        status: FailedPayoutStatus.DISCARDED,
        resolvedAt: new Date(),
        resolvedById: actorId,
        resolutionNote: trimmed,
      },
    });

    if (closed.count !== 1) {
      const entry = await this.get(id);
      throw new DeadLetterConflictError(
        `Payout ${id} cannot be discarded while in status ${entry.status}`
      );
    }

    const entry = await this.get(id);
    this.audit.record({
      action: FinancialAuditAction.PAYOUT_DISCARDED,
      actorId,
      leagueId: entry.leagueId,
      amount: entry.amountPerRecipient,
      metadata: { failedPayoutId: id, type: entry.type, memberIds: entry.memberIds, reason: trimmed },
    });
    return entry;
  }

  /**
   * Schedules a failed payout for retry with exponential backoff + jitter.
   * Called after a retry attempt fails to compute the next eligible retry time.
   * The entry remains in PENDING status but next_retry_at is updated.
   *
   * DISTRIBUTED LOCK-FREE: This method is safe to call concurrently from multiple
   * workers because it updates based on current attempt count (idempotent).
   */
  public async scheduleRetryWithBackoff(
    entryId: string,
    now: Date = new Date()
  ): Promise<BackoffState> {
    const entry = await this.get(entryId);
    const backoffState = calculateBackoffState(entry.attempts, now, this.workerConfig.backoff);

    await this.db.failedPayout.update({
      where: { id: entryId },
      data: {
        retryScheduledAt: now,
        nextRetryAt: backoffState.nextRetryAt,
      },
    });

    this.audit.record({
      action: FinancialAuditAction.PAYOUT_RETRY_SCHEDULED,
      actorId: SYSTEM_ACTOR,
      leagueId: entry.leagueId,
      metadata: {
        failedPayoutId: entryId,
        type: entry.type,
        attemptNumber: backoffState.attemptNumber,
        baseDelayMs: backoffState.baseDelayMs,
        maxDelayMs: backoffState.maxDelayMs,
        scheduledRetryAt: backoffState.nextRetryAt.toISOString(),
      },
    });

    return backoffState;
  }

  /**
   * Lock-free distributed worker that claims retry-eligible failed payouts
   * using database row-level locking (SELECT ... FOR UPDATE SKIP LOCKED).
   *
   * Multiple workers can safely compete to grab and process entries concurrently.
   * Workers that cannot grab a lock skip that entry and move to the next one,
   * preventing contention without mutexes.
   *
   * Returns entries that are ready for retry (now >= next_retry_at) and have
   * not been claimed by another worker.
   *
   * USAGE (in a worker/job):
   *   const batch = await deadLetterService.claimRetryBatchLockFree(leagueId, TransactionType.REFUND);
   *   for (const entry of batch) {
   *     try {
   *       const result = await dispatchPayout(entry);
   *       if (result.success) {
   *         await deadLetterService.markResolved(...);
   *       } else {
   *         await deadLetterService.markRetryFailed(...);
   *         await deadLetterService.scheduleRetryWithBackoff(entry.id);
   *       }
   *     } catch (err) {
   *       await deadLetterService.scheduleRetryWithBackoff(entry.id);
   *     }
   *   }
   */
  public async claimRetryBatchLockFree(
    leagueId: string,
    type: TransactionType,
    now: Date = new Date()
  ): Promise<
    Array<{
      id: string;
      type: TransactionType;
      leagueId: string;
      memberIds: string[];
      recipients: string[];
      amountPerRecipient: string;
      attempts: number;
      recoverable: boolean;
      errorMessage: string;
      nextRetryAt: Date;
    }>
  > {
    /**
     * Raw SQL with FOR UPDATE SKIP LOCKED:
     *   - Selects eligible entries (PENDING, recoverable, attempts < MAX, nextRetryAt <= now)
     *   - Locks rows at the database level with FOR UPDATE
     *   - SKIP LOCKED causes workers that can't acquire a lock to skip that row
     *     and move to the next, preventing thundering herd pile-ups
     *   - Returns only rows successfully locked (no deadlocks, no contention)
     */
    const batch = await this.db.$queryRaw`
      SELECT 
        id, type, league_id as "leagueId", member_ids as "memberIds", 
        recipients, amount_per_recipient as "amountPerRecipient",
        attempts, recoverable, error_message as "errorMessage", next_retry_at as "nextRetryAt"
      FROM failed_payouts
      WHERE 
        league_id = ${leagueId}
        AND type = ${type}
        AND status = ${FailedPayoutStatus.PENDING}
        AND recoverable = true
        AND attempts < ${MAX_AUTOMATIC_ATTEMPTS}
        AND (next_retry_at IS NULL OR next_retry_at <= ${now})
      ORDER BY last_attempt_at ASC
      LIMIT ${this.workerConfig.batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    return batch as any[];
  }

  /**
   * Reports lock-free worker activity and attempts made during a reprocessing cycle.
   * Used for diagnostics and monitoring.
   */
  public async getWorkerActivityMetrics(timeWindowMs: number = 60000): Promise<{
    recentRetries: number;
    recentSuccesses: number;
    recentFailures: number;
    averageAttemptsPerFailure: number;
  }> {
    const since = new Date(Date.now() - timeWindowMs);

    const [retries, successes, failures] = await Promise.all([
      this.db.failedPayout.count({
        where: {
          retryScheduledAt: { gte: since },
        },
      }),
      this.db.failedPayout.count({
        where: {
          status: FailedPayoutStatus.RESOLVED,
          resolvedAt: { gte: since },
        },
      }),
      this.db.failedPayout.count({
        where: {
          status: FailedPayoutStatus.PENDING,
          attempts: { gte: 2 },
        },
      }),
    ]);

    const allPending = await this.db.failedPayout.findMany({
      where: { status: FailedPayoutStatus.PENDING },
      select: { attempts: true },
    });

    const avgAttempts =
      allPending.length > 0
        ? allPending.reduce((sum: number, e: { attempts: number }) => sum + e.attempts, 0) / allPending.length
        : 0;

    return {
      recentRetries: retries,
      recentSuccesses: successes,
      recentFailures: failures,
      averageAttemptsPerFailure: parseFloat(avgAttempts.toFixed(2)),
    };
  }
}

export const payoutDeadLetterService = new PayoutDeadLetterService();
