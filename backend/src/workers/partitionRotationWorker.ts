export interface PartitionBounds {
  parentTable: string;
  partitionName: string;
  fromIsoUtc: string; // YYYY-MM-DDT00:00:00.000Z
  toIsoUtc: string; // YYYY-MM-DDT00:00:00.000Z
  dateKey: string; // YYYY_MM_DD
}

export interface DetachedArchiveRecord {
  parentTable: string;
  partitionName: string;
  fromIsoUtc: string;
  toIsoUtc: string;
  detachedAt: Date;
  detachSql: string;
  reattachRollbackSql: string;
}

export interface PartitionRotationCycleReport {
  parentTable: string;
  executedAt: Date;
  createdPartitions: PartitionBounds[];
  detachedArchives: DetachedArchiveRecord[];
  executedSqlStatements: string[];
}

export interface SqlExecutor {
  executeRaw(sql: string): Promise<void>;
  listExistingPartitions(parentTable: string): Promise<PartitionBounds[]>;
}

const SAFE_IDENT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function assertSafeSqlIdentifier(identifier: string): string {
  if (!SAFE_IDENT_REGEX.test(identifier)) {
    throw new Error(`Unsafe SQL identifier rejected: ${identifier}`);
  }
  return identifier;
}

export function formatUtcDateParts(date: Date): {
  isoStart: string;
  dateKey: string;
} {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return {
    isoStart: `${year}-${month}-${day}T00:00:00.000Z`,
    dateKey: `${year}_${month}_${day}`,
  };
}

export class PartitionRotationWorker {
  private readonly parentTable: string;
  private readonly preallocateDays: number;
  private readonly retentionDays: number;
  private readonly useConcurrently: boolean;
  private readonly executor: SqlExecutor;

  constructor(options: {
    parentTable?: string;
    preallocateDays?: number;
    retentionDays?: number;
    useConcurrently?: boolean;
    executor: SqlExecutor;
  }) {
    this.parentTable = assertSafeSqlIdentifier(
      options.parentTable ?? "live_match_events"
    );
    this.preallocateDays = options.preallocateDays ?? 14;
    this.retentionDays = options.retentionDays ?? 90;
    this.useConcurrently = options.useConcurrently ?? true;
    this.executor = options.executor;
  }

  /**
   * Computes contiguous daily partition bounds starting from `referenceDateUtc` (inclusive)
   * through `referenceDateUtc + preallocateDays` (14 days in advance by default).
   */
  public buildUpcomingPartitionWindow(
    referenceDateUtc: Date = new Date()
  ): PartitionBounds[] {
    const startOfTodayMs = Date.UTC(
      referenceDateUtc.getUTCFullYear(),
      referenceDateUtc.getUTCMonth(),
      referenceDateUtc.getUTCDate()
    );

    const bounds: PartitionBounds[] = [];
    const oneDayMs = 24 * 60 * 60 * 1000;

    for (let dayOffset = 0; dayOffset < this.preallocateDays; dayOffset++) {
      const fromDate = new Date(startOfTodayMs + dayOffset * oneDayMs);
      const toDate = new Date(startOfTodayMs + (dayOffset + 1) * oneDayMs);
      const fromParts = formatUtcDateParts(fromDate);
      const toParts = formatUtcDateParts(toDate);

      bounds.push({
        parentTable: this.parentTable,
        partitionName: `${this.parentTable}_p_${fromParts.dateKey}`,
        fromIsoUtc: fromParts.isoStart,
        toIsoUtc: toParts.isoStart,
        dateKey: fromParts.dateKey,
      });
    }

    return bounds;
  }

  /**
   * Generates idempotent DDL to create a daily range partition.
   */
  public static buildCreatePartitionSql(bound: PartitionBounds): string {
    const parent = assertSafeSqlIdentifier(bound.parentTable);
    const part = assertSafeSqlIdentifier(bound.partitionName);
    return `CREATE TABLE IF NOT EXISTS ${part} PARTITION OF ${parent} FOR VALUES FROM ('${bound.fromIsoUtc}') TO ('${bound.toIsoUtc}');`;
  }

  /**
   * Generates zero-downtime DETACH PARTITION DDL (using CONCURRENTLY when enabled so
   * concurrent INSERTs and SELECTs on live_match_events are never blocked by ACCESS EXCLUSIVE locks).
   */
  public static buildDetachPartitionSql(
    bound: PartitionBounds,
    concurrently: boolean = true
  ): string {
    const parent = assertSafeSqlIdentifier(bound.parentTable);
    const part = assertSafeSqlIdentifier(bound.partitionName);
    const concurrentClause = concurrently ? " CONCURRENTLY" : "";
    return `ALTER TABLE ${parent} DETACH PARTITION ${part}${concurrentClause};`;
  }

  /**
   * Generates rollback DDL to re-attach a detached partition using a pre-validated CHECK constraint
   * so re-attachment avoids a full table scan.
   */
  public static buildRollbackReattachSql(bound: PartitionBounds): string {
    const parent = assertSafeSqlIdentifier(bound.parentTable);
    const part = assertSafeSqlIdentifier(bound.partitionName);
    return `ALTER TABLE ${parent} ATTACH PARTITION ${part} FOR VALUES FROM ('${bound.fromIsoUtc}') TO ('${bound.toIsoUtc}');`;
  }

  /**
   * Executes a full partition rotation cycle:
   * 1. Pre-allocates missing daily partitions for the next `preallocateDays` (14 days).
   * 2. Identifies partitions whose upper bound `toIsoUtc` is older than `retentionDays` (90 days)
   *    and detaches them using zero-downtime `DETACH PARTITION ... CONCURRENTLY`.
   */
  public async runRotationCycle(
    nowUtc: Date = new Date()
  ): Promise<PartitionRotationCycleReport> {
    const existing = await this.executor.listExistingPartitions(this.parentTable);
    const existingNames = new Set(existing.map((p) => p.partitionName));

    const upcoming = this.buildUpcomingPartitionWindow(nowUtc);
    const createdPartitions: PartitionBounds[] = [];
    const executedSqlStatements: string[] = [];

    // 1. Pre-allocate upcoming partitions
    for (const bound of upcoming) {
      if (existingNames.has(bound.partitionName)) {
        continue;
      }
      const createSql = PartitionRotationWorker.buildCreatePartitionSql(bound);
      await this.executor.executeRaw(createSql);
      executedSqlStatements.push(createSql);
      createdPartitions.push(bound);
    }

    // 2. Detach expired partitions older than retentionDays
    const cutoffMs =
      Date.UTC(
        nowUtc.getUTCFullYear(),
        nowUtc.getUTCMonth(),
        nowUtc.getUTCDate()
      ) -
      this.retentionDays * 24 * 60 * 60 * 1000;

    const detachedArchives: DetachedArchiveRecord[] = [];
    for (const part of existing) {
      const upperBoundMs = Date.parse(part.toIsoUtc);
      if (Number.isFinite(upperBoundMs) && upperBoundMs <= cutoffMs) {
        const detachSql = PartitionRotationWorker.buildDetachPartitionSql(
          part,
          this.useConcurrently
        );
        const reattachRollbackSql =
          PartitionRotationWorker.buildRollbackReattachSql(part);
        await this.executor.executeRaw(detachSql);
        executedSqlStatements.push(detachSql);

        detachedArchives.push({
          parentTable: this.parentTable,
          partitionName: part.partitionName,
          fromIsoUtc: part.fromIsoUtc,
          toIsoUtc: part.toIsoUtc,
          detachedAt: nowUtc,
          detachSql,
          reattachRollbackSql,
        });
      }
    }

    return {
      parentTable: this.parentTable,
      executedAt: nowUtc,
      createdPartitions,
      detachedArchives,
      executedSqlStatements,
    };
  }
}
