-- Migration: Transactional Outbox Pattern (Issue #438)
-- Creates the outbox_events table used for guaranteed at-least-once delivery
-- of integration events across service boundaries.

CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD');

CREATE TABLE "outbox_events" (
    "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
    "deduplication_id" TEXT NOT NULL,
    "aggregate_type"   TEXT NOT NULL,
    "aggregate_id"     TEXT NOT NULL,
    "event_type"       TEXT NOT NULL,
    "payload"          JSONB NOT NULL,
    "status"           "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts"         INTEGER NOT NULL DEFAULT 0,
    "locked_until"     TIMESTAMPTZ,
    "published_at"     TIMESTAMPTZ,
    "next_retry_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on deduplication_id prevents duplicate rows from concurrent writers
CREATE UNIQUE INDEX "outbox_events_deduplication_id_key"
    ON "outbox_events"("deduplication_id");

-- Primary relay-worker scan index: pick up PENDING/FAILED events due for retry
CREATE INDEX "outbox_events_status_next_retry_at_idx"
    ON "outbox_events"("status", "next_retry_at");

-- Secondary index for aggregate-scoped lookups (e.g. replay by aggregate)
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx"
    ON "outbox_events"("aggregate_type", "aggregate_id");
