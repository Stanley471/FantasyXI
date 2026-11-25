/**
 * Tests for Issue #438 — Transactional Outbox Service
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { OutboxService } from "../services/outbox/outboxService.js";

// ─── Minimal in-memory mock for the Prisma outboxEvent model ─────────────────

interface OutboxRow {
  id: string;
  deduplicationId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  nextRetryAt: Date;
}

function buildMockDb() {
  const rows: OutboxRow[] = [];
  let nextId = 1;

  return {
    rows,
    outboxEvent: {
      async upsert({ where, create }: { where: { deduplicationId: string }; create: any; update: any }) {
        const existing = rows.find((r) => r.deduplicationId === where.deduplicationId);
        if (existing) return existing; // no-op on duplicate
        const row = { id: String(nextId++), ...create };
        rows.push(row);
        return row;
      },
    },
  };
}

describe("OutboxService (Issue #438)", () => {
  let mockDb: ReturnType<typeof buildMockDb>;
  let service: OutboxService;

  beforeEach(() => {
    mockDb = buildMockDb();
    service = new OutboxService(mockDb as any);
  });

  it("enqueues an event with the correct fields", async () => {
    await service.enqueueStandalone({
      deduplicationId: "League/league-1/LEAGUE_CREATED",
      aggregateType: "League",
      aggregateId: "league-1",
      eventType: "LEAGUE_CREATED",
      payload: { name: "Premier Fantasy", createdBy: "user-1" },
    });

    assert.equal(mockDb.rows.length, 1);
    const row = mockDb.rows[0];
    assert.equal(row.aggregateType, "League");
    assert.equal(row.aggregateId, "league-1");
    assert.equal(row.eventType, "LEAGUE_CREATED");
    assert.equal(row.status, "PENDING");
    assert.equal(row.attempts, 0);
    assert.equal(row.deduplicationId, "League/league-1/LEAGUE_CREATED");
    assert.deepEqual(row.payload, { name: "Premier Fantasy", createdBy: "user-1" });
  });

  it("is idempotent: duplicate deduplicationId does not create a second row", async () => {
    const input = {
      deduplicationId: "Payout/payout-99/PAYOUT_SETTLED",
      aggregateType: "Payout",
      aggregateId: "payout-99",
      eventType: "PAYOUT_SETTLED",
      payload: { amount: 100 },
    };

    await service.enqueueStandalone(input);
    await service.enqueueStandalone(input); // duplicate

    assert.equal(mockDb.rows.length, 1, "second write must be a no-op");
  });

  it("enqueues multiple distinct events for the same aggregate", async () => {
    await service.enqueueStandalone({
      deduplicationId: "League/league-2/v1",
      aggregateType: "League",
      aggregateId: "league-2",
      eventType: "LEAGUE_CREATED",
      payload: { name: "Alpha League" },
    });
    await service.enqueueStandalone({
      deduplicationId: "League/league-2/v2",
      aggregateType: "League",
      aggregateId: "league-2",
      eventType: "LEAGUE_STARTED",
      payload: { gameweek: 1 },
    });

    assert.equal(mockDb.rows.length, 2);
    const events = mockDb.rows.map((r) => r.eventType);
    assert.ok(events.includes("LEAGUE_CREATED"));
    assert.ok(events.includes("LEAGUE_STARTED"));
  });

  it("enqueue within a transaction client writes to that client", async () => {
    // Simulate a transaction client with its own rows array
    const txRows: OutboxRow[] = [];
    const txClient = {
      outboxEvent: {
        async upsert({ where, create }: { where: { deduplicationId: string }; create: any; update: any }) {
          const existing = txRows.find((r) => r.deduplicationId === where.deduplicationId);
          if (existing) return existing;
          const row = { id: "tx-1", ...create };
          txRows.push(row);
          return row;
        },
      },
    };

    await service.enqueue(txClient, {
      deduplicationId: "User/user-5/USER_SIGNED_UP",
      aggregateType: "User",
      aggregateId: "user-5",
      eventType: "USER_SIGNED_UP",
      payload: { email: "user@example.com" },
    });

    // Should be in txClient's store, not the main mock
    assert.equal(txRows.length, 1);
    assert.equal(mockDb.rows.length, 0);
    assert.equal(txRows[0].eventType, "USER_SIGNED_UP");
  });
});
