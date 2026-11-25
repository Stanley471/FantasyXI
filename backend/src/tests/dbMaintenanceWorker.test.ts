import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  DbMaintenanceWorker,
  type DbMaintenanceOptions,
  type TableBloatInfo,
  type IndexBloatInfo,
  type MaintenanceRun,
} from "../workers/dbMaintenanceWorker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fixed UTC Date whose hour matches the supplied value. */
function utcHour(hour: number): Date {
  return new Date(`2026-01-01T${String(hour).padStart(2, "0")}:00:00Z`);
}

/**
 * Builds a mock database whose $queryRawUnsafe and $executeRawUnsafe
 * delegates can be replaced per-test via `override`.
 */
function makeMockDb(
  queryImpl?: (...args: unknown[]) => Promise<unknown>,
  execImpl?: (...args: unknown[]) => Promise<unknown>,
) {
  return {
    $queryRawUnsafe: mock.fn(queryImpl ?? (async () => [])),
    $executeRawUnsafe: mock.fn(execImpl ?? (async () => 1)),
  };
}

/** Minimal bloated-table row returned by the analysis query. */
function bloatedTableRows() {
  return [
    {
      schemaname: "public",
      tablename: "entries",
      n_live_tup: BigInt(7000),
      n_dead_tup: BigInt(3000),
      dead_tuple_ratio: 0.3,       // exactly at the default 30 % threshold — below, so NOT selected
      last_vacuum: null,
      last_autovacuum: null,
    },
    {
      schemaname: "public",
      tablename: "scores",
      n_live_tup: BigInt(5000),
      n_dead_tup: BigInt(5000),
      dead_tuple_ratio: 0.5,       // 50 % — above threshold, should be vacuumed
      last_vacuum: new Date("2026-01-01T01:00:00Z"),
      last_autovacuum: null,
    },
  ];
}

/** Minimal bloated-index row returned by the analysis query. */
function bloatedIndexRows() {
  return [
    {
      schemaname: "public",
      tablename: "scores",
      indexname: "scores_user_id_idx",
      index_size_bytes: BigInt(1_048_576),   // 1 MiB
      bloat_pct: 45,
    },
  ];
}

/** Zero-lock query result (no active long-running queries). */
const noLocks = [{ count: BigInt(0) }];

/** Non-zero lock query result. */
const hasLocks = [{ count: BigInt(2) }];

// ---------------------------------------------------------------------------
// Off-peak window scheduling
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — off-peak window", () => {
  it("returns false outside the window (noon UTC)", () => {
    const worker = new DbMaintenanceWorker({ now: () => utcHour(12) });
    assert.equal(worker.isWithinOffPeakWindow(), false);
  });

  it("returns true inside the window (3 AM UTC)", () => {
    const worker = new DbMaintenanceWorker({ now: () => utcHour(3) });
    assert.equal(worker.isWithinOffPeakWindow(), true);
  });

  it("returns true at the boundary start hour (2 AM UTC)", () => {
    const worker = new DbMaintenanceWorker({ now: () => utcHour(2) });
    assert.equal(worker.isWithinOffPeakWindow(), true);
  });

  it("returns false at the boundary end hour (5 AM UTC — exclusive)", () => {
    const worker = new DbMaintenanceWorker({ now: () => utcHour(5) });
    assert.equal(worker.isWithinOffPeakWindow(), false);
  });

  it("runOnce() returns withinWindow: false and no records outside the window", async () => {
    const db = makeMockDb();
    const worker = new DbMaintenanceWorker({
      db,
      now: () => utcHour(12),
    });
    const run = await worker.runOnce();
    assert.equal(run.withinWindow, false);
    assert.deepEqual(run.records, []);
    assert.equal(run.totalReclaimedBytes, 0);
  });
});

// ---------------------------------------------------------------------------
// Bloat analysis — shape validation
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — bloat analysis", () => {
  it("analyzeTableBloat() maps raw DB rows to TableBloatInfo objects", async () => {
    const db = makeMockDb(async () => bloatedTableRows());
    const worker = new DbMaintenanceWorker({ db });
    const result = await worker.analyzeTableBloat();

    assert.equal(result.length, 2);

    const first = result[0];
    assert.equal(first.schemaName, "public");
    assert.equal(first.tableName, "entries");
    assert.equal(first.liveTuples, 7000);
    assert.equal(first.deadTuples, 3000);
    assert.ok(typeof first.deadTupleRatio === "number");
    assert.equal(first.lastVacuum, null);
    assert.equal(first.lastAutoVacuum, null);

    const second = result[1];
    assert.equal(second.tableName, "scores");
    assert.ok(second.lastVacuum instanceof Date);
  });

  it("analyzeIndexBloat() maps raw DB rows to IndexBloatInfo objects", async () => {
    const db = makeMockDb(async () => bloatedIndexRows());
    const worker = new DbMaintenanceWorker({ db });
    const result = await worker.analyzeIndexBloat();

    assert.equal(result.length, 1);
    const idx = result[0];
    assert.equal(idx.schemaName, "public");
    assert.equal(idx.tableName, "scores");
    assert.equal(idx.indexName, "scores_user_id_idx");
    assert.equal(idx.indexSizeByte, 1_048_576);
    assert.equal(idx.bloatPct, 45);
  });
});

// ---------------------------------------------------------------------------
// Active lock detection
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — active lock detection", () => {
  it("checkActiveLocks() returns false when no long-running queries exist", async () => {
    const db = makeMockDb(async () => noLocks);
    const worker = new DbMaintenanceWorker({ db });
    const result = await worker.checkActiveLocks();
    assert.equal(result, false);
  });

  it("checkActiveLocks() returns true when long-running queries are present", async () => {
    const db = makeMockDb(async () => hasLocks);
    const worker = new DbMaintenanceWorker({ db });
    const result = await worker.checkActiveLocks();
    assert.equal(result, true);
  });

  it("runOnce() returns empty records when active locks are detected", async () => {
    // First call: checkActiveLocks (pg_stat_activity)  → has locks
    // analyzeTableBloat / analyzeIndexBloat are never reached
    const db = makeMockDb(async () => hasLocks);
    const worker = new DbMaintenanceWorker({
      db,
      now: () => utcHour(3),   // inside window
    });
    const run = await worker.runOnce();
    assert.equal(run.withinWindow, true);
    assert.deepEqual(run.records, []);
  });
});

// ---------------------------------------------------------------------------
// Maintenance execution — VACUUM
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — vacuumTable()", () => {
  it("returns a VACUUM record with skipped: false on success", async () => {
    // The function calls $queryRawUnsafe once (pre-vacuum dead-tuple count)
    // and $executeRawUnsafe twice (SET lock_timeout, VACUUM).
    const db = makeMockDb(
      async () => [{ n_dead_tup: BigInt(1000) }],  // dead-tuple pre-count
      async () => 1,
    );
    const worker = new DbMaintenanceWorker({ db, now: () => utcHour(3) });
    const record = await worker.vacuumTable("public", "scores");

    assert.equal(record.operation, "VACUUM");
    assert.equal(record.target, "public.scores");
    assert.equal(record.skipped, false);
    assert.equal(record.skipReason, undefined);
    assert.ok(record.durationMs >= 0);
    // 1000 dead tuples × 100 bytes each
    assert.equal(record.reclaimedBytes, 100_000);
  });

  it("returns skipped: true with skipReason 'lock-timeout' on lock error", async () => {
    const db = {
      $queryRawUnsafe: mock.fn(async () => [{ n_dead_tup: BigInt(0) }]),
      $executeRawUnsafe: mock.fn(async (sql: string) => {
        if (/VACUUM/i.test(sql)) {
          throw new Error("canceling statement due to lock timeout");
        }
        return 1;
      }),
    };
    const worker = new DbMaintenanceWorker({ db, now: () => utcHour(3) });
    const record = await worker.vacuumTable("public", "entries");

    assert.equal(record.operation, "VACUUM");
    assert.equal(record.skipped, true);
    assert.equal(record.skipReason, "lock-timeout");
    assert.ok(record.error !== undefined);
  });
});

// ---------------------------------------------------------------------------
// Maintenance execution — REINDEX
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — reindexConcurrently()", () => {
  it("returns a REINDEX record with skipped: false on success", async () => {
    const db = makeMockDb(async () => [], async () => 1);
    const worker = new DbMaintenanceWorker({ db, now: () => utcHour(3) });
    const record = await worker.reindexConcurrently("public", "scores_user_id_idx");

    assert.equal(record.operation, "REINDEX");
    assert.equal(record.target, "public.scores_user_id_idx");
    assert.equal(record.skipped, false);
    assert.ok(record.durationMs >= 0);
  });

  it("returns skipped: true with skipReason 'lock-timeout' on lock error", async () => {
    const db = {
      $queryRawUnsafe: mock.fn(async () => []),
      $executeRawUnsafe: mock.fn(async (sql: string) => {
        if (/REINDEX/i.test(sql)) {
          throw new Error("canceling statement due to lock timeout");
        }
        return 1;
      }),
    };
    const worker = new DbMaintenanceWorker({ db, now: () => utcHour(3) });
    const record = await worker.reindexConcurrently("public", "scores_user_id_idx");

    assert.equal(record.operation, "REINDEX");
    assert.equal(record.skipped, true);
    assert.equal(record.skipReason, "lock-timeout");
  });
});

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — dry-run mode", () => {
  it("produces only skipped records with skipReason 'dry-run' during runOnce()", async () => {
    // Query call order inside runOnce() (all within window + no locks):
    //   1. checkActiveLocks        → noLocks
    //   2. analyzeTableBloat       → bloated table (50 % ratio, above threshold)
    //   3. analyzeIndexBloat       → bloated index (45 %, above threshold)
    // Then vacuumTable and reindexConcurrently are called in dryRun mode.
    let callIndex = 0;
    const queryResponses: unknown[][] = [
      noLocks,                // checkActiveLocks
      bloatedTableRows(),     // analyzeTableBloat
      bloatedIndexRows(),     // analyzeIndexBloat
    ];

    const db = {
      $queryRawUnsafe: mock.fn(async () => queryResponses[callIndex++] ?? []),
      $executeRawUnsafe: mock.fn(async () => 1),
    };

    const worker = new DbMaintenanceWorker({
      db,
      now: () => utcHour(3),
      dryRun: true,
    });

    const run = await worker.runOnce();
    assert.equal(run.withinWindow, true);
    assert.ok(run.records.length > 0, "expected at least one record in dry-run");
    for (const record of run.records) {
      assert.equal(record.skipped, true, `${record.target} should be skipped in dry-run`);
      assert.equal(record.skipReason, "dry-run");
    }
    // No real SQL maintenance should have been executed.
    const execCalls = db.$executeRawUnsafe.mock.calls.map((c) => c.arguments[0] as string);
    assert.ok(
      !execCalls.some((sql) => /VACUUM|REINDEX/i.test(sql)),
      "dry-run must not execute VACUUM or REINDEX",
    );
  });
});

// ---------------------------------------------------------------------------
// Bloat threshold filtering
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — bloat threshold filtering", () => {
  it("does not vacuum tables whose dead-tuple ratio is at or below the threshold", async () => {
    // The 'entries' row has dead_tuple_ratio = 0.3 (exactly 30 %, NOT above).
    // The 'scores' row has 0.5 (above). Only 'scores' should be vacuumed.
    let callIndex = 0;
    const queryResponses: unknown[][] = [
      noLocks,
      bloatedTableRows(),   // entries: 0.3, scores: 0.5
      [],                   // analyzeIndexBloat: none
      // vacuumTable pre-count for 'scores':
      [{ n_dead_tup: BigInt(5000) }],
    ];

    const db = {
      $queryRawUnsafe: mock.fn(async () => queryResponses[callIndex++] ?? []),
      $executeRawUnsafe: mock.fn(async () => 1),
    };

    const worker = new DbMaintenanceWorker({
      db,
      now: () => utcHour(3),
      bloatThresholdPct: 30,  // default
    });

    const run = await worker.runOnce();
    const vacuumed = run.records.filter((r) => r.operation === "VACUUM");
    // Only 'scores' (50%) should appear; 'entries' (30%) is NOT above threshold.
    assert.equal(vacuumed.length, 1);
    assert.equal(vacuumed[0].target, "public.scores");
  });

  it("vacuums tables whose dead-tuple ratio is above the threshold", async () => {
    let callIndex = 0;
    const queryResponses: unknown[][] = [
      noLocks,
      [
        {
          schemaname: "public",
          tablename: "leagues",
          n_live_tup: BigInt(1000),
          n_dead_tup: BigInt(500),
          dead_tuple_ratio: 0.333,   // 33.3 % — above 30 %
          last_vacuum: null,
          last_autovacuum: null,
        },
      ],
      [],   // no index bloat
      [{ n_dead_tup: BigInt(500) }],  // pre-vacuum count for leagues
    ];

    const db = {
      $queryRawUnsafe: mock.fn(async () => queryResponses[callIndex++] ?? []),
      $executeRawUnsafe: mock.fn(async () => 1),
    };

    const worker = new DbMaintenanceWorker({
      db,
      now: () => utcHour(3),
      bloatThresholdPct: 30,
    });

    const run = await worker.runOnce();
    assert.equal(run.withinWindow, true);
    const vacuumed = run.records.filter((r) => r.operation === "VACUUM");
    assert.equal(vacuumed.length, 1);
    assert.equal(vacuumed[0].target, "public.leagues");
    assert.equal(vacuumed[0].skipped, false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: mocked bloated tables + indexes
// ---------------------------------------------------------------------------

describe("DbMaintenanceWorker — end-to-end maintenance on mocked bloated data", () => {
  it("executes VACUUM and REINDEX and tracks totalReclaimedBytes", async () => {
    // Call sequence for runOnce():
    //   $queryRawUnsafe:
    //     [0] checkActiveLocks       → noLocks
    //     [1] analyzeTableBloat      → scores (50 % dead)
    //     [2] analyzeIndexBloat      → scores_user_id_idx (45 %)
    //     [3] vacuumTable pre-count  → 5000 dead tuples for scores
    //   $executeRawUnsafe:
    //     [0] SET lock_timeout (for VACUUM)
    //     [1] VACUUM (ANALYZE) public.scores
    //     [2] SET lock_timeout (for REINDEX)
    //     [3] REINDEX INDEX CONCURRENTLY public.scores_user_id_idx

    let queryCallIndex = 0;
    const queryResponses: unknown[][] = [
      noLocks,
      // analyzeTableBloat — only 'scores' (50 %) is above the 30 % threshold
      [
        {
          schemaname: "public",
          tablename: "scores",
          n_live_tup: BigInt(5000),
          n_dead_tup: BigInt(5000),
          dead_tuple_ratio: 0.5,
          last_vacuum: null,
          last_autovacuum: null,
        },
      ],
      // analyzeIndexBloat — scores_user_id_idx at 45 % (> 30)
      [
        {
          schemaname: "public",
          tablename: "scores",
          indexname: "scores_user_id_idx",
          index_size_bytes: BigInt(1_048_576),
          bloat_pct: 45,
        },
      ],
      // vacuumTable pre-count
      [{ n_dead_tup: BigInt(5000) }],
    ];

    const db = {
      $queryRawUnsafe: mock.fn(async () => queryResponses[queryCallIndex++] ?? []),
      $executeRawUnsafe: mock.fn(async () => 1),
    };

    const worker = new DbMaintenanceWorker({
      db,
      now: () => utcHour(3),   // inside window
      bloatThresholdPct: 30,
      dryRun: false,
    });

    const run: MaintenanceRun = await worker.runOnce();

    // Window guard
    assert.equal(run.withinWindow, true);

    // Both operations should be present and not skipped
    const vacuum = run.records.find((r) => r.operation === "VACUUM");
    assert.ok(vacuum, "expected a VACUUM record");
    assert.equal(vacuum!.skipped, false);
    assert.equal(vacuum!.target, "public.scores");

    const reindex = run.records.find((r) => r.operation === "REINDEX");
    assert.ok(reindex, "expected a REINDEX record");
    assert.equal(reindex!.skipped, false);
    assert.equal(reindex!.target, "public.scores_user_id_idx");

    // 5000 dead tuples × 100 bytes = 500 000 bytes reclaimed
    assert.equal(run.totalReclaimedBytes, 500_000);
    assert.ok(run.totalReclaimedBytes > 0, "expected positive totalReclaimedBytes");

    // Verify real maintenance SQL was executed
    const execCalls = db.$executeRawUnsafe.mock.calls.map((c) => c.arguments[0] as string);
    assert.ok(execCalls.some((sql) => /VACUUM/i.test(sql)), "VACUUM should be executed");
    assert.ok(execCalls.some((sql) => /REINDEX/i.test(sql)), "REINDEX should be executed");
  });
});
