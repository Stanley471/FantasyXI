/**
 * Query-plan benchmark: unpartitioned vs partitioned event table (issue #263).
 *
 * Builds two scratch tables with identical rows and indexes (one plain, one
 * weekly-partitioned through PartitionManager), then compares EXPLAIN ANALYZE
 * output for the hot-path queries of a live event log:
 *   - recent window read (last hour), which partition pruning keeps constant
 *   - single-row insert into the current week
 * The scratch tables are dropped afterwards.
 *
 *   BENCH_ROWS=2000000 BENCH_WEEKS=26 npm run db:benchmark-partitions
 */

import "dotenv/config";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PARTITION_SCHEMA,
  PartitionManager,
  prismaSqlExecutor,
} from "../services/partitioning/partitionManager.js";

const ROWS = Number(process.env.BENCH_ROWS) || 500_000;
const WEEKS = Number(process.env.BENCH_WEEKS) || 26;
const RUNS = Number(process.env.BENCH_RUNS) || 20;
const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/fantasyxi?schema=public";

const TABLES = ["bench_events_plain", "bench_events_partitioned"] as const;

async function createTable(pool: pg.Pool, table: string, rows: number): Promise<void> {
  await pool.query(`
    CREATE TABLE public.${table} (
      id text NOT NULL,
      event_type text NOT NULL,
      payload jsonb,
      created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, created_at)
    )`);
  await pool.query(`CREATE INDEX ${table}_created_at_idx ON public.${table} (created_at)`);
  await pool.query(`
    INSERT INTO public.${table} (id, event_type, payload, created_at)
    SELECT 'e' || g, 'goal', jsonb_build_object('n', g),
           now()::timestamp(3) - make_interval(secs => (g::float / ${ROWS}) * ${WEEKS * 7 * 86400})
      FROM generate_series(1, ${rows}) g`);
  await pool.query(`ANALYZE public.${table}`);
}

async function median(pool: pg.Pool, sql: string): Promise<{ ms: number; plan: string }> {
  const timings: number[] = [];
  let plan = "";
  for (let i = 0; i < RUNS; i++) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    const result = rows[0]["QUERY PLAN"][0];
    timings.push(result["Execution Time"]);
    if (i === 0) {
      const text = await pool.query(`EXPLAIN ${sql}`);
      plan = text.rows.map((r) => r["QUERY PLAN"]).join("\n");
    }
  }
  timings.sort((a, b) => a - b);
  return { ms: timings[Math.floor(timings.length / 2)], plan };
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: url, max: 2 })) });
  const manager = new PartitionManager(prismaSqlExecutor(client));

  try {
    for (const table of TABLES) await pool.query(`DROP TABLE IF EXISTS public.${table} CASCADE`);
    console.log(`[bench] Loading ${ROWS} rows spread over ${WEEKS} weeks into each table...`);
    await createTable(pool, "bench_events_plain", ROWS);

    // Partition an empty copy first (converting a populated table would keep all
    // history in one legacy partition), then load the same rows into weekly partitions.
    await createTable(pool, "bench_events_partitioned", 0);
    const spec = { table: "bench_events_partitioned", column: "created_at", strategy: "weekly" as const, primaryKey: ["id", "created_at"] };
    const start = new Date(Date.now() - (WEEKS + 1) * 7 * 24 * 60 * 60 * 1000);
    await manager.convertToPartitioned(spec, start);
    for (let week = 0; week <= WEEKS + 2; week++) {
      await manager.ensureUpcomingPartitions(spec, new Date(start.getTime() + week * 7 * 24 * 60 * 60 * 1000));
    }
    await pool.query(`INSERT INTO public.bench_events_partitioned SELECT * FROM public.bench_events_plain`);
    await pool.query(`ANALYZE public.bench_events_partitioned`);

    const partitions = await manager.listPartitions(spec);
    console.log(`[bench] Partitioned table has ${partitions.length} partitions`);

    const results = [];
    for (const table of TABLES) {
      const recent = await median(
        pool,
        `SELECT count(*) FROM public.${table} WHERE created_at >= now() - interval '1 hour'`
      );
      const insert = await median(
        pool,
        `INSERT INTO public.${table} (id, event_type) VALUES (gen_random_uuid()::text, 'goal')`
      );
      results.push({ table, "recent window read (ms, p50)": recent.ms, "insert (ms, p50)": insert.ms });
      console.log(`\n[bench] ${table} recent-window plan:\n${recent.plan}`);
    }
    console.table(results);
  } finally {
    for (const table of TABLES) {
      await pool.query(`DROP TABLE IF EXISTS public.${table} CASCADE`);
    }
    await pool.query(
      `DO $$ DECLARE r record; BEGIN
         FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '${PARTITION_SCHEMA}' AND tablename LIKE 'bench\\_events%' LOOP
           EXECUTE format('DROP TABLE IF EXISTS ${PARTITION_SCHEMA}.%I CASCADE', r.tablename);
         END LOOP; END $$`
    );
    await client.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[bench] Failed:", error.message);
  process.exitCode = 1;
});
