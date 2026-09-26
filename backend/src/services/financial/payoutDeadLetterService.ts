/**
 * Payout Dead-Letter Queue
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
    private readonly audit: FinancialAuditRecorder = financialAuditLog
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
}

export const payoutDeadLetterService = new PayoutDeadLetterService();
