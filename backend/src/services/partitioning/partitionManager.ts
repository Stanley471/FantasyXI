import { prisma } from "../../config/db.js";

/**
 * Declarative range partitioning for high-velocity event tables (issue #263).
 *
 * Parent tables stay in the `public` schema under their original names, so
 * Prisma models and queries keep working unchanged: PostgreSQL routes every
 * INSERT to the right partition and prunes partitions on reads. The partitions
 * themselves live in the `partitions` schema (and detached ones in
 * `partition_archive`), which keeps them out of Prisma's view of `public`.
 *
 * Every DDL step here is designed not to block application traffic:
 * - conversion validates a CHECK constraint under SHARE UPDATE EXCLUSIVE, so the
 *   existing table is attached as the first partition without a full scan;
 * - indexes are built CONCURRENTLY before the swap and reused by ATTACH;
 * - the only ACCESS EXCLUSIVE locks are metadata-only and guarded by a short
 *   lock_timeout, so a long-running query makes the step fail fast (and be
 *   retried) instead of queueing every other query behind it;
 * - old partitions are removed with DETACH PARTITION ... CONCURRENTLY.
 */

export const PARTITION_SCHEMA = "partitions";
export const ARCHIVE_SCHEMA = "partition_archive";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** weekly: one partition per UTC week (Monday 00:00). gameweek: one per gameweek id. */
export type PartitionStrategy = "weekly" | "gameweek";

export interface PartitionedTableSpec {
  /** Parent table in the public schema */
  table: string;
  /** Partition key column */
  column: string;
  strategy: PartitionStrategy;
  /** Primary key columns of the partitioned table (must include the partition key) */
  primaryKey: string[];
}

/** Tables managed by the partition rotation worker. */
export const PARTITIONED_TABLES: readonly PartitionedTableSpec[] = [
  {
    table: "live_match_events",
    column: "gameweek_id",
    strategy: "gameweek",
    primaryKey: ["id", "gameweek_id"],
  },
  {
    table: "contract_events",
    column: "created_at",
    strategy: "weekly",
    primaryKey: ["id", "created_at"],
  },
];

export interface PartitionSettings {
  /** Partitions are created this many days before they are needed */
  lookaheadDays: number;
  /** Partitions whose data is older than this are detached and archived */
  retentionDays: number;
  /** Optional tablespace (e.g. on a compressed volume) for archived partitions */
  archiveTablespace: string | null;
  /** lock_timeout for the metadata-only steps that need an ACCESS EXCLUSIVE lock */
  lockTimeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadPartitionSettings(env: NodeJS.ProcessEnv = process.env): PartitionSettings {
  return {
    lookaheadDays: positiveInt(env.PARTITION_LOOKAHEAD_DAYS, 14),
    retentionDays: positiveInt(env.PARTITION_RETENTION_DAYS, 90),
    archiveTablespace: env.PARTITION_ARCHIVE_TABLESPACE?.trim() || null,
    lockTimeoutMs: positiveInt(env.PARTITION_LOCK_TIMEOUT_MS, 5000),
  };
}

/** Half-open range [from, to). null means MINVALUE / MAXVALUE. Times are epoch ms. */
export interface PartitionRange {
  from: number | null;
  to: number | null;
}

export interface ExistingPartition {
  schema: string;
  name: string;
  range: PartitionRange;
  /** An interrupted DETACH ... CONCURRENTLY that must be finalized */
  detachPending: boolean;
}

export interface PlannedPartition {
  name: string;
  range: { from: number; to: number };
}

export interface GameweekWindow {
  id: number;
  deadline: Date;
  isFinished: boolean;
}

// ============================================================
// Pure planning helpers
// ============================================================

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Quotes a trusted identifier, rejecting anything that is not a plain lowercase name. */
export function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Refusing unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Start (Monday 00:00 UTC) of the week containing `ms`. */
export function weekStartUtc(ms: number): number {
  const date = new Date(ms);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

/** Formats epoch ms as a `timestamp` literal body in UTC, e.g. 2026-10-12 00:00:00. */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function boundLiteral(strategy: PartitionStrategy, value: number | null, side: "from" | "to"): string {
  if (value === null) return side === "from" ? "MINVALUE" : "MAXVALUE";
  if (strategy === "gameweek") {
    if (!Number.isInteger(value)) throw new Error(`Invalid gameweek bound: ${value}`);
    return String(value);
  }
  return `'${formatTimestamp(value)}'`;
}

const TIMESTAMP_BOUND =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:([+-])(\d{2})(?::?(\d{2}))?)?$/;

function parseBoundValue(raw: string, strategy: PartitionStrategy): number | null {
  const token = raw.trim();
  if (/^(MINVALUE|MAXVALUE)$/i.test(token)) return null;
  const unquoted = token.replace(/^'(.*)'$/, "$1");
  if (strategy === "gameweek") {
    const id = Number(unquoted);
    if (!Number.isInteger(id)) throw new Error(`Unparseable gameweek bound: ${raw}`);
    return id;
  }
  const match = unquoted.match(TIMESTAMP_BOUND);
  if (!match) throw new Error(`Unparseable timestamp bound: ${raw}`);
  const offset = match[3] ? `${match[3]}${match[4]}:${match[5] ?? "00"}` : "Z";
  return Date.parse(`${match[1]}T${match[2]}${offset}`);
}

/**
 * Parses `pg_get_expr(relpartbound)` output such as
 * `FOR VALUES FROM ('2026-10-12 00:00:00') TO ('2026-10-19 00:00:00')`.
 * Returns null for a DEFAULT partition.
 */
export function parsePartitionBound(expr: string, strategy: PartitionStrategy): PartitionRange | null {
  const match = expr.match(/FOR VALUES FROM \((.+?)\) TO \((.+?)\)\s*$/i);
  if (!match) return null;
  return {
    from: parseBoundValue(match[1], strategy),
    to: parseBoundValue(match[2], strategy),
  };
}

export function partitionName(spec: PartitionedTableSpec, from: number): string {
  if (spec.strategy === "gameweek") return `${spec.table}_gw${from}`;
  return `${spec.table}_p${new Date(from).toISOString().slice(0, 10).replace(/-/g, "")}`;
}

export function rangesOverlap(a: PartitionRange, b: PartitionRange): boolean {
  const aFrom = a.from ?? -Infinity;
  const aTo = a.to ?? Infinity;
  const bFrom = b.from ?? -Infinity;
  const bTo = b.to ?? Infinity;
  return aFrom < bTo && bFrom < aTo;
}

/**
 * Partitions that must exist so every row written in the next `lookaheadDays`
 * has a home. Ranges already covered by an attached partition are skipped.
 */
export function planUpcomingPartitions(
  spec: PartitionedTableSpec,
  existing: ExistingPartition[],
  now: Date,
  settings: Pick<PartitionSettings, "lookaheadDays" | "retentionDays">,
  gameweeks: GameweekWindow[] = []
): PlannedPartition[] {
  const attached = existing.filter((p) => !p.detachPending);
  const isCovered = (range: PartitionRange) => attached.some((p) => rangesOverlap(p.range, range));
  const horizon = now.getTime() + settings.lookaheadDays * DAY_MS;
  const planned: PlannedPartition[] = [];

  if (spec.strategy === "weekly") {
    for (let start = weekStartUtc(now.getTime()); start <= horizon; start += WEEK_MS) {
      const range = { from: start, to: start + WEEK_MS };
      if (!isCovered(range)) planned.push({ name: partitionName(spec, start), range });
    }
    return planned;
  }

  // Gameweek partitions: every gameweek whose deadline falls inside the lookahead
  // window, plus recent ones still inside retention (e.g. a gameweek in progress).
  const oldest = now.getTime() - settings.retentionDays * DAY_MS;
  for (const gameweek of [...gameweeks].sort((a, b) => a.id - b.id)) {
    const deadline = gameweek.deadline.getTime();
    if (deadline > horizon || deadline < oldest) continue;
    const range = { from: gameweek.id, to: gameweek.id + 1 };
    if (!isCovered(range)) planned.push({ name: partitionName(spec, gameweek.id), range });
  }
  return planned;
}

/**
 * Attached partitions whose every row is older than the retention window.
 * Weekly: the range ends before the cutoff. Gameweek: every gameweek in the
 * range is finished and its deadline is before the cutoff.
 */
export function selectArchivablePartitions(
  spec: PartitionedTableSpec,
  existing: ExistingPartition[],
  now: Date,
  settings: Pick<PartitionSettings, "retentionDays">,
  gameweeks: GameweekWindow[] = []
): ExistingPartition[] {
  const cutoff = now.getTime() - settings.retentionDays * DAY_MS;

  return existing.filter((partition) => {
    if (partition.detachPending || partition.range.to === null) return false;

    if (spec.strategy === "weekly") {
      return partition.range.to <= cutoff;
    }

    const from = partition.range.from ?? -Infinity;
    const to = partition.range.to;
    const covered = gameweeks.filter((g) => g.id >= from && g.id < to);
    return (
      covered.length > 0 &&
      covered.every((g) => g.isFinished && g.deadline.getTime() < cutoff)
    );
  });
}

export function buildCreatePartitionSql(spec: PartitionedTableSpec, partition: PlannedPartition): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${qualified(PARTITION_SCHEMA, partition.name)} ` +
    `PARTITION OF ${qualified("public", spec.table)} ` +
    `FOR VALUES FROM (${boundLiteral(spec.strategy, partition.range.from, "from")}) ` +
    `TO (${boundLiteral(spec.strategy, partition.range.to, "to")})`
  );
}

/**
 * Upper bound of the partition that will hold all pre-existing rows when a
 * plain table is converted. It is placed far enough ahead that rows written
 * while the conversion runs still satisfy the bound.
 */
export function legacyUpperBound(
  spec: PartitionedTableSpec,
  now: Date,
  maxExistingKey: number | null,
  gameweeks: GameweekWindow[] = []
): number {
  if (spec.strategy === "weekly") {
    const twoWeeksAhead = weekStartUtc(now.getTime()) + 2 * WEEK_MS;
    const pastExisting = maxExistingKey === null ? 0 : weekStartUtc(maxExistingKey) + WEEK_MS;
    return Math.max(twoWeeksAhead, pastExisting);
  }
  const started = gameweeks
    .filter((g) => g.deadline.getTime() <= now.getTime())
    .map((g) => g.id);
  const current = started.length > 0 ? Math.max(...started) : 0;
  return Math.max(current, maxExistingKey ?? 0) + 1;
}

// ============================================================
// SQL execution
// ============================================================

/** Minimal SQL surface so the manager can run against Prisma or a test double. */
export interface SqlExecutor {
  /** Runs one statement in autocommit mode (required for CONCURRENTLY and VACUUM). */
  execute(sql: string): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs the statements in order inside a single transaction. */
  transaction(statements: string[]): Promise<void>;
}

interface RawClient {
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...params: unknown[]): Promise<T>;
  $transaction(operations: Promise<unknown>[]): Promise<unknown>;
}

export function prismaSqlExecutor(client: RawClient = prisma as unknown as RawClient): SqlExecutor {
  return {
    async execute(sql) {
      await client.$executeRawUnsafe(sql);
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return client.$queryRawUnsafe<T[]>(sql, ...params);
    },
    async transaction(statements) {
      await client.$transaction(statements.map((sql) => client.$executeRawUnsafe(sql)));
    },
  };
}

export interface ConversionReport {
  table: string;
  converted: boolean;
  reason?: string;
  legacyPartition?: string;
  legacyUpperBound?: string;
  createdPartitions: string[];
}

export interface ArchiveReport {
  table: string;
  archived: string[];
  finalized: string[];
}

interface IndexInfo {
  name: string;
  def: string;
  isPrimary: boolean;
  isUnique: boolean;
  columns: string[];
}

export class PartitionManager {
  constructor(
    private readonly sql: SqlExecutor = prismaSqlExecutor(),
    private readonly settings: PartitionSettings = loadPartitionSettings()
  ) {}

  private lockTimeout(): string {
    return `SET LOCAL lock_timeout = '${Math.trunc(this.settings.lockTimeoutMs)}ms'`;
  }

  /** 'p' = partitioned, 'r' = plain table, null = missing. */
  public async getTableKind(table: string): Promise<"p" | "r" | null> {
    const rows = await this.sql.query<{ kind: string }>(
      `SELECT c.relkind::text AS kind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [table]
    );
    const kind = rows[0]?.kind;
    return kind === "p" || kind === "r" ? kind : null;
  }

  public async ensureSchemas(): Promise<void> {
    await this.sql.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(PARTITION_SCHEMA)}`);
    await this.sql.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(ARCHIVE_SCHEMA)}`);
  }

  public async listPartitions(spec: PartitionedTableSpec): Promise<ExistingPartition[]> {
    const rows = await this.sql.query<{
      schema: string;
      name: string;
      bound: string;
      detachPending: boolean;
    }>(
      `SELECT n.nspname AS schema, c.relname AS name,
              pg_get_expr(c.relpartbound, c.oid) AS bound,
              i.inhdetachpending AS "detachPending"
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.inhparent = to_regclass($1)`,
      [`public.${spec.table}`]
    );

    const partitions: ExistingPartition[] = [];
    for (const row of rows) {
      const range = parsePartitionBound(row.bound, spec.strategy);
      if (!range) continue;
      partitions.push({
        schema: row.schema,
        name: row.name,
        range,
        detachPending: Boolean(row.detachPending),
      });
    }
    return partitions.sort((a, b) => (a.range.from ?? -Infinity) - (b.range.from ?? -Infinity));
  }

  public async loadGameweeks(): Promise<GameweekWindow[]> {
    const rows = await this.sql.query<{ id: number; deadline: Date | string; isFinished: boolean }>(
      `SELECT id, deadline, is_finished AS "isFinished" FROM gameweeks`
    );
    return rows.map((row) => ({
      id: Number(row.id),
      deadline: row.deadline instanceof Date ? row.deadline : new Date(row.deadline),
      isFinished: Boolean(row.isFinished),
    }));
  }

  /** Creates any missing partition needed within the lookahead window. */
  public async ensureUpcomingPartitions(
    spec: PartitionedTableSpec,
    now: Date = new Date(),
    gameweeks?: GameweekWindow[]
  ): Promise<string[]> {
    const existing = await this.listPartitions(spec);
    const windows = spec.strategy === "gameweek" ? gameweeks ?? (await this.loadGameweeks()) : [];
    const planned = planUpcomingPartitions(spec, existing, now, this.settings, windows);
    for (const partition of planned) {
      await this.sql.execute(buildCreatePartitionSql(spec, partition));
    }
    return planned.map((p) => p.name);
  }

  /** Completes a DETACH ... CONCURRENTLY that was interrupted (e.g. by a crash). */
  public async finalizePendingDetaches(spec: PartitionedTableSpec): Promise<string[]> {
    const pending = (await this.listPartitions(spec)).filter((p) => p.detachPending);
    for (const partition of pending) {
      await this.sql.execute(
        `ALTER TABLE ${qualified("public", spec.table)} ` +
          `DETACH PARTITION ${qualified(partition.schema, partition.name)} FINALIZE`
      );
      await this.moveToArchive(partition);
    }
    return pending.map((p) => p.name);
  }

  /**
   * Detaches partitions older than the retention window without blocking
   * writers, moves them to the archive schema and compacts them. Archived
   * tables are kept (never dropped) so historical data stays queryable.
   */
  public async archiveExpiredPartitions(
    spec: PartitionedTableSpec,
    now: Date = new Date(),
    gameweeks?: GameweekWindow[]
  ): Promise<ArchiveReport> {
    const finalized = await this.finalizePendingDetaches(spec);
    const existing = await this.listPartitions(spec);
    const windows = spec.strategy === "gameweek" ? gameweeks ?? (await this.loadGameweeks()) : [];
    const expired = selectArchivablePartitions(spec, existing, now, this.settings, windows);

    for (const partition of expired) {
      await this.sql.execute(
        `ALTER TABLE ${qualified("public", spec.table)} ` +
          `DETACH PARTITION ${qualified(partition.schema, partition.name)} CONCURRENTLY`
      );
      await this.moveToArchive(partition);
    }

    return { table: spec.table, archived: expired.map((p) => p.name), finalized };
  }

  private async moveToArchive(partition: Pick<ExistingPartition, "schema" | "name">): Promise<void> {
    let schema = partition.schema;
    if (schema !== ARCHIVE_SCHEMA) {
      await this.sql.execute(
        `ALTER TABLE ${qualified(schema, partition.name)} SET SCHEMA ${quoteIdent(ARCHIVE_SCHEMA)}`
      );
      schema = ARCHIVE_SCHEMA;
    }
    const table = qualified(schema, partition.name);

    // The detached table no longer serves live traffic, so a full rewrite is safe:
    // lz4 TOAST compression for future rewrites, then VACUUM FULL to pack pages.
    const toastable = await this.sql.query<{ column: string }>(
      `SELECT a.attname AS column FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attstorage IN ('x', 'e', 'm')`,
      [`${schema}.${partition.name}`]
    );
    for (const { column } of toastable) {
      try {
        await this.sql.execute(`ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(column)} SET COMPRESSION lz4`);
      } catch {
        // Server built without lz4: keep the default pglz compression
      }
    }
    if (this.settings.archiveTablespace) {
      await this.sql.execute(`ALTER TABLE ${table} SET TABLESPACE ${quoteIdent(this.settings.archiveTablespace)}`);
    }
    await this.sql.execute(`VACUUM (FULL, ANALYZE) ${table}`);
  }

  /** `base`, or `base2`, `base3`... whichever is unused in the partition and archive schemas. */
  private async freeRelationName(base: string): Promise<string> {
    const rows = await this.sql.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ($1, $2) AND c.relname LIKE $3`,
      [PARTITION_SCHEMA, ARCHIVE_SCHEMA, `${base}%`]
    );
    const taken = new Set(rows.map((r) => r.name));
    let candidate = base;
    for (let n = 2; taken.has(candidate) || taken.has(`${candidate}_pkey`); n++) {
      candidate = `${base}${n}`;
    }
    return candidate;
  }

  private async loadIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const rows = await this.sql.query<{
      name: string;
      def: string;
      isPrimary: boolean;
      isUnique: boolean;
      columns: string[];
    }>(
      `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def,
              ix.indisprimary AS "isPrimary", ix.indisunique AS "isUnique",
              ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS columns
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE ix.indrelid = to_regclass($1)`,
      [`${schema}.${table}`]
    );
    return rows.map((row) => ({ ...row, columns: [...row.columns] }));
  }

  /**
   * Converts a plain table into a range-partitioned table without downtime.
   * The existing table becomes the first partition [MINVALUE, bound); new
   * partitions are created from the bound onward. Idempotent: a table that is
   * already partitioned is left untouched. Each step runs in its own
   * transaction, so it can be re-run safely after a failure.
   */
  public async convertToPartitioned(
    spec: PartitionedTableSpec,
    now: Date = new Date()
  ): Promise<ConversionReport> {
    const kind = await this.getTableKind(spec.table);
    if (kind === "p") {
      return { table: spec.table, converted: false, reason: "already partitioned", createdPartitions: [] };
    }
    if (kind === null) {
      return { table: spec.table, converted: false, reason: "table does not exist", createdPartitions: [] };
    }

    await this.ensureSchemas();
    const parent = qualified("public", spec.table);
    const column = quoteIdent(spec.column);
    const legacyName = await this.freeRelationName(`${spec.table}_legacy`);
    const checkName = `${spec.table}_partition_bound_check`;
    const pkName = `${spec.table}_pkey`;

    // 1. Bound for the legacy partition, safely past any row written meanwhile
    const [{ maxKey }] = await this.sql.query<{ maxKey: Date | number | string | null }>(
      `SELECT max(${column}) AS "maxKey" FROM ${parent}`
    );
    const maxExisting =
      maxKey === null || maxKey === undefined
        ? null
        : maxKey instanceof Date
          ? maxKey.getTime()
          : spec.strategy === "weekly"
            ? Date.parse(String(maxKey))
            : Number(maxKey);
    const gameweeks = spec.strategy === "gameweek" ? await this.loadGameweeks() : [];
    const bound = legacyUpperBound(spec, now, maxExisting, gameweeks);
    const boundSql = boundLiteral(spec.strategy, bound, "to");

    // 2. CHECK constraint matching the partition bound: added NOT VALID (instant),
    //    then validated without blocking writes. ATTACH can then skip its scan.
    await this.sql.transaction([
      this.lockTimeout(),
      `ALTER TABLE ${parent} DROP CONSTRAINT IF EXISTS ${quoteIdent(checkName)}`,
      `ALTER TABLE ${parent} ADD CONSTRAINT ${quoteIdent(checkName)} ` +
        `CHECK (${column} IS NOT NULL AND ${column} < ${boundSql}) NOT VALID`,
    ]);
    await this.sql.execute(`ALTER TABLE ${parent} VALIDATE CONSTRAINT ${quoteIdent(checkName)}`);

    // 3. The primary key must include the partition key. Build the new key's
    //    index concurrently and swap it in as a metadata-only change.
    const indexes = await this.loadIndexes("public", spec.table);
    const currentPk = indexes.find((i) => i.isPrimary);
    if (!currentPk || currentPk.columns.join(",") !== spec.primaryKey.join(",")) {
      const swapIndex = `${spec.table}_pk_swap_idx`;
      await this.sql.execute(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(swapIndex)} ` +
          `ON ${parent} (${spec.primaryKey.map(quoteIdent).join(", ")})`
      );
      const swap = [this.lockTimeout()];
      if (currentPk) {
        swap.push(`ALTER TABLE ${parent} DROP CONSTRAINT IF EXISTS ${quoteIdent(pkName)}`);
      }
      swap.push(
        `ALTER TABLE ${parent} ADD CONSTRAINT ${quoteIdent(pkName)} PRIMARY KEY USING INDEX ${quoteIdent(swapIndex)}`
      );
      await this.sql.transaction(swap);
    }

    const swappedIndexes = await this.loadIndexes("public", spec.table);
    const primaryName = swappedIndexes.find((i) => i.isPrimary)?.name ?? pkName;
    const secondary = swappedIndexes.filter((i) => !i.isPrimary);
    for (const index of secondary) {
      if (index.isUnique && !index.columns.includes(spec.column)) {
        throw new Error(
          `Unique index ${index.name} on ${spec.table} does not include the partition key ${spec.column}`
        );
      }
    }

    // 4. Swap: the plain table becomes the legacy partition of a new parent.
    //    Every statement is metadata-only; matching indexes are reused on ATTACH.
    //    The legacy table's indexes are renamed first so the parent can take
    //    over the original names (index names are unique per schema).
    const firstPartitions = planUpcomingPartitions(
      spec,
      [{ schema: PARTITION_SCHEMA, name: legacyName, range: { from: null, to: bound }, detachPending: false }],
      now,
      this.settings,
      gameweeks
    );
    const legacy = qualified(PARTITION_SCHEMA, legacyName);
    const parentIndexSql = secondary.map((index) =>
      index.def.replace(
        new RegExp(`\\sON (?:ONLY )?(?:public\\.)?"?${spec.table}"?\\s`),
        ` ON ${parent} `
      )
    );

    await this.sql.transaction([
      this.lockTimeout(),
      `LOCK TABLE ${parent} IN ACCESS EXCLUSIVE MODE`,
      `ALTER TABLE ${parent} RENAME CONSTRAINT ${quoteIdent(primaryName)} TO ${quoteIdent(`${legacyName}_pkey`)}`,
      ...secondary.map(
        (index, i) => `ALTER INDEX ${qualified("public", index.name)} RENAME TO ${quoteIdent(`${legacyName}_i${i}`)}`
      ),
      `ALTER TABLE ${parent} RENAME TO ${quoteIdent(legacyName)}`,
      `ALTER TABLE ${qualified("public", legacyName)} SET SCHEMA ${quoteIdent(PARTITION_SCHEMA)}`,
      `CREATE TABLE ${parent} (LIKE ${legacy} INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS INCLUDING COMPRESSION) ` +
        `PARTITION BY RANGE (${column})`,
      `ALTER TABLE ${parent} ADD CONSTRAINT ${quoteIdent(pkName)} PRIMARY KEY (${spec.primaryKey.map(quoteIdent).join(", ")})`,
      ...parentIndexSql,
      `ALTER TABLE ${parent} ATTACH PARTITION ${legacy} FOR VALUES FROM (MINVALUE) TO (${boundSql})`,
      ...firstPartitions.map((p) => buildCreatePartitionSql(spec, p)),
    ]);

    return {
      table: spec.table,
      converted: true,
      legacyPartition: `${PARTITION_SCHEMA}.${legacyName}`,
      legacyUpperBound: boundSql,
      createdPartitions: firstPartitions.map((p) => p.name),
    };
  }

  /**
   * Emergency rollback to a plain table. Copies the rows of every attached
   * partition into a new table under an exclusive lock, so writes are paused
   * for the duration of the copy. Archived partitions are left in the archive
   * schema. The partitioned table is kept (renamed) for inspection.
   */
  public async revertToPlain(spec: PartitionedTableSpec): Promise<{ table: string; reverted: boolean; keptAs?: string }> {
    if ((await this.getTableKind(spec.table)) !== "p") {
      return { table: spec.table, reverted: false };
    }
    await this.ensureSchemas();

    const parent = qualified("public", spec.table);
    const staging = `${spec.table}_unpartitioned`;
    const keptAs = `${spec.table}_partitioned_${Date.now()}`;
    const secondary = (await this.loadIndexes("public", spec.table)).filter((i) => !i.isPrimary);

    const restoredIndexSql = secondary.map((index) =>
      index.def.replace(
        new RegExp(`\\sON (?:ONLY )?(?:public\\.)?"?${spec.table}"?\\s`),
        ` ON ${parent} `
      )
    );

    await this.sql.transaction([
      this.lockTimeout(),
      `LOCK TABLE ${parent} IN ACCESS EXCLUSIVE MODE`,
      `CREATE TABLE ${qualified("public", staging)} (LIKE ${parent} INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS INCLUDING COMPRESSION)`,
      `INSERT INTO ${qualified("public", staging)} SELECT * FROM ${parent}`,
      // Free the original index names (the partitions schema already holds the
      // legacy partition's indexes under them) before moving the old parent away.
      `ALTER TABLE ${parent} RENAME CONSTRAINT ${quoteIdent(`${spec.table}_pkey`)} TO ${quoteIdent(`${keptAs}_pkey`)}`,
      ...secondary.map(
        (index, i) => `ALTER INDEX ${qualified("public", index.name)} RENAME TO ${quoteIdent(`${keptAs}_i${i}`)}`
      ),
      `ALTER TABLE ${parent} RENAME TO ${quoteIdent(keptAs)}`,
      `ALTER TABLE ${qualified("public", keptAs)} SET SCHEMA ${quoteIdent(PARTITION_SCHEMA)}`,
      `ALTER TABLE ${qualified("public", staging)} RENAME TO ${quoteIdent(spec.table)}`,
      `ALTER TABLE ${parent} ADD CONSTRAINT ${quoteIdent(`${spec.table}_pkey`)} PRIMARY KEY (${spec.primaryKey.map(quoteIdent).join(", ")})`,
      ...restoredIndexSql,
    ]);

    return { table: spec.table, reverted: true, keptAs: `${PARTITION_SCHEMA}.${keptAs}` };
  }
}
