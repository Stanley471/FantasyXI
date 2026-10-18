import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ExistingPartition,
  PartitionManager,
  PartitionedTableSpec,
  SqlExecutor,
  buildCreatePartitionSql,
  formatTimestamp,
  legacyUpperBound,
  loadPartitionSettings,
  parsePartitionBound,
  planUpcomingPartitions,
  quoteIdent,
  selectArchivablePartitions,
  weekStartUtc,
} from "../services/partitioning/partitionManager.js";
import { PartitionRotationWorker } from "../services/partitioning/partitionRotationWorker.js";
import { LiveScoreIngestionDaemon } from "../services/live/liveTimelineService.js";

const DAY = 24 * 60 * 60 * 1000;
const weekly: PartitionedTableSpec = {
  table: "contract_events",
  column: "created_at",
  strategy: "weekly",
  primaryKey: ["id", "created_at"],
};
const byGameweek: PartitionedTableSpec = {
  table: "live_match_events",
  column: "gameweek_id",
  strategy: "gameweek",
  primaryKey: ["id", "gameweek_id"],
};
const settings = { lookaheadDays: 14, retentionDays: 90, archiveTablespace: null, lockTimeoutMs: 5000 };
const now = new Date("2026-10-17T12:00:00Z"); // a Saturday

function partition(name: string, from: number | null, to: number | null, detachPending = false): ExistingPartition {
  return { schema: "partitions", name, range: { from, to }, detachPending };
}

describe("Partition planning helpers", () => {
  it("aligns weeks to Monday 00:00 UTC", () => {
    assert.equal(new Date(weekStartUtc(now.getTime())).toISOString(), "2026-10-12T00:00:00.000Z");
    const monday = Date.parse("2026-10-19T00:00:00Z");
    assert.equal(weekStartUtc(monday), monday);
    assert.equal(formatTimestamp(monday), "2026-10-19 00:00:00");
  });

  it("parses PostgreSQL partition bounds", () => {
    assert.deepEqual(
      parsePartitionBound("FOR VALUES FROM ('2026-10-12 00:00:00') TO ('2026-10-19 00:00:00')", "weekly"),
      { from: Date.parse("2026-10-12T00:00:00Z"), to: Date.parse("2026-10-19T00:00:00Z") }
    );
    assert.deepEqual(
      parsePartitionBound("FOR VALUES FROM (MINVALUE) TO ('2026-10-26 00:00:00+00')", "weekly"),
      { from: null, to: Date.parse("2026-10-26T00:00:00Z") }
    );
    assert.deepEqual(parsePartitionBound("FOR VALUES FROM (11) TO (12)", "gameweek"), { from: 11, to: 12 });
    assert.equal(parsePartitionBound("DEFAULT", "gameweek"), null);
  });

  it("pre-allocates every week within the 14-day lookahead", () => {
    const planned = planUpcomingPartitions(weekly, [], now, settings);
    assert.deepEqual(planned.map((p) => p.name), [
      "contract_events_p20261012",
      "contract_events_p20261019",
      "contract_events_p20261026",
    ]);
    assert.equal(planned[2].range.to - planned[2].range.from, 7 * DAY);
  });

  it("skips weeks already covered, including by the legacy partition", () => {
    const existing = [partition("contract_events_legacy", null, Date.parse("2026-10-26T00:00:00Z"))];
    assert.deepEqual(
      planUpcomingPartitions(weekly, existing, now, settings).map((p) => p.name),
      ["contract_events_p20261026"]
    );
  });

  it("does not count a partition being detached as coverage", () => {
    const existing = [partition("contract_events_p20261012", Date.parse("2026-10-12T00:00:00Z"), Date.parse("2026-10-19T00:00:00Z"), true)];
    assert.ok(planUpcomingPartitions(weekly, existing, now, settings).some((p) => p.name === "contract_events_p20261012"));
  });

  it("pre-allocates gameweek partitions whose deadline is within 14 days", () => {
    const gameweeks = [10, 11, 12, 13].map((id) => ({
      id,
      deadline: new Date(Date.parse("2026-10-17T10:00:00Z") + (id - 10) * 7 * DAY),
      isFinished: false,
    }));
    const planned = planUpcomingPartitions(byGameweek, [partition("live_match_events_gw10", 10, 11)], now, settings, gameweeks);
    assert.deepEqual(planned.map((p) => p.name), ["live_match_events_gw11", "live_match_events_gw12"]);
    assert.deepEqual(planned[0].range, { from: 11, to: 12 });
  });

  it("archives weekly partitions only once their whole range is past retention", () => {
    const cutoff = now.getTime() - 90 * DAY;
    const expired = partition("contract_events_old", cutoff - 7 * DAY, cutoff);
    const straddling = partition("contract_events_mid", cutoff - DAY, cutoff + 6 * DAY);
    const legacy = partition("contract_events_legacy", null, cutoff - 14 * DAY);
    const selected = selectArchivablePartitions(weekly, [expired, straddling, legacy], now, settings);
    assert.deepEqual(selected.map((p) => p.name).sort(), ["contract_events_legacy", "contract_events_old"]);
  });

  it("archives gameweek partitions only when every gameweek is finished and old", () => {
    const old = new Date(now.getTime() - 120 * DAY);
    const gameweeks = [
      { id: 1, deadline: old, isFinished: true },
      { id: 2, deadline: old, isFinished: false },
      { id: 3, deadline: new Date(now.getTime() - 10 * DAY), isFinished: true },
    ];
    const selected = selectArchivablePartitions(
      byGameweek,
      [partition("gw1", 1, 2), partition("gw2", 2, 3), partition("gw3", 3, 4), partition("gw99", 99, 100)],
      now,
      settings,
      gameweeks
    );
    assert.deepEqual(selected.map((p) => p.name), ["gw1"]);
  });

  it("places the legacy bound past rows that may be written during conversion", () => {
    assert.equal(
      legacyUpperBound(weekly, now, Date.parse("2026-10-17T11:00:00Z")),
      Date.parse("2026-10-26T00:00:00Z")
    );
    const gameweeks = [9, 10, 11].map((id) => ({
      id,
      deadline: new Date(Date.parse("2026-10-10T10:00:00Z") + (id - 9) * 7 * DAY),
      isFinished: false,
    }));
    assert.equal(legacyUpperBound(byGameweek, now, 7, gameweeks), 11);
    assert.equal(legacyUpperBound(byGameweek, now, null, []), 1);
  });

  it("builds quoted CREATE PARTITION statements and rejects unsafe identifiers", () => {
    assert.equal(
      buildCreatePartitionSql(byGameweek, { name: "live_match_events_gw11", range: { from: 11, to: 12 } }),
      `CREATE TABLE IF NOT EXISTS "partitions"."live_match_events_gw11" PARTITION OF "public"."live_match_events" FOR VALUES FROM (11) TO (12)`
    );
    assert.throws(() => quoteIdent(`events"; DROP TABLE users; --`), /unsafe SQL identifier/);
    assert.throws(() => quoteIdent("Users"), /unsafe SQL identifier/);
  });

  it("reads lookahead and retention from the environment with safe defaults", () => {
    assert.deepEqual(loadPartitionSettings({}), settings);
    const custom = loadPartitionSettings({ PARTITION_LOOKAHEAD_DAYS: "21", PARTITION_RETENTION_DAYS: "-5", PARTITION_ARCHIVE_TABLESPACE: "cold" });
    assert.equal(custom.lookaheadDays, 21);
    assert.equal(custom.retentionDays, 90);
    assert.equal(custom.archiveTablespace, "cold");
  });
});

/** Records statements and answers the catalog queries convertToPartitioned issues. */
function recordingExecutor(): SqlExecutor & { log: Array<{ mode: string; sql: string | string[] }> } {
  const log: Array<{ mode: string; sql: string | string[] }> = [];
  return {
    log,
    async execute(sql) {
      log.push({ mode: "autocommit", sql });
    },
    async transaction(statements) {
      log.push({ mode: "transaction", sql: statements });
    },
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("relkind")) return [{ kind: "r" }] as T[];
      if (sql.includes("max(")) return [{ maxKey: new Date("2026-10-17T11:00:00Z") }] as T[];
      if (sql.includes("pg_index")) {
        return [
          { name: "contract_events_pkey", def: "", isPrimary: true, isUnique: true, columns: ["id"] },
          {
            name: "contract_events_event_type_idx",
            def: "CREATE INDEX contract_events_event_type_idx ON public.contract_events USING btree (event_type)",
            isPrimary: false,
            isUnique: false,
            columns: ["event_type"],
          },
        ] as T[];
      }
      return [] as T[];
    },
  };
}

describe("PartitionManager zero-downtime conversion plan", () => {
  it("validates the bound and builds indexes outside the swap transaction", async () => {
    const sql = recordingExecutor();
    const report = await new PartitionManager(sql, settings).convertToPartitioned(weekly, now);
    assert.equal(report.converted, true);
    assert.equal(report.legacyUpperBound, "'2026-10-26 00:00:00'");

    const autocommit = sql.log.filter((s) => s.mode === "autocommit").map((s) => s.sql as string);
    assert.ok(autocommit.some((s) => /VALIDATE CONSTRAINT/.test(s)), "VALIDATE runs without an exclusive lock");
    assert.ok(autocommit.some((s) => /CREATE UNIQUE INDEX CONCURRENTLY/.test(s)), "new primary key index built concurrently");

    const transactions = sql.log.filter((s) => s.mode === "transaction").map((s) => s.sql as string[]);
    for (const statements of transactions) {
      assert.match(statements[0], /^SET LOCAL lock_timeout = '5000ms'$/, "every locking step fails fast");
    }
    assert.ok(transactions[0].some((s) => /CHECK .* NOT VALID$/.test(s)));

    const swap = transactions[transactions.length - 1];
    const attachAt = swap.findIndex((s) => /ATTACH PARTITION/.test(s));
    assert.ok(swap.findIndex((s) => /PARTITION BY RANGE \("created_at"\)/.test(s)) < attachAt);
    assert.ok(swap.findIndex((s) => /CREATE INDEX contract_events_event_type_idx ON "public"."contract_events"/.test(s)) < attachAt);
    assert.match(swap[attachAt], /FOR VALUES FROM \(MINVALUE\) TO \('2026-10-26 00:00:00'\)/);
    assert.ok(swap.slice(attachAt + 1).every((s) => /PARTITION OF/.test(s)), "next partitions created after attach");
    assert.ok(!swap.some((s) => /INSERT|UPDATE|DELETE/.test(s)), "no data is copied during the swap");
  });

  it("leaves an already partitioned table alone", async () => {
    const sql = recordingExecutor();
    sql.query = async <T>() => [{ kind: "p" }] as T[];
    const report = await new PartitionManager(sql, settings).convertToPartitioned(weekly, now);
    assert.equal(report.converted, false);
    assert.equal(sql.log.length, 0);
  });
});

describe("PartitionRotationWorker", () => {
  function fakeManager(overrides: Partial<Record<string, any>> = {}) {
    const calls: string[] = [];
    const manager = {
      calls,
      getTableKind: async (table: string) => (table === "contract_events" ? "p" : "r"),
      loadGameweeks: async () => [],
      ensureUpcomingPartitions: async (spec: PartitionedTableSpec) => {
        calls.push(`ensure:${spec.table}`);
        return [`${spec.table}_p20261026`];
      },
      archiveExpiredPartitions: async (spec: PartitionedTableSpec) => {
        calls.push(`archive:${spec.table}`);
        return { table: spec.table, archived: [], finalized: [] };
      },
      ...overrides,
    };
    return manager;
  }

  it("skips tables that have not been converted yet", async () => {
    const manager = fakeManager();
    const results = await new PartitionRotationWorker(manager as any, [byGameweek, weekly]).run(now);
    assert.deepEqual(results.map((r) => [r.table, r.partitioned]), [
      ["live_match_events", false],
      ["contract_events", true],
    ]);
    assert.deepEqual(manager.calls, ["ensure:contract_events", "archive:contract_events"]);
    assert.deepEqual(results[1].created, ["contract_events_p20261026"]);
  });

  it("keeps rotating other tables when one fails, then reports the failure", async () => {
    const manager = fakeManager({
      getTableKind: async () => "p",
      ensureUpcomingPartitions: async (spec: PartitionedTableSpec) => {
        if (spec.table === "live_match_events") throw new Error("lock timeout");
        manager.calls.push(`ensure:${spec.table}`);
        return [];
      },
    });
    await assert.rejects(
      new PartitionRotationWorker(manager as any, [byGameweek, weekly]).run(now),
      /live_match_events: lock timeout/
    );
    assert.ok(manager.calls.includes("ensure:contract_events"));
  });
});

describe("Live match event persistence", () => {
  const stat = {
    playerId: 11,
    gameweekId: 7,
    fixtureId: 10,
    fixtureName: "ARS vs CHE",
    minutes: 30,
    goals: 1,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    saves: 0,
    bonus: 0,
    totalPoints: 7,
    player: { displayName: "Saka", fplId: 501, position: "MID", teamId: 1, team: { shortName: "ARS" } },
  };

  it("appends new events idempotently to the partitioned log", async () => {
    const writes: any[] = [];
    const daemon = new LiveScoreIngestionDaemon({
      db: { liveMatchEvent: { createMany: async (args: any) => (writes.push(args), { count: args.data.length }) } },
      redis: null,
    });
    await daemon.processStatsUpdate(7, [stat]);

    assert.equal(writes.length, 1);
    assert.equal(writes[0].skipDuplicates, true);
    assert.deepEqual(
      { ...writes[0].data[0], payload: undefined },
      { gameweekId: 7, eventKey: "10-11-goal-1", fixtureId: 10, playerId: 11, type: "GOAL", minute: 30, pointsAwarded: 5, payload: undefined }
    );
    assert.equal(writes[0].data[0].payload.playerName, "Saka");

    // No new delta -> nothing to write
    await daemon.processStatsUpdate(7, [stat]);
    assert.equal(writes.length, 1);
  });

  it("keeps broadcasting when the event log write fails", async () => {
    const broadcasts: string[] = [];
    const daemon = new LiveScoreIngestionDaemon({
      db: { liveMatchEvent: { createMany: async () => { throw new Error("no partition of relation found for row"); } } },
      redis: null,
      gateway: { broadcast: (event: string) => { broadcasts.push(event); } },
    });
    const result = await daemon.processStatsUpdate(7, [stat]);
    assert.equal(result.matchEvents.length, 1);
    assert.deepEqual(broadcasts, ["MATCH_EVENT_OCCURRED"]);
  });
});
