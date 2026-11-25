/**
 * Tests for Issue #438 — Outbox Relay Worker
 *
 * Uses in-memory mocks for Prisma and Redis; no live infrastructure required.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { OutboxRelayWorker } from "../services/outbox/outboxRelayWorker.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type OutboxRow = {
  id: string;
  deduplicationId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  status: string;
  attempts: number;
  lockedUntil: Date | null;
  publishedAt: Date | null;
  nextRetryAt: Date;
  createdAt: Date;
};

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `row-${Math.random()}`,
    deduplicationId: `dedup-${Math.random()}`,
    aggregateType: "League",
    aggregateId: "league-1",
    eventType: "LEAGUE_CREATED",
    payload: { name: "Alpha" },
    status: "PENDING",
    attempts: 0,
    lockedUntil: null,
    publishedAt: null,
    nextRetryAt: new Date(Date.now() - 1000), // due now
    createdAt: new Date(),
    ...overrides,
  };
}

function buildMockDb(rows: OutboxRow[]) {
  return {
    outboxEvent: {
      async findMany({ where, take }: any) {
        const now = new Date();
        return rows
          .filter(
            (r) =>
              ["PENDING", "FAILED"].includes(r.status) &&
              r.nextRetryAt <= now &&
              (r.lockedUntil === null || r.lockedUntil <= now),
          )
          .slice(0, take);
      },
      async updateMany({ where, data }: any) {
        const ids: string[] = where.id?.in ?? [];
        for (const row of rows) {
          if (ids.includes(row.id)) {
            Object.assign(row, data);
          }
        }
        return { count: ids.length };
      },
      async update({ where, data }: any) {
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      async deleteMany({ where }: any) {
        const cutoff: Date = where.publishedAt?.lte;
        const before = rows.length;
        const toDelete = rows.filter(
          (r) => r.status === "PUBLISHED" && r.publishedAt && r.publishedAt <= cutoff,
        );
        for (const r of toDelete) {
          rows.splice(rows.indexOf(r), 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

/** Minimal Redis mock with xadd support. */
function buildMockRedis(shouldFail = false) {
  const added: any[] = [];
  return {
    added,
    async xadd(...args: any[]) {
      if (shouldFail) throw new Error("Redis XADD failed");
      added.push(args);
      return "0-1";
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OutboxRelayWorker (Issue #438)", () => {
  it("publishes PENDING events and marks them PUBLISHED", async () => {
    const rows = [makeRow()];
    const db = buildMockDb(rows);
    const redis = buildMockRedis();
    const worker = new OutboxRelayWorker(db as any, redis as any);

    await worker.poll();

    assert.equal(rows[0].status, "PUBLISHED");
    assert.ok(rows[0].publishedAt instanceof Date);
    assert.equal(rows[0].attempts, 1);
    assert.equal(redis.added.length, 1);
  });

  it("increments attempts and sets FAILED on Redis error", async () => {
    const rows = [makeRow()];
    const db = buildMockDb(rows);
    const redis = buildMockRedis(true); // will throw
    const worker = new OutboxRelayWorker(db as any, redis as any);

    await worker.poll();

    assert.equal(rows[0].status, "FAILED");
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].publishedAt, null);
  });

  it("marks a row DEAD after MAX_ATTEMPTS failures", async () => {
    // MAX_ATTEMPTS defaults to 5; set attempts to 4 so this poll is the 5th
    const rows = [makeRow({ status: "FAILED", attempts: 4 })];
    const db = buildMockDb(rows);
    const redis = buildMockRedis(true);
    const worker = new OutboxRelayWorker(db as any, redis as any);

    await worker.poll();

    assert.equal(rows[0].status, "DEAD");
    assert.equal(rows[0].attempts, 5);
  });

  it("skips rows whose nextRetryAt is in the future", async () => {
    const rows = [
      makeRow({ nextRetryAt: new Date(Date.now() + 60_000) }), // future
    ];
    const db = buildMockDb(rows);
    const redis = buildMockRedis();
    const worker = new OutboxRelayWorker(db as any, redis as any);

    await worker.poll();

    assert.equal(rows[0].status, "PENDING"); // untouched
    assert.equal(redis.added.length, 0);
  });

  it("cleans up old PUBLISHED rows", async () => {
    const twodays = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const rows = [
      makeRow({ status: "PUBLISHED", publishedAt: twodays }),
      makeRow({ status: "PUBLISHED", publishedAt: twodays }),
    ];
    const db = buildMockDb(rows);
    const redis = buildMockRedis();
    const worker = new OutboxRelayWorker(db as any, redis as any);

    await worker.poll();

    assert.equal(rows.length, 0, "both old PUBLISHED rows should be cleaned up");
  });

  it("processes multiple events in one poll cycle", async () => {
    const rows = [makeRow(), makeRow(), makeRow()];
    const db = buildMockDb(rows);
    const redis = buildMockRedis();
    const worker = new OutboxRelayWorker(db as any, redis as any);

    await worker.poll();

    for (const row of rows) {
      assert.equal(row.status, "PUBLISHED");
    }
    assert.equal(redis.added.length, 3);
  });

  it("start/stop are idempotent", () => {
    const db = buildMockDb([]);
    const redis = buildMockRedis();
    const worker = new OutboxRelayWorker(db as any, redis as any);

    worker.start();
    worker.start(); // second call is a no-op
    worker.stop();
    worker.stop(); // second call is a no-op
  });
});
