import { logger } from "../config/logger.js";

/**
 * Self-healing database maintenance worker (issue #436).
 *
 * Runs VACUUM ANALYZE on tables with excessive dead-tuple ratios and
 * REINDEX CONCURRENTLY on bloated indexes. All work is deferred to the
 * configured off-peak window (default 02:00–05:00 UTC) and skipped when
 * long-running queries are active, keeping maintenance from interfering with
 * normal application traffic.
 *
 * Shape mirrors the partition rotation worker: class-based with start(),
 * stop(), and runOnce(). A singleton is exported for direct use by the
 * job queue.
 */

export interface DbMaintenanceOptions {
  db?: any;
  now?: () => Date;
  /** First UTC hour (inclusive) of the maintenance window. Default 2. */
  offPeakStartHour?: number;
  /** First UTC hour (exclusive) after the maintenance window. Default 5. */
  offPeakEndHour?: number;
  /** Dead-tuple percentage above which a table or index is maintained. Default 30. */
  bloatThresholdPct?: number;
  /** Maximum wait for a table lock before skipping the target. Default 10 000 ms. */
  lockWaitTimeoutMs?: number;
  /** How often the polling loop fires. Default 6 hours. */
  pollIntervalMs?: number;
  /** When true, log intended operations but skip execution. */
  dryRun?: boolean;
}

export interface TableBloatInfo {
  schemaName: string;
  tableName: string;
  liveTuples: number;
  deadTuples: number;
  /** Fraction of total tuples that are dead, in [0, 1]. */
  deadTupleRatio: number;
  lastVacuum: Date | null;
  lastAutoVacuum: Date | null;
}

export interface IndexBloatInfo {
  schemaName: string;
  tableName: string;
  indexName: string;
  indexSizeByte: number;
  /** Estimated bloat as a percentage, in [0, 100]. */
  bloatPct: number;
}

export type MaintenanceOperation = "VACUUM" | "REINDEX";

export interface MaintenanceRecord {
  operation: MaintenanceOperation;
  /** Fully-qualified target: schema.table or schema.index. */
  target: string;
  durationMs: number;
  reclaimedBytes: number;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  executedAt: Date;
}

export interface MaintenanceRun {
  startedAt: Date;
  completedAt: Date;
  withinWindow: boolean;
  records: MaintenanceRecord[];
  totalReclaimedBytes: number;
}

// Raw row shapes returned by the analysis queries.
interface TableBloatRow {
  schemaname: string;
  tablename: string;
  n_live_tup: bigint | number;
  n_dead_tup: bigint | number;
  dead_tuple_ratio: number;
  last_vacuum: Date | null;
  last_autovacuum: Date | null;
}

interface IndexBloatRow {
  schemaname: string;
  tablename: string;
  indexname: string;
  index_size_bytes: bigint | number;
  bloat_pct: number;
}

interface ActiveLockRow {
  count: bigint | number;
}

export class DbMaintenanceWorker {
  private _db: any;
  private readonly now: () => Date;
  private readonly offPeakStartHour: number;
  private readonly offPeakEndHour: number;
  private readonly bloatThresholdPct: number;
  private readonly lockWaitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly dryRun: boolean;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;

  constructor(options: DbMaintenanceOptions = {}) {
    this._db = options.db ?? null; // resolved lazily on first use via getDb()
    this.now = options.now ?? (() => new Date());
    this.offPeakStartHour = options.offPeakStartHour ?? 2;
    this.offPeakEndHour = options.offPeakEndHour ?? 5;
    this.bloatThresholdPct = options.bloatThresholdPct ?? 30;
    this.lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? 10_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 6 * 60 * 60 * 1000;
    this.dryRun = options.dryRun ?? false;
  }

  private async getDb(): Promise<any> {
    if (!this._db) {
      const { prisma } = await import("../config/db.js");
      this._db = prisma;
    }
    return this._db;
  }

  /**
   * Returns true when the current UTC hour falls within the configured
   * off-peak maintenance window [offPeakStartHour, offPeakEndHour).
   */
  public isWithinOffPeakWindow(): boolean {
    const hour = this.now().getUTCHours();
    return hour >= this.offPeakStartHour && hour < this.offPeakEndHour;
  }

  /**
   * Queries pg_stat_user_tables for tables that have dead tuples, ordered by
   * dead-tuple ratio descending.
   */
  public async analyzeTableBloat(): Promise<TableBloatInfo[]> {
    const rows = (await ((await this.getDb()).$queryRawUnsafe as any)(
      `SELECT
         schemaname,
         relname AS tablename,
         n_live_tup,
         n_dead_tup,
         CASE WHEN n_live_tup + n_dead_tup > 0
              THEN n_dead_tup::float / (n_live_tup + n_dead_tup)
              ELSE 0 END AS dead_tuple_ratio,
         last_vacuum,
         last_autovacuum
       FROM pg_stat_user_tables
       WHERE n_dead_tup > 0
       ORDER BY dead_tuple_ratio DESC`,
    )) as TableBloatRow[];

    return rows.map((r) => ({
      schemaName: r.schemaname,
      tableName: r.tablename,
      liveTuples: Number(r.n_live_tup),
      deadTuples: Number(r.n_dead_tup),
      deadTupleRatio: Number(r.dead_tuple_ratio),
      lastVacuum: r.last_vacuum ?? null,
      lastAutoVacuum: r.last_autovacuum ?? null,
    }));
  }

  /**
   * Queries pg_stat_user_indexes joined with pg_stat_user_tables to derive a
   * bloat estimate based on the parent table's dead-tuple ratio, ordered by
   * bloat percentage then index size descending.
   */
  public async analyzeIndexBloat(): Promise<IndexBloatInfo[]> {
    const rows = (await ((await this.getDb()).$queryRawUnsafe as any)(
      `SELECT
         s.schemaname,
         s.relname AS tablename,
         s.indexrelname AS indexname,
         pg_relation_size(s.indexrelid) AS index_size_bytes,
         t.n_dead_tup,
         t.n_live_tup,
         CASE WHEN t.n_live_tup + t.n_dead_tup > 0
              THEN (t.n_dead_tup::float / (t.n_live_tup + t.n_dead_tup)) * 100
              ELSE 0 END AS bloat_pct
       FROM pg_stat_user_indexes s
       JOIN pg_stat_user_tables t ON t.relname = s.relname AND t.schemaname = s.schemaname
       WHERE t.n_dead_tup > 0
       ORDER BY bloat_pct DESC, index_size_bytes DESC`,
    )) as IndexBloatRow[];

    return rows.map((r) => ({
      schemaName: r.schemaname,
      tableName: r.tablename,
      indexName: r.indexname,
      indexSizeByte: Number(r.index_size_bytes),
      bloatPct: Number(r.bloat_pct),
    }));
  }

  /**
   * Returns true when there are queries that have been running for more than
   * 30 seconds (excluding the monitoring query itself). Maintenance is
   * deferred while such queries are present to avoid lock contention.
   */
  public async checkActiveLocks(): Promise<boolean> {
    const rows = (await ((await this.getDb()).$queryRawUnsafe as any)(
      `SELECT COUNT(*) as count FROM pg_stat_activity
       WHERE state != 'idle' AND state IS NOT NULL
         AND query NOT ILIKE '%pg_stat%'
         AND now() - query_start > interval '30 seconds'`,
    )) as ActiveLockRow[];

    return Number(rows[0]?.count ?? 0) > 0;
  }

  /**
   * Runs VACUUM (ANALYZE) on a single table. Sets lock_timeout before the
   * command so we skip gracefully if the table is locked. Returns a
   * MaintenanceRecord with reclaimed-bytes estimated from the dead-tuple
   * count before the vacuum (each dead tuple approximates 100 bytes of bloat).
   */
  public async vacuumTable(
    schemaName: string,
    tableName: string,
  ): Promise<MaintenanceRecord> {
    const target = `${schemaName}.${tableName}`;
    const executedAt = this.now();
    const start = Date.now();

    if (this.dryRun) {
      logger.info({ target }, "DB maintenance dry-run: would VACUUM");
      return {
        operation: "VACUUM",
        target,
        durationMs: 0,
        reclaimedBytes: 0,
        skipped: true,
        skipReason: "dry-run",
        executedAt,
      };
    }

    // Capture dead-tuple count before vacuum to estimate reclaimed bytes.
    let deadTuplesBefore = 0;
    try {
      const before = (await ((await this.getDb()).$queryRawUnsafe as any)(
        `SELECT n_dead_tup FROM pg_stat_user_tables
         WHERE schemaname = '${schemaName}' AND relname = '${tableName}'`,
      )) as Array<{ n_dead_tup: bigint | number }>;
      deadTuplesBefore = Number(before[0]?.n_dead_tup ?? 0);
    } catch {
      // Non-fatal; we just won't be able to report reclaimed bytes.
    }

    try {
      await (await this.getDb()).$executeRawUnsafe(
        `SET lock_timeout = '${this.lockWaitTimeoutMs}ms'`,
      );
      await (await this.getDb()).$executeRawUnsafe(`VACUUM (ANALYZE) ${target}`);

      const durationMs = Date.now() - start;
      // Rough estimate: each reclaimed dead tuple frees ~100 bytes.
      const reclaimedBytes = deadTuplesBefore * 100;

      logger.info({ target, durationMs, reclaimedBytes }, "DB maintenance: VACUUM completed");
      return {
        operation: "VACUUM",
        target,
        durationMs,
        reclaimedBytes,
        skipped: false,
        executedAt,
      };
    } catch (error) {
      const message = (error as Error).message ?? "";
      const durationMs = Date.now() - start;

      if (/lock/i.test(message)) {
        logger.warn({ target, error: message }, "DB maintenance: VACUUM skipped — lock timeout");
        return {
          operation: "VACUUM",
          target,
          durationMs,
          reclaimedBytes: 0,
          skipped: true,
          skipReason: "lock-timeout",
          error: message,
          executedAt,
        };
      }

      logger.error({ target, err: error }, "DB maintenance: VACUUM failed");
      return {
        operation: "VACUUM",
        target,
        durationMs,
        reclaimedBytes: 0,
        skipped: false,
        error: message,
        executedAt,
      };
    }
  }

  /**
   * Runs REINDEX INDEX CONCURRENTLY on a single index. Sets lock_timeout
   * first; on lock-related errors the record is marked skipped rather than
   * failed.
   */
  public async reindexConcurrently(
    schemaName: string,
    indexName: string,
  ): Promise<MaintenanceRecord> {
    const target = `${schemaName}.${indexName}`;
    const executedAt = this.now();
    const start = Date.now();

    if (this.dryRun) {
      logger.info({ target }, "DB maintenance dry-run: would REINDEX");
      return {
        operation: "REINDEX",
        target,
        durationMs: 0,
        reclaimedBytes: 0,
        skipped: true,
        skipReason: "dry-run",
        executedAt,
      };
    }

    try {
      await (await this.getDb()).$executeRawUnsafe(
        `SET lock_timeout = '${this.lockWaitTimeoutMs}ms'`,
      );
      await (await this.getDb()).$executeRawUnsafe(
        `REINDEX INDEX CONCURRENTLY ${target}`,
      );

      const durationMs = Date.now() - start;
      logger.info({ target, durationMs }, "DB maintenance: REINDEX completed");
      return {
        operation: "REINDEX",
        target,
        durationMs,
        reclaimedBytes: 0,
        skipped: false,
        executedAt,
      };
    } catch (error) {
      const message = (error as Error).message ?? "";
      const durationMs = Date.now() - start;

      if (/lock/i.test(message)) {
        logger.warn({ target, error: message }, "DB maintenance: REINDEX skipped — lock timeout");
        return {
          operation: "REINDEX",
          target,
          durationMs,
          reclaimedBytes: 0,
          skipped: true,
          skipReason: "lock-timeout",
          error: message,
          executedAt,
        };
      }

      logger.error({ target, err: error }, "DB maintenance: REINDEX failed");
      return {
        operation: "REINDEX",
        target,
        durationMs,
        reclaimedBytes: 0,
        skipped: false,
        error: message,
        executedAt,
      };
    }
  }

  /**
   * Runs one full maintenance cycle:
   *  1. Guards the off-peak window; returns early when outside it.
   *  2. Checks for active long-running queries; defers if any are found.
   *  3. Analyses table and index bloat; filters by threshold.
   *  4. Vacuums bloated tables and reindexes bloated indexes (highest bloat first).
   *  5. Returns a complete MaintenanceRun record.
   */
  public async runOnce(): Promise<MaintenanceRun> {
    const startedAt = this.now();

    if (!this.isWithinOffPeakWindow()) {
      logger.info(
        { hour: startedAt.getUTCHours() },
        "DB maintenance: outside off-peak window, skipping",
      );
      return {
        startedAt,
        completedAt: this.now(),
        withinWindow: false,
        records: [],
        totalReclaimedBytes: 0,
      };
    }

    if (this.inFlight) {
      logger.warn("DB maintenance: previous run still in progress, skipping");
      return {
        startedAt,
        completedAt: this.now(),
        withinWindow: true,
        records: [],
        totalReclaimedBytes: 0,
      };
    }

    this.inFlight = true;

    try {
      const hasLocks = await this.checkActiveLocks();
      if (hasLocks) {
        logger.warn(
          "DB maintenance: active long-running queries detected, deferring maintenance",
        );
        return {
          startedAt,
          completedAt: this.now(),
          withinWindow: true,
          records: [],
          totalReclaimedBytes: 0,
        };
      }

      const threshold = this.bloatThresholdPct / 100;

      const [tableBloat, indexBloat] = await Promise.all([
        this.analyzeTableBloat(),
        this.analyzeIndexBloat(),
      ]);

      const bloatedTables = tableBloat.filter(
        (t) => t.deadTupleRatio > threshold,
      );
      const bloatedIndexes = indexBloat.filter(
        (i) => i.bloatPct > this.bloatThresholdPct,
      );

      logger.info(
        {
          bloatedTables: bloatedTables.length,
          bloatedIndexes: bloatedIndexes.length,
          thresholdPct: this.bloatThresholdPct,
          dryRun: this.dryRun,
        },
        "DB maintenance: analysis complete",
      );

      const records: MaintenanceRecord[] = [];

      // Vacuum tables in descending bloat order.
      for (const table of bloatedTables) {
        const record = await this.vacuumTable(table.schemaName, table.tableName);
        records.push(record);
      }

      // Reindex in descending bloat order (query already sorted).
      for (const index of bloatedIndexes) {
        const record = await this.reindexConcurrently(
          index.schemaName,
          index.indexName,
        );
        records.push(record);
      }

      const totalReclaimedBytes = records.reduce(
        (sum, r) => sum + r.reclaimedBytes,
        0,
      );
      const completedAt = this.now();

      logger.info(
        {
          operations: records.length,
          skipped: records.filter((r) => r.skipped).length,
          totalReclaimedBytes,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        },
        "DB maintenance: run complete",
      );

      return {
        startedAt,
        completedAt,
        withinWindow: true,
        records,
        totalReclaimedBytes,
      };
    } finally {
      this.inFlight = false;
    }
  }

  /** Starts the recurring polling loop (fires immediately, then every pollIntervalMs). */
  public start(): void {
    if (this.running) return;
    this.running = true;

    const tick = async () => {
      try {
        const result = await this.runOnce();
        logger.info(
          {
            withinWindow: result.withinWindow,
            operations: result.records.length,
            totalReclaimedBytes: result.totalReclaimedBytes,
          },
          "DB maintenance worker tick completed",
        );
      } catch (error) {
        logger.error({ err: error }, "DB maintenance worker tick failed");
      } finally {
        if (this.running) {
          this.timer = setTimeout(tick, this.pollIntervalMs);
        }
      }
    };

    void tick();
  }

  /** Stops the polling loop and cancels the pending timer. */
  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export const dbMaintenanceWorker = new DbMaintenanceWorker();
