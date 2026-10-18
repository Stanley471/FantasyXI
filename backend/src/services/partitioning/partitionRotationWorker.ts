import {
  PARTITIONED_TABLES,
  PartitionManager,
  PartitionedTableSpec,
} from "./partitionManager.js";

export interface TableRotationResult {
  table: string;
  /** False when the table has not been converted yet (run `npm run db:partition convert`) */
  partitioned: boolean;
  created: string[];
  archived: string[];
  finalized: string[];
  error?: string;
}

/**
 * Keeps partitioned event tables ready for traffic (issue #263):
 * 1. finalizes any interrupted concurrent detach,
 * 2. pre-creates the partitions needed over the lookahead window (14 days by
 *    default) so inserts never hit a missing range when a new gameweek starts,
 * 3. detaches, archives and compacts partitions past retention (90 days).
 *
 * Every step is idempotent, so the job can run often and be retried freely.
 * One table failing does not stop the others; the run throws afterwards so the
 * job queue records the failure and retries.
 */
export class PartitionRotationWorker {
  constructor(
    private readonly manager: PartitionManager = new PartitionManager(),
    private readonly tables: readonly PartitionedTableSpec[] = PARTITIONED_TABLES
  ) {}

  public async run(now: Date = new Date()): Promise<TableRotationResult[]> {
    const results: TableRotationResult[] = [];
    let gameweeks: Awaited<ReturnType<PartitionManager["loadGameweeks"]>> | undefined;

    for (const spec of this.tables) {
      const result: TableRotationResult = {
        table: spec.table,
        partitioned: false,
        created: [],
        archived: [],
        finalized: [],
      };
      results.push(result);

      try {
        if ((await this.manager.getTableKind(spec.table)) !== "p") continue;
        result.partitioned = true;

        if (spec.strategy === "gameweek" && !gameweeks) {
          gameweeks = await this.manager.loadGameweeks();
        }
        const windows = spec.strategy === "gameweek" ? gameweeks : [];

        result.created = await this.manager.ensureUpcomingPartitions(spec, now, windows);
        const archive = await this.manager.archiveExpiredPartitions(spec, now, windows);
        result.archived = archive.archived;
        result.finalized = archive.finalized;
      } catch (error) {
        result.error = (error as Error).message;
      }
    }

    const failed = results.filter((r) => r.error);
    if (failed.length > 0) {
      throw new Error(
        `Partition rotation failed for ${failed.map((r) => `${r.table}: ${r.error}`).join("; ")}`
      );
    }
    return results;
  }
}

/** Job entry point (see queues/jobQueue.ts). */
export async function rotatePartitions(): Promise<TableRotationResult[]> {
  return new PartitionRotationWorker().run();
}
