import { fplClient } from "../services/fpl/fplClient.js";
import { fplSyncService } from "../services/fpl/fplSyncService.js";

/**
 * FPL Sync Job Worker + Dead-Letter Queue.
 *
 * FPL syncs are no longer executed inline from the cron trigger. Instead the
 * matchday poller enqueues discrete `FplSyncTask` jobs onto the `fpl-sync`
 * queue. Each job is retried with exponential backoff (pg-boss doubles the
 * base delay on every retry). Once a task has exhausted the retry budget it is
 * forwarded to the `fpl-sync-dlq` queue for manual inspection, and the worker
 * rethrows so pg-boss records the terminal failure.
 *
 * Laravel equivalent: dispatching a Job subclass to a queue worker with
 * `backoff()` configured and a `failed()` hook routing to a dead-letter table.
 */

export type FplSyncTask =
  | { type: "fixtures" }
  | { type: "gameweek-live"; gameweekFplId: number };

export const FPL_SYNC_QUEUE_NAME = "fpl-sync";
export const FPL_SYNC_DLQ_NAME = "fpl-sync-dlq";

/** Max attempts a sync task may be retried before it lands in the DLQ. */
export const FPL_SYNC_RETRY_LIMIT = 3;

/** Base retry delay in seconds; pg-boss doubles it per retry (15s → 30s → 60s). */
export const FPL_SYNC_RETRY_DELAY_SECONDS = 15;

export interface FplSyncQueueConfig {
  policy: "stately";
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
}

/**
 * pg-boss queue options for the sync queue. `retryBackoff: true` enables
 * exponential backoff for failed sync attempts.
 */
export function fplSyncQueueConfig(): FplSyncQueueConfig {
  return {
    policy: "stately",
    retryLimit: FPL_SYNC_RETRY_LIMIT,
    retryDelay: FPL_SYNC_RETRY_DELAY_SECONDS,
    retryBackoff: true,
  };
}

/**
 * A task that has consumed its entire retry budget (retryCount >= retryLimit)
 * must be routed to the dead-letter queue instead of being retried again.
 */
export function shouldRouteToDlq(retryCount: number, retryLimit: number): boolean {
  return retryCount >= retryLimit;
}

/**
 * Executes a single sync task. The FPL client cache is always cleared first so
 * every queued attempt (including retries) observes fresh upstream live data.
 */
export async function executeFplSyncTask(task: FplSyncTask): Promise<unknown> {
  await fplClient.clearCache();
  switch (task.type) {
    case "fixtures":
      return fplSyncService.syncFixtures();
    case "gameweek-live":
      return fplSyncService.syncGameweekLiveStats(task.gameweekFplId);
  }
}

/**
 * Runs a sync task with the retry/DLQ policy applied. On terminal failure the
 * task payload is handed to `sendToDlq` (forwarding it to the dead-letter
 * queue) and the error is rethrown so pg-boss records the final failure.
 */
export async function runFplSyncTaskWithRetry(
  task: FplSyncTask,
  retryCount: number,
  retryLimit: number = FPL_SYNC_RETRY_LIMIT,
  sendToDlq: (task: FplSyncTask) => Promise<void> = async () => {}
): Promise<unknown> {
  try {
    return await executeFplSyncTask(task);
  } catch (error) {
    if (shouldRouteToDlq(retryCount, retryLimit)) {
      await sendToDlq(task);
    }
    throw error;
  }
}