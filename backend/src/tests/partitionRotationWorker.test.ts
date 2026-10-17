import test from "node:test";
import assert from "node:assert/strict";
import {
  PartitionRotationWorker,
  PartitionBounds,
  assertSafeSqlIdentifier,
} from "../workers/partitionRotationWorker.js";

test("PartitionRotationWorker: pre-allocates 14 contiguous daily partitions and detaches >90-day-old partitions concurrently", async () => {
  const executedSql: string[] = [];
  const existingPartitions: PartitionBounds[] = [
    // Expired partition (100 days before 2026-10-18 -> 2026-07-09)
    {
      parentTable: "live_match_events",
      partitionName: "live_match_events_p_2026_07_09",
      fromIsoUtc: "2026-07-09T00:00:00.000Z",
      toIsoUtc: "2026-07-10T00:00:00.000Z",
      dateKey: "2026_07_09",
    },
    // Recent partition within 90-day retention window (10 days ago -> 2026-10-08)
    {
      parentTable: "live_match_events",
      partitionName: "live_match_events_p_2026_10_08",
      fromIsoUtc: "2026-10-08T00:00:00.000Z",
      toIsoUtc: "2026-10-09T00:00:00.000Z",
      dateKey: "2026_10_08",
    },
    // Already-created partition for today (2026-10-18)
    {
      parentTable: "live_match_events",
      partitionName: "live_match_events_p_2026_10_18",
      fromIsoUtc: "2026-10-18T00:00:00.000Z",
      toIsoUtc: "2026-10-19T00:00:00.000Z",
      dateKey: "2026_10_18",
    },
  ];

  const worker = new PartitionRotationWorker({
    parentTable: "live_match_events",
    preallocateDays: 14,
    retentionDays: 90,
    useConcurrently: true,
    executor: {
      async executeRaw(sql: string) {
        executedSql.push(sql);
      },
      async listExistingPartitions() {
        return existingPartitions;
      },
    },
  });

  const referenceNow = new Date("2026-10-18T12:00:00.000Z");
  const windowBounds = worker.buildUpcomingPartitionWindow(referenceNow);

  assert.equal(windowBounds.length, 14);
  for (let i = 1; i < windowBounds.length; i++) {
    // Contiguous non-overlapping daily boundaries
    assert.equal(windowBounds[i].fromIsoUtc, windowBounds[i - 1].toIsoUtc);
  }

  const report = await worker.runRotationCycle(referenceNow);

  // 14 upcoming days minus 1 already existing (2026-10-18) = 13 newly created partitions
  assert.equal(report.createdPartitions.length, 13);
  assert.equal(report.detachedArchives.length, 1);
  assert.equal(
    report.detachedArchives[0].partitionName,
    "live_match_events_p_2026_07_09"
  );
  assert.ok(
    report.detachedArchives[0].detachSql.includes(
      "ALTER TABLE live_match_events DETACH PARTITION live_match_events_p_2026_07_09 CONCURRENTLY;"
    )
  );
  assert.ok(
    report.detachedArchives[0].reattachRollbackSql.includes(
      "ALTER TABLE live_match_events ATTACH PARTITION live_match_events_p_2026_07_09"
    )
  );
});

test("assertSafeSqlIdentifier: rejects SQL injection payloads in table names", () => {
  assert.equal(
    assertSafeSqlIdentifier("live_match_events_p_2026_10_18"),
    "live_match_events_p_2026_10_18"
  );
  assert.throws(
    () => assertSafeSqlIdentifier("live_events; DROP TABLE users;--"),
    /Unsafe SQL identifier rejected/
  );
});
