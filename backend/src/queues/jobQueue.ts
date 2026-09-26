import PgBoss from "pg-boss";
import { collectMatchdaySyncTasks } from "../jobs/matchdayPolling.js";
import { lockDueGameweeks } from "../jobs/deadlineLocking.js";
import { settleCompletedGameweeks } from "../jobs/gameweekSettlement.js";
import { processLeagueRefunds } from "../jobs/leagueRefunds.js";
import { syncDailyPlayerPrices } from "../jobs/priceSync.js";
import {
  executeFplSyncTask,
  FPL_SYNC_DLQ_NAME,
  FPL_SYNC_QUEUE_NAME,
  FPL_SYNC_RETRY_LIMIT,
  fplSyncQueueConfig,
  type FplSyncTask,
} from "./fplSyncQueue.js";

/**
 * PostgreSQL-backed background job queue (pg-boss).
 *
 * Every recurring job is a cron-scheduled queue with retries and exponential backoff.
 * The "stately" policy keeps at most one queued and one active job per queue, so a
 * slow run never piles up duplicates.
 *
 * Laravel equivalent: the scheduler (app/Console/Kernel.php) + database queue workers.
 */

interface JobDefinition {
  name: string;
  cron: string;
  handler: () => Promise<unknown>;
}

export interface QueueMetrics {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

// Cron triggers only *enqueue* work now. The heavy FPL synchronization is
// delegated to the `fpl-sync` queue (with retry + DLQ) instead of running
// inline inside the poller.
export const JOB_DEFINITIONS: JobDefinition[] = [
  { name: "matchday-poll", cron: "* * * * *", handler: () => enqueuePendingSyncs() },
  { name: "deadline-lock", cron: "* * * * *", handler: () => lockDueGameweeks() },
  { name: "gameweek-settlement", cron: "*/5 * * * *", handler: () => settleCompletedGameweeks() },
  { name: "league-refunds", cron: "*/5 * * * *", handler: () => processLeagueRefunds() },
  { name: "price-sync", cron: "0 3 * * *", handler: () => syncDailyPlayerPrices() },
];

const QUEUE_OPTIONS = {
  policy: "stately" as const,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
};

function emptyMetrics(): QueueMetrics {
  return {
    processed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
  };
}

let boss: PgBoss | null = null;
const metrics = new Map<string, QueueMetrics>(
  [
    ...JOB_DEFINITIONS.map((def) => [def.name, emptyMetrics()] as const),
    [FPL_SYNC_QUEUE_NAME, emptyMetrics()] as const,
    [FPL_SYNC_DLQ_NAME, emptyMetrics()] as const,
  ]
);

/**
 * Enqueues an FPL sync task on the `fpl-sync` queue. The queue worker retries
 * failures with exponential backoff and forwards exhausted jobs to the DLQ.
 */
export async function enqueueFplSync(task: FplSyncTask): Promise<void> {
  if (!boss) {
    throw new Error("[jobs] Job queue is not running; cannot enqueue FPL sync task");
  }
  await boss.send(FPL_SYNC_QUEUE_NAME, task);
}

/**
 * Detects which gameweeks need live FPL data and queues their sync jobs,
 * replacing the previous inline sync execution inside the cron poller.
 */
async function enqueuePendingSyncs(): Promise<number> {
  const tasks = await collectMatchdaySyncTasks();
  for (const task of tasks) {
    await enqueueFplSync(task);
  }
  return tasks.length;
}

/**
 * Runs a job handler while recording metrics and logs. Rethrows so pg-boss retries.
 */
export async function runWithMetrics(
  def: JobDefinition,
  retryCount: number
): Promise<void> {
  const m = metrics.get(def.name)!;
  const startedAt = Date.now();
  if (retryCount > 0) m.retried++;

  try {
    const result = await def.handler();
    m.succeeded++;
    console.log(`[jobs] ${def.name} completed in ${Date.now() - startedAt}ms`, result ?? "");
  } catch (error) {
    m.failed++;
    m.lastError = (error as Error).message;
    console.error(`[jobs] ${def.name} failed (attempt ${retryCount + 1}):`, error);
    throw error;
  } finally {
    m.processed++;
    m.lastRunAt = new Date(startedAt).toISOString();
    m.lastDurationMs = Date.now() - startedAt;
  }
}

interface FplSyncJob {
  data: FplSyncTask;
  retryCount: number;
  retryLimit: number;
}

/**
 * Executes an `fpl-sync` job with retry + DLQ protection and records metrics.
 * On terminal failure the payload is forwarded to the dead-letter queue and the
 * error rethrown so pg-boss marks the job failed.
 */
async function runFplSyncJobWithMetrics(
  instance: PgBoss,
  job: FplSyncJob
): Promise<unknown> {
  const m = metrics.get(FPL_SYNC_QUEUE_NAME)!;
  const startedAt = Date.now();
  if (job.retryCount > 0) m.retried++;

  try {
    const result = await executeFplSyncTask(job.data);
    m.succeeded++;
    return result;
  } catch (error) {
    m.failed++;
    m.lastError = (error as Error).message;
    if (job.retryCount >= job.retryLimit) {
      await instance.send(FPL_SYNC_DLQ_NAME, job.data);
    }
    console.error(
      `[jobs] ${FPL_SYNC_QUEUE_NAME} failed (attempt ${job.retryCount + 1}/${job.retryLimit + 1}):`,
      error
    );
    throw error;
  } finally {
    m.processed++;
    m.lastRunAt = new Date(startedAt).toISOString();
    m.lastDurationMs = Date.now() - startedAt;
  }
}

export async function startJobQueue(connectionString: string): Promise<void> {
  if (boss) return;

  const instance = new PgBoss(connectionString);
  instance.on("error", (error) => console.error("[jobs] pg-boss error:", error));
  await instance.start();

  for (const def of JOB_DEFINITIONS) {
    await instance.createQueue(def.name, { name: def.name, ...QUEUE_OPTIONS });
    await instance.schedule(def.name, def.cron);
    await instance.work(def.name, { includeMetadata: true }, async ([job]) =>
      runWithMetrics(def, job.retryCount)
    );
  }

  // FPL sync queue: retried with exponential backoff, DLQ on exhaustion.
  await instance.createQueue(FPL_SYNC_QUEUE_NAME, {
    name: FPL_SYNC_QUEUE_NAME,
    ...fplSyncQueueConfig(),
  });
  // Dead-letter queue: default policy so every poisoned job is retained for
  // manual inspection; no auto-retry since a DLQ entry is terminal.
  await instance.createQueue(FPL_SYNC_DLQ_NAME, {
    name: FPL_SYNC_DLQ_NAME,
    retryLimit: 0,
  });
  await instance.work(
    FPL_SYNC_QUEUE_NAME,
    { includeMetadata: true },
    async ([job]) => {
      const syncJob = job as unknown as FplSyncJob;
      return runFplSyncJobWithMetrics(instance, {
        data: syncJob.data,
        retryCount: job.retryCount,
        retryLimit: syncJob.retryLimit ?? FPL_SYNC_RETRY_LIMIT,
      });
    }
  );

  boss = instance;
  console.log(`[jobs] Job queue started: ${JOB_DEFINITIONS.map((d) => d.name).join(", ")}`);
  console.log(
    `[jobs] FPL sync queue "${FPL_SYNC_QUEUE_NAME}" active (retry limit ${FPL_SYNC_RETRY_LIMIT}, retry backoff: exponential), DLQ "${FPL_SYNC_DLQ_NAME}" ready`
  );
}

export async function stopJobQueue(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true });
  boss = null;
}

/**
 * Snapshot for /api/health/queues: per-queue backlog plus in-process metrics,
 * including the FPL sync queue and its dead-letter queue.
 */
export async function getQueueHealth() {
  const queues = await Promise.all(
    JOB_DEFINITIONS.map(async (def) => ({
      name: def.name,
      schedule: def.cron,
      queued: boss ? await boss.getQueueSize(def.name) : null,
      ...metrics.get(def.name)!,
    }))
  );

  const syncQueue = metrics.get(FPL_SYNC_QUEUE_NAME)!;
  const dlq = metrics.get(FPL_SYNC_DLQ_NAME)!;

  return {
    running: boss !== null,
    queues,
    sync: {
      name: FPL_SYNC_QUEUE_NAME,
      retryLimit: FPL_SYNC_RETRY_LIMIT,
      retryDelaySeconds: fplSyncQueueConfig().retryDelay,
      backoffExponential: fplSyncQueueConfig().retryBackoff,
      queued: boss ? await boss.getQueueSize(FPL_SYNC_QUEUE_NAME) : null,
      ...syncQueue,
    },
    dlq: {
      name: FPL_SYNC_DLQ_NAME,
      queued: boss ? await boss.getQueueSize(FPL_SYNC_DLQ_NAME) : null,
      ...dlq,
    },
  };
}