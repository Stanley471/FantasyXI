/**
 * Financial Audit Log — append-only record of every ledger-affecting operation.
 *
 * Laravel analogy: Like an event listener that writes to an `audit_logs` table
 * after every money movement, dispatched as a queued job so it never slows down
 * the request that triggered it.
 *
 * Design:
 * - Services call `record()` *after* their ledger write has committed. `record()`
 *   is synchronous, never throws and never awaits the database, so auditing adds
 *   no latency to deposits, withdrawals or fee extraction.
 * - Entries are buffered in memory and persisted in batches with a single
 *   `createMany` round trip (on a short timer, or as soon as the batch fills up).
 * - A failed flush puts the entries back at the front of the buffer so they are
 *   retried; the buffer is bounded to keep memory in check during a DB outage.
 * - The logger only ever inserts. Updates and deletes are additionally rejected
 *   at the database level by prisma/sql/financial_audit_log_append_only.sql.
 */

import { prisma } from "../../config/db.js";
import { FinancialAuditAction } from "@prisma/client";

export { FinancialAuditAction };

/** Actor ID recorded for operations performed by background workers. */
export const SYSTEM_ACTOR = "system";

export interface FinancialAuditEntryInput {
  action: FinancialAuditAction;
  /** User whose funds were affected (null for system-level operations) */
  userId?: string | null;
  /** Who triggered the operation; defaults to SYSTEM_ACTOR */
  actorId?: string;
  leagueId?: string | null;
  transactionId?: string | null;
  amount?: number | string | { toString(): string } | null;
  asset?: string | null;
  stellarTxHash?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FinancialAuditEntry {
  action: FinancialAuditAction;
  userId: string | null;
  actorId: string;
  leagueId: string | null;
  transactionId: string | null;
  amount: string | null;
  asset: string | null;
  stellarTxHash: string | null;
  metadata: Record<string, unknown> | undefined;
  createdAt: Date;
}

/** Minimal surface services depend on, so tests can inject a recorder. */
export interface FinancialAuditRecorder {
  record(entry: FinancialAuditEntryInput): void;
}

export interface FinancialAuditQuery {
  userId?: string;
  leagueId?: string;
  action?: FinancialAuditAction;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface FinancialAuditLoggerOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  /** Max delay between a `record()` call and its persistence */
  flushIntervalMs?: number;
  /** Entries per `createMany` call; reaching it triggers an immediate flush */
  batchSize?: number;
  /** Upper bound on buffered entries while the database is unavailable */
  maxBufferSize?: number;
}

export class FinancialAuditLogger implements FinancialAuditRecorder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxBufferSize: number;
  private buffer: FinancialAuditEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private dropped = 0;

  constructor(options: FinancialAuditLoggerOptions = {}) {
    this.db = options.db ?? prisma;
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 100;
    this.maxBufferSize = options.maxBufferSize ?? 10_000;
  }

  /**
   * Normalizes a Decimal / number / string amount into a fixed string, so the
   * value written to the audit row is exactly what the ledger held.
   */
  public static normalizeAmount(amount: FinancialAuditEntryInput["amount"]): string | null {
    if (amount === null || amount === undefined) return null;
    const value = typeof amount === "number" ? amount.toString() : String(amount);
    return value.trim() === "" ? null : value;
  }

  /**
   * Queues an audit entry. Never throws and never blocks on I/O.
   */
  public record(input: FinancialAuditEntryInput): void {
    try {
      const entry: FinancialAuditEntry = {
        action: input.action,
        userId: input.userId ?? null,
        actorId: input.actorId ?? SYSTEM_ACTOR,
        leagueId: input.leagueId ?? null,
        transactionId: input.transactionId ?? null,
        amount: FinancialAuditLogger.normalizeAmount(input.amount),
        asset: input.asset ?? null,
        stellarTxHash: input.stellarTxHash ?? null,
        metadata: input.metadata,
        createdAt: new Date(),
      };

      this.buffer.push(entry);
      this.trimBuffer();

      if (this.buffer.length >= this.batchSize) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch (error) {
      console.error("[audit] Failed to queue financial audit entry:", error);
    }
  }

  /** Number of entries waiting to be persisted. */
  public get pending(): number {
    return this.buffer.length;
  }

  /** Entries discarded because the buffer overflowed during a DB outage. */
  public get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Persists all buffered entries. Concurrent callers share the in-flight flush.
   */
  public async flush(): Promise<void> {
    while (this.flushing) {
      await this.flushing;
    }
    if (this.buffer.length === 0) return;

    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  /**
   * Flushes and stops the timer. Called on graceful shutdown.
   */
  public async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Reads audit entries, newest first. The log is read-only through this API.
   */
  public async query(filters: FinancialAuditQuery = {}) {
    const where: Record<string, unknown> = {};
    if (filters.userId) where.userId = filters.userId;
    if (filters.leagueId) where.leagueId = filters.leagueId;
    if (filters.action) where.action = filters.action;
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }

    return this.db.financialAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    });
  }

  private async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchSize);
      try {
        await this.db.financialAuditLog.createMany({ data: batch });
      } catch (error) {
        // Put the batch back in front so ordering is preserved, then retry later
        this.buffer.unshift(...batch);
        this.trimBuffer();
        console.error(
          `[audit] Failed to persist ${batch.length} financial audit entr${batch.length === 1 ? "y" : "ies"}; will retry:`,
          (error as Error).message
        );
        this.scheduleFlush();
        return;
      }
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Never keep the process alive just to flush audit entries
    this.timer.unref?.();
  }

  private trimBuffer(): void {
    const overflow = this.buffer.length - this.maxBufferSize;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      this.dropped += overflow;
      console.error(
        `[audit] Audit buffer full; dropped ${overflow} oldest entr${overflow === 1 ? "y" : "ies"} (total dropped: ${this.dropped})`
      );
    }
  }
}

export const financialAuditLog = new FinancialAuditLogger();
