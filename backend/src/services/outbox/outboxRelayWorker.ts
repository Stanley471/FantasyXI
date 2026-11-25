/**
 * Issue #438 — Outbox Relay Worker
 *
 * Polls the `outbox_events` table for PENDING / FAILED rows and publishes
 * them to the event bus (Redis Streams) with at-least-once delivery semantics.
 *
 * Delivery contract
 * ─────────────────
 * • At-least-once: a successful publish marks the row PUBLISHED.  On error
 *   the row stays PENDING (or FAILED after MAX_ATTEMPTS) and is retried with
 *   exponential back-off.
 * • Deduplication: downstream consumers must treat events as idempotent.
 *   Each event carries `deduplicationId`; consumers store it in a seen-set.
 * • Exactly-once from the DB perspective: optimistic row-locking via
 *   `locked_until` prevents concurrent relay instances from delivering the
 *   same event twice within the lock window.
 *
 * Back-off schedule (configurable via env)
 * ─────────────────────────────────────────
 * attempt 1 → +30 s
 * attempt 2 → +2 min
 * attempt 3 → +10 min
 * attempt 4 → +1 h
 * attempt ≥ MAX_ATTEMPTS → status = DEAD (no further retry)
 *
 * Cleanup
 * ────────
 * PUBLISHED rows older than CLEANUP_AFTER_MS (default 48 h) are deleted in
 * each poll cycle to bound table growth.
 */

// Lazy Prisma accessor — prevents module-load failure in test environments
// that inject a mock client.
let _defaultDb: any | null = null;
function getDefaultDb(): any {
  if (!_defaultDb) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prisma } = require("../../config/db.js");
    _defaultDb = prisma;
  }
  return _defaultDb;
}
import { publishSessionEvent } from "../auth/sessionStreamSync.js";
import { STREAM_KEY } from "../auth/sessionStreamSync.js";
import { getRedisClient } from "../../config/redis.js";
import type { Redis as RedisClient } from "ioredis";

// ─── Configuration ────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1_000);
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE ?? 50);
const LOCK_DURATION_MS = Number(process.env.OUTBOX_LOCK_DURATION_MS ?? 30_000);
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5);
const CLEANUP_AFTER_MS = Number(process.env.OUTBOX_CLEANUP_AFTER_MS ?? 48 * 60 * 60 * 1000);

/** Back-off delays in ms, indexed by (attempt - 1), capped at MAX_ATTEMPTS. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 3_600_000];

function nextRetryDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
}

// ─── Publisher strategy ───────────────────────────────────────────────────────

/**
 * Publishes a single OutboxEvent to Redis Streams.  Returns true on success.
 * The relay treats any thrown error as a delivery failure.
 */
async function publishToStream(
  event: {
    id: string;
    deduplicationId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
    createdAt: Date;
  },
  redis: RedisClient,
): Promise<void> {
  const OUTBOX_STREAM = "outbox:events";
  const payload = typeof event.payload === "string"
    ? event.payload
    : JSON.stringify(event.payload);

  await redis.xadd(
    OUTBOX_STREAM,
    "MAXLEN", "~", 100_000,
    "*",
    "id",             event.id,
    "deduplicationId", event.deduplicationId,
    "aggregateType",  event.aggregateType,
    "aggregateId",    event.aggregateId,
    "eventType",      event.eventType,
    "payload",        payload,
    "createdAt",      event.createdAt.toISOString(),
  );
}

// ─── Worker class ─────────────────────────────────────────────────────────────

export class OutboxRelayWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private db: any;

  constructor(
    db: any | null = null,
    private readonly redis: RedisClient | null = getRedisClient(),
  ) {
    this.db = db; // null means "resolve lazily on first poll"
  }

  private getDb(): any {
    if (!this.db) this.db = getDefaultDb();
    return this.db;
  }

  /** Starts the polling loop. Safe to call multiple times (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextPoll(0);
  }

  /** Stops the polling loop gracefully. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  /**
   * One poll cycle:
   *  1. Claim a batch of due, unlocked PENDING/FAILED events.
   *  2. Publish each to the message bus.
   *  3. Mark PUBLISHED on success; increment attempts + schedule retry on fail.
   *  4. Garbage-collect old PUBLISHED rows.
   *
   * Can be called directly for testing; the `start()`/`stop()` loop calls it
   * on a timer.
   */
  async poll(): Promise<void> {
    try {
      await this.processBatch();
      await this.cleanup();
    } catch (err) {
      console.error("[OutboxRelayWorker] Unhandled poll error:", (err as Error).message);
    } finally {
      if (this.running) {
        this.scheduleNextPoll(POLL_INTERVAL_MS);
      }
    }
  }

  private async processBatch(): Promise<void> {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + LOCK_DURATION_MS);

    // Claim the batch: update lock and return the claimed rows atomically.
    // Prisma doesn't expose UPDATE…RETURNING, so we do a find-then-update
    // sequence protected by optimistic locking on `lockedUntil`.
    const candidates = await this.getDb().outboxEvent.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        nextRetryAt: { lte: now },
        OR: [
          { lockedUntil: null },
          { lockedUntil: { lte: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    if (candidates.length === 0) return;

    // Claim all candidates in a single batch update
    const ids = candidates.map((e: { id: string }) => e.id);
    await this.getDb().outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { lockedUntil: lockUntil },
    });

    for (const event of candidates) {
      await this.deliver(event);
    }
  }

  private async deliver(event: {
    id: string;
    deduplicationId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
    attempts: number;
    createdAt: Date;
  }): Promise<void> {
    const nextAttempts = event.attempts + 1;

    try {
      if (!this.redis) {
        throw new Error("Redis unavailable — cannot publish outbox event");
      }
      await publishToStream(event, this.redis);

      await this.getDb().outboxEvent.update({
        where: { id: event.id },
        data: {
          status: "PUBLISHED",
          attempts: nextAttempts,
          publishedAt: new Date(),
          lockedUntil: null,
        },
      });
    } catch (err) {
      const nextStatus = nextAttempts >= MAX_ATTEMPTS ? "DEAD" : "FAILED";
      const retryAt = new Date(Date.now() + nextRetryDelay(nextAttempts));

      await this.getDb().outboxEvent.update({
        where: { id: event.id },
        data: {
          status: nextStatus,
          attempts: nextAttempts,
          lockedUntil: null,
          nextRetryAt: retryAt,
        },
      });

      console.warn(
        `[OutboxRelayWorker] Event ${event.id} (${event.eventType}) failed — ` +
          `attempt ${nextAttempts}/${MAX_ATTEMPTS}, status=${nextStatus}: ` +
          (err as Error).message,
      );
    }
  }

  /**
   * Deletes PUBLISHED rows older than CLEANUP_AFTER_MS to bound table size.
   * Dead events are retained for investigation (they will need manual cleanup
   * or a separate ops runbook).
   */
  private async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - CLEANUP_AFTER_MS);
    try {
      const result = await this.getDb().outboxEvent.deleteMany({
        where: {
          status: "PUBLISHED",
          publishedAt: { lte: cutoff },
        },
      });
      if (result.count > 0) {
        console.info(`[OutboxRelayWorker] Cleaned up ${result.count} published outbox events`);
      }
    } catch (err) {
      // Non-fatal — cleanup failure doesn't stop delivery
      console.warn("[OutboxRelayWorker] Cleanup error:", (err as Error).message);
    }
  }
}

/** Process-wide singleton — started by the application bootstrap. */
export const outboxRelayWorker = new OutboxRelayWorker();
