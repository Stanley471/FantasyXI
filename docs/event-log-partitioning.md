# Event-Log Partitioning and Rotation

High-velocity event tables are range-partitioned in PostgreSQL so that live
matchdays keep inserts and recent reads fast, and so that old data can be
archived by detaching a partition instead of running a large `DELETE`.

| Table | Partition key | Granularity | Written by |
| :--- | :--- | :--- | :--- |
| `live_match_events` | `gameweek_id` | one partition per gameweek | live score ingestion daemon |
| `contract_events` | `created_at` | one partition per UTC week (Monday 00:00) | Soroban event indexer |

The parent tables keep their names in the `public` schema, so the Prisma models
(`LiveMatchEvent`, `ContractEvent`) and every query work unchanged: PostgreSQL
routes each insert to the right partition and prunes partitions on reads.
Partitions live in the `partitions` schema and archived ones in
`partition_archive`, which keeps them out of Prisma's view of `public`
(`prisma db push` and `prisma migrate diff` report no changes after conversion).

The partition key is part of each table's primary key, as PostgreSQL requires.
For `live_match_events`, `(gameweek_id, event_key)` is also unique, which makes
the daemon's writes idempotent across restarts.

---

## 1. Converting the tables (roll forward)

```bash
cd backend
npm run db:partition -- status     # plain / partitioned, and the partition layout
npm run db:partition -- convert    # both tables (or: convert contract_events)
```

`convert` is idempotent and does not take the tables offline:

1. Adds a `CHECK (key < bound)` constraint `NOT VALID` (instant), then
   `VALIDATE`s it under `SHARE UPDATE EXCLUSIVE`, which allows reads and writes.
2. If the primary key does not include the partition key yet, builds the new
   key's index `CONCURRENTLY` and swaps it in as a metadata-only change.
3. In one short transaction: renames the table into the `partitions` schema as
   the *legacy* partition, creates the partitioned parent with the same columns
   and indexes, and `ATTACH`es the legacy table for `[MINVALUE, bound)`. The
   validated constraint lets PostgreSQL skip the attach scan, and the existing
   indexes are reused. The next partitions are created in the same step.

Every step that needs an `ACCESS EXCLUSIVE` lock runs with `lock_timeout`
(`PARTITION_LOCK_TIMEOUT_MS`, default 5s): behind a long-running query it fails
fast and can be re-run, instead of queueing all other traffic behind it.

**Deployment order.** `prisma db push` creates `live_match_events`; run `convert`
afterwards. On a database where `contract_events` already holds many rows, run
`npm run db:partition -- convert contract_events` **before** `prisma db push`:
the conversion swaps in the `(id, created_at)` primary key using a concurrently
built index, whereas `db push` would rebuild it under an exclusive lock.

## 2. Rotation worker

The `partition-rotation` job (hourly, `queues/jobQueue.ts`) runs
`PartitionRotationWorker`, which for each partitioned table:

1. finalizes any `DETACH ... CONCURRENTLY` that was interrupted;
2. pre-creates every partition needed within `PARTITION_LOOKAHEAD_DAYS`
   (default 14): the coming weeks for `contract_events`, and every gameweek
   whose deadline falls in the window for `live_match_events`;
3. archives partitions whose data is entirely older than
   `PARTITION_RETENTION_DAYS` (default 90): `DETACH PARTITION ... CONCURRENTLY`,
   move to `partition_archive`, set `lz4` TOAST compression, optionally move to
   `PARTITION_ARCHIVE_TABLESPACE`, then `VACUUM (FULL, ANALYZE)` (safe, since a
   detached table serves no traffic). A gameweek partition is archived only once
   every gameweek in it is finished.

Tables that have not been converted are skipped. Archived tables are never
dropped; they remain queryable (`SELECT ... FROM partition_archive.<name>`).

PostgreSQL has no native table-level compression: `lz4` applies to TOASTed
values written from then on, and `VACUUM FULL` compacts the pages. For
storage-level compression, point `PARTITION_ARCHIVE_TABLESPACE` at a tablespace
on a compressed volume.

There is no DEFAULT partition, because PostgreSQL does not allow
`DETACH ... CONCURRENTLY` when one exists. A row outside every partition is
rejected (`no partition of relation ... found for row`) rather than silently
mis-filed; the 14-day lookahead keeps this from happening in normal operation,
and the live daemon treats event-log writes as best-effort so broadcasting
continues regardless.

## 3. Rollback

```bash
npm run db:partition -- rollback contract_events
```

Copies the rows of every attached partition into a new plain table under an
exclusive lock (writes to that table pause for the duration of the copy), swaps
it in under the original name with the original indexes, and keeps the
partitioned table in the `partitions` schema for inspection. Archived
partitions stay in `partition_archive`. Rolling forward again with `convert`
works after a rollback.

## 4. Verification

- `npm run test:integration` (needs `DATABASE_URL`, PostgreSQL 14+) runs
  `src/tests/integration/partitioning.integration.test.ts`: conversion while a
  concurrent writer keeps inserting (no failed or lost writes), inserts across
  partition boundaries, partition pruning, 14-day pre-allocation, 90-day
  archival, gameweek partitioning, Prisma reads and writes through the parent,
  and rollback followed by roll-forward.
- `npm run db:benchmark-partitions` loads the same rows into a plain and a
  weekly-partitioned table and prints `EXPLAIN ANALYZE` plans and median
  timings for a recent-window read and a single-row insert
  (`BENCH_ROWS`, `BENCH_WEEKS`, `BENCH_RUNS`).
