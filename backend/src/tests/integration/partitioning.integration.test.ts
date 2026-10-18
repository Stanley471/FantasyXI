import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  ARCHIVE_SCHEMA,
  PARTITIONED_TABLES,
  PARTITION_SCHEMA,
  PartitionManager,
  PartitionedTableSpec,
  prismaSqlExecutor,
} from "../../services/partitioning/partitionManager.js";
import { PartitionRotationWorker } from "../../services/partitioning/partitionRotationWorker.js";

/**
 * Runs the partitioning migration against a real PostgreSQL (14+) database:
 *   DATABASE_URL=postgresql://... npm run test:integration
 * Uses its own it_* tables, so it does not touch application data. Skipped when
 * no database is reachable.
 */

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/fantasyxi?schema=public";
const DAY = 24 * 60 * 60 * 1000;

const weekly: PartitionedTableSpec = {
  table: "it_weekly_events",
  column: "created_at",
  strategy: "weekly",
  primaryKey: ["id", "created_at"],
};
const byGameweek: PartitionedTableSpec = {
  table: "it_gameweek_events",
  column: "gameweek_id",
  strategy: "gameweek",
  primaryKey: ["id", "gameweek_id"],
};

const now = new Date("2026-10-17T12:00:00Z");
const gameweeks = Array.from({ length: 38 }, (_, i) => {
  const deadline = new Date(Date.UTC(2026, 7, 15, 10) + i * 7 * DAY);
  return { id: 9000 + i + 1, deadline, isFinished: deadline.getTime() + 4 * DAY < now.getTime() };
});

let pool: pg.Pool;
let client: PrismaClient;
let manager: PartitionManager;
let skip: string | false = false;

async function dropTestTables() {
  for (const schema of ["public", PARTITION_SCHEMA, ARCHIVE_SCHEMA]) {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'it\\_%'`,
      [schema]
    );
    for (const { tablename } of rows) {
      await pool.query(`DROP TABLE IF EXISTS "${schema}"."${tablename}" CASCADE`);
    }
  }
}

async function partitionOf(table: string, where: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT DISTINCT tableoid::regclass::text AS part FROM public.${table} WHERE ${where}`);
  return rows.map((r) => r.part).sort();
}

describe("Partitioned event tables (PostgreSQL integration, issue #263)", () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    try {
      const { rows } = await pool.query("SHOW server_version_num");
      if (Number(rows[0].server_version_num) < 140000) skip = "PostgreSQL 14+ required";
    } catch (error) {
      skip = `database unreachable (${(error as Error).message})`;
      return;
    }
    client = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: url, max: 2 })) });
    manager = new PartitionManager(prismaSqlExecutor(client), {
      lookaheadDays: 14,
      retentionDays: 90,
      archiveTablespace: null,
      lockTimeoutMs: 5000,
    });
    await dropTestTables();
    await pool.query(`
      CREATE TABLE public.it_weekly_events (
        id text NOT NULL PRIMARY KEY,
        kind text NOT NULL,
        payload jsonb,
        created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    await pool.query(`CREATE INDEX it_weekly_events_kind_idx ON public.it_weekly_events (kind)`);
    await pool.query(`
      INSERT INTO public.it_weekly_events (id, kind, payload, created_at)
      SELECT 'seed-' || g, 'deposit', jsonb_build_object('n', g), timestamp '2026-10-17 12:00' - (g || ' hours')::interval
        FROM generate_series(1, 3000) g`);

    await pool.query(`
      CREATE TABLE public.it_gameweek_events (
        id text NOT NULL PRIMARY KEY,
        gameweek_id integer NOT NULL,
        event_key text NOT NULL
      )`);
    await pool.query(`CREATE UNIQUE INDEX it_gameweek_events_key ON public.it_gameweek_events (gameweek_id, event_key)`);
  });

  after(async () => {
    if (!skip) {
      await dropTestTables();
      await client.$disconnect();
    }
    await pool.end();
  });

  it("converts a populated table while concurrent writers keep inserting", async (t) => {
    if (skip) return t.skip(skip);

    let stop = false;
    let written = 0;
    const errors: string[] = [];
    const writer = (async () => {
      const conn = await pool.connect();
      try {
        while (!stop) {
          try {
            await conn.query(
              `INSERT INTO public.it_weekly_events (id, kind) VALUES ($1, 'live')`,
              [`live-${written}`]
            );
            written++;
          } catch (error) {
            errors.push((error as Error).message);
          }
        }
      } finally {
        conn.release();
      }
    })();

    // Let the writer get going, convert, then keep writing a little longer
    await new Promise((resolve) => setTimeout(resolve, 100));
    const report = await manager.convertToPartitioned(weekly, now);
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop = true;
    await writer;

    assert.equal(report.converted, true);
    assert.deepEqual(errors, [], "no insert failed during the conversion");
    assert.ok(written > 0);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public.it_weekly_events`);
    assert.equal(rows[0].n, 3000 + written, "no row lost or duplicated");

    const kind = await manager.getTableKind(weekly.table);
    assert.equal(kind, "p");
    const { rows: pk } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.it_weekly_events'::regclass AND contype = 'p'`
    );
    assert.equal(pk[0].def, "PRIMARY KEY (id, created_at)");

    // Re-running is a no-op
    const again = await manager.convertToPartitioned(weekly, now);
    assert.equal(again.converted, false);
  });

  it("routes inserts across partition boundaries to the right partition", async (t) => {
    if (skip) return t.skip(skip);

    await pool.query(`
      INSERT INTO public.it_weekly_events (id, kind, created_at) VALUES
        ('b-1', 'boundary', '2026-10-25 23:59:59.999'),
        ('b-2', 'boundary', '2026-10-26 00:00:00'),
        ('b-3', 'boundary', '2026-11-01 23:59:59.999')`);

    assert.deepEqual(await partitionOf(weekly.table, `id = 'b-1'`), [`${PARTITION_SCHEMA}.it_weekly_events_legacy`]);
    assert.deepEqual(await partitionOf(weekly.table, `id IN ('b-2', 'b-3')`), [`${PARTITION_SCHEMA}.it_weekly_events_p20261026`]);

    // Reads through the parent see every partition; a range query prunes to one
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public.it_weekly_events WHERE kind = 'boundary'`);
    assert.equal(rows[0].n, 3);
    const plan = await pool.query(
      `EXPLAIN SELECT * FROM public.it_weekly_events WHERE created_at >= '2026-10-26' AND created_at < '2026-10-27'`
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(text, /it_weekly_events_p20261026/);
    assert.doesNotMatch(text, /it_weekly_events_legacy/, "partition pruning skips the legacy partition");
  });

  it("rejects a row outside every partition instead of losing it", async (t) => {
    if (skip) return t.skip(skip);
    await assert.rejects(
      pool.query(`INSERT INTO public.it_weekly_events (id, kind, created_at) VALUES ('far', 'x', '2030-01-01')`),
      /no partition of relation/
    );
  });

  it("pre-allocates partitions 14 days ahead as time moves forward", async (t) => {
    if (skip) return t.skip(skip);

    const worker = new PartitionRotationWorker(manager, [weekly]);
    const later = new Date("2026-11-20T08:00:00Z");
    const [result] = await worker.run(later);

    // Weeks starting 2026-11-16 .. 2026-11-30 cover [Nov 20, Dec 4]; weeks that
    // are already over are not back-filled
    assert.deepEqual(result.created, [
      "it_weekly_events_p20261116",
      "it_weekly_events_p20261123",
      "it_weekly_events_p20261130",
    ]);
    const [again] = await worker.run(later);
    assert.deepEqual(again.created, [], "idempotent");

    await pool.query(`INSERT INTO public.it_weekly_events (id, kind, created_at) VALUES ('dec', 'x', '2026-12-03 18:00')`);
    assert.deepEqual(await partitionOf(weekly.table, `id = 'dec'`), [`${PARTITION_SCHEMA}.it_weekly_events_p20261130`]);
  });

  it("detaches and archives partitions older than 90 days without dropping data", async (t) => {
    if (skip) return t.skip(skip);

    const before = (await pool.query(`SELECT count(*)::int AS n FROM public.it_weekly_events`)).rows[0].n;
    const legacyRows = (
      await pool.query(`SELECT count(*)::int AS n FROM ${PARTITION_SCHEMA}.it_weekly_events_legacy`)
    ).rows[0].n;

    // Cutoff 2027-02-01 - 90 days = 2026-11-03: the legacy partition (ends 2026-10-26)
    // and the 2026-10-26 week (ends 2026-11-02) have expired; later weeks have not.
    const report = await manager.archiveExpiredPartitions(weekly, new Date("2027-02-01T00:00:00Z"));
    assert.deepEqual(report.archived.sort(), ["it_weekly_events_legacy", "it_weekly_events_p20261026"]);

    const archived = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'it_weekly_events%' ORDER BY 1`,
      [ARCHIVE_SCHEMA]
    );
    assert.deepEqual(archived.rows.map((r) => r.tablename), ["it_weekly_events_legacy", "it_weekly_events_p20261026"]);

    const archivedRows = (
      await pool.query(`SELECT count(*)::int AS n FROM ${ARCHIVE_SCHEMA}.it_weekly_events_legacy`)
    ).rows[0].n;
    assert.equal(archivedRows, legacyRows, "archived partition keeps its rows");

    const after = (await pool.query(`SELECT count(*)::int AS n FROM public.it_weekly_events`)).rows[0].n;
    assert.equal(after, before - legacyRows - 2, "live table only serves non-archived rows");

    const { rows: compression } = await pool.query(
      `SELECT attcompression FROM pg_attribute
        WHERE attrelid = '${ARCHIVE_SCHEMA}.it_weekly_events_legacy'::regclass AND attname = 'payload'`
    );
    assert.ok(["l", "p"].includes(compression[0].attcompression), "archived TOAST columns get a compression method");
  });

  it("partitions by gameweek, pre-creating gameweeks whose deadline is within 14 days", async (t) => {
    if (skip) return t.skip(skip);

    await pool.query(
      `INSERT INTO public.it_gameweek_events (id, gameweek_id, event_key) VALUES ('old-1', 9005, 'goal-1'), ('cur-1', 9010, 'goal-1')`
    );
    // Gameweek bounds come from the real gameweeks table during conversion, so
    // pass the synthetic season explicitly to the steps that accept it.
    const converted = await manager.convertToPartitioned(byGameweek, now);
    assert.equal(converted.converted, true);

    const created = await manager.ensureUpcomingPartitions(byGameweek, now, gameweeks);
    // GW 9011 (deadline 2026-10-24) and 9012 (2026-10-31) are within 14 days of 2026-10-17
    assert.ok(created.includes("it_gameweek_events_gw9011"));
    assert.ok(created.includes("it_gameweek_events_gw9012"));
    assert.ok(!created.includes("it_gameweek_events_gw9013"));

    await pool.query(`INSERT INTO public.it_gameweek_events (id, gameweek_id, event_key) VALUES ('n-1', 9011, 'goal-1'), ('n-2', 9012, 'goal-1')`);
    assert.deepEqual(await partitionOf(byGameweek.table, `id = 'n-1'`), [`${PARTITION_SCHEMA}.it_gameweek_events_gw9011`]);

    // The idempotency key still works through the parent
    const dup = await pool.query(
      `INSERT INTO public.it_gameweek_events (id, gameweek_id, event_key) VALUES ('n-3', 9011, 'goal-1') ON CONFLICT DO NOTHING`
    );
    assert.equal(dup.rowCount, 0);
  });

  it("lets the Prisma models read and write across partitions unchanged", async (t) => {
    if (skip) return t.skip(skip);
    const [liveEvents, contractEvents] = ["live_match_events", "contract_events"].map(
      (table) => PARTITIONED_TABLES.find((spec) => spec.table === table)!
    );
    const kinds = await Promise.all([liveEvents, contractEvents].map((s) => manager.getTableKind(s.table)));
    if (kinds.includes(null)) return t.skip("application schema not pushed (run prisma db push)");

    await manager.convertToPartitioned(contractEvents, new Date());
    await manager.convertToPartitioned(liveEvents, new Date());
    const synthetic = [{ id: 990001, deadline: new Date(), isFinished: false }, { id: 990002, deadline: new Date(), isFinished: false }];
    const created = await manager.ensureUpcomingPartitions(liveEvents, new Date(), synthetic);

    try {
      const rows = [990001, 990002].map((gameweekId) => ({
        gameweekId,
        eventKey: "it-1-goal-1",
        fixtureId: 1,
        playerId: 1,
        type: "GOAL",
        minute: 10,
        pointsAwarded: 5,
      }));
      assert.equal((await client.liveMatchEvent.createMany({ data: rows, skipDuplicates: true })).count, 2);
      // Same deterministic keys again: the cross-partition unique key makes the write idempotent
      assert.equal((await client.liveMatchEvent.createMany({ data: rows, skipDuplicates: true })).count, 0);
      const read = await client.liveMatchEvent.findMany({ where: { gameweekId: { in: [990001, 990002] } } });
      assert.equal(read.length, 2);

      const event = await client.contractEvent.create({
        data: { eventType: "it_probe", txHash: "it-tx", ledgerSeq: 1 },
      });
      const found = await client.contractEvent.findMany({ where: { eventType: "it_probe" } });
      assert.equal(found.length, 1);
      assert.equal(found[0].id, event.id);
    } finally {
      await pool.query(`DELETE FROM public.live_match_events WHERE gameweek_id IN (990001, 990002)`);
      await pool.query(`DELETE FROM public.contract_events WHERE event_type = 'it_probe'`);
      for (const name of created) await pool.query(`DROP TABLE IF EXISTS ${PARTITION_SCHEMA}."${name}"`);
    }
  });

  it("rolls back to a plain table with every live row", async (t) => {
    if (skip) return t.skip(skip);

    const before = (await pool.query(`SELECT count(*)::int AS n FROM public.it_gameweek_events`)).rows[0].n;
    const result = await manager.revertToPlain(byGameweek);
    assert.equal(result.reverted, true);
    assert.equal(await manager.getTableKind(byGameweek.table), "r");

    const after = (await pool.query(`SELECT count(*)::int AS n FROM public.it_gameweek_events`)).rows[0].n;
    assert.equal(after, before);
    const { rows: indexes } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'it_gameweek_events' ORDER BY 1`
    );
    assert.deepEqual(indexes.map((r) => r.indexname), ["it_gameweek_events_key", "it_gameweek_events_pkey"]);

    // ...and can be rolled forward again
    const again = await manager.convertToPartitioned(byGameweek, now);
    assert.equal(again.converted, true);
  });
});
