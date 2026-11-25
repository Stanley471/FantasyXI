/**
 * Issue #438 — Transactional Outbox Service
 *
 * Writes OutboxEvent rows that must be persisted *within the same database
 * transaction* as the originating business mutation.  The relay worker
 * (`outboxRelayWorker.ts`) polls this table and publishes events to the
 * message bus (Redis Streams / `eventBus`) with at-least-once semantics.
 *
 * Usage inside a Prisma transaction
 * ──────────────────────────────────
 *   await prisma.$transaction(async (tx) => {
 *     await tx.league.create({ data: { ... } });
 *     await outboxService.enqueue(tx, {
 *       aggregateType: "League",
 *       aggregateId:   leagueId,
 *       eventType:     "LEAGUE_CREATED",
 *       payload:       { leagueId, name, createdBy },
 *       deduplicationId: `League/${leagueId}/LEAGUE_CREATED`,
 *     });
 *   });
 *
 * Idempotency / deduplication
 * ────────────────────────────
 * `deduplicationId` is a unique index.  Callers should use a deterministic
 * key (e.g. `<AggregateType>/<aggregateId>/<version>`) so concurrent or
 * retried writes don't create duplicate outbox rows.  An upsert-on-conflict-
 * do-nothing strategy is used so a duplicate write within the same
 * transaction is silently ignored.
 */

import type { PrismaClient } from "@prisma/client";

// Lazy accessor — avoids pulling in Prisma at module load in test environments
// that inject a mock client. The real Prisma instance is only resolved when a
// method is actually called without an explicit db argument.
let _defaultDb: any | null = null;
function getDefaultDb(): any {
  if (!_defaultDb) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prisma } = require("../../config/db.js");
    _defaultDb = prisma;
  }
  return _defaultDb;
}

export interface OutboxEventInput {
  /** Caller-controlled idempotency key (must be unique per logical event). */
  deduplicationId: string;
  /** Domain entity class, e.g. "League", "User", "Payout". */
  aggregateType: string;
  /** ID of the aggregate that produced the event. */
  aggregateId: string;
  /** Event discriminator, e.g. "LEAGUE_CREATED", "PAYOUT_SETTLED". */
  eventType: string;
  /** JSON-serialisable event body. */
  payload: Record<string, unknown>;
}

export class OutboxService {
  constructor(private db: any | null = null) {}

  private getDb(): any {
    return this.db ?? getDefaultDb();
  }

  /**
   * Writes an `OutboxEvent` row using the supplied Prisma client (which may be
   * a transaction client) so the row is committed atomically with the caller's
   * own mutation.
   *
   * On a duplicate `deduplicationId` the write is silently skipped (upsert
   * with no-op update), so callers may safely retry their whole transaction
   * block without producing phantom events.
   */
  async enqueue(
    client: { outboxEvent: { upsert: Function } },
    input: OutboxEventInput,
  ): Promise<void> {
    await client.outboxEvent.upsert({
      where: { deduplicationId: input.deduplicationId },
      create: {
        deduplicationId: input.deduplicationId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload,
        status: "PENDING",
        attempts: 0,
        nextRetryAt: new Date(),
      },
      update: {}, // no-op — first writer wins
    });
  }

  /**
   * Convenience helper for callers that do not already hold a transaction.
   * Wraps `enqueue` in its own single-statement transaction.
   */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    await this.enqueue(this.getDb(), input);
  }
}

export const outboxService = new OutboxService();
