import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { computeLockTime, LOCK_LEAD_MINUTES } from "../jobs/deadlineLocking.js";
import { isGameweekReadyForSettlement } from "../jobs/gameweekSettlement.js";
import { runWithMetrics, getQueueHealth, JOB_DEFINITIONS } from "../queues/jobQueue.js";
import {
  FPL_SYNC_RETRY_LIMIT,
  FPL_SYNC_RETRY_DELAY_SECONDS,
  fplSyncQueueConfig,
  shouldRouteToDlq,
  runFplSyncTaskWithRetry,
  type FplSyncTask,
} from "../queues/fplSyncQueue.js";
import { fplSyncService } from "../services/fpl/fplSyncService.js";

describe("Background Job Queue & Matchday Lifecycle", () => {
  it("locks squads 90 minutes before the first kickoff", () => {
    assert.equal(LOCK_LEAD_MINUTES, 90);
    const lock = computeLockTime(new Date("2026-09-12T11:30:00Z"));
    assert.equal(lock.toISOString(), "2026-09-12T10:00:00.000Z");
  });

  it("settles a gameweek only when every fixture is finished", () => {
    assert.equal(isGameweekReadyForSettlement([]), false);
    assert.equal(isGameweekReadyForSettlement([{ finished: true }, { finished: false }]), false);
    assert.equal(isGameweekReadyForSettlement([{ finished: true }, { finished: true }]), true);
  });

  it("schedules polling every minute and all lifecycle jobs", () => {
    const byName = new Map(JOB_DEFINITIONS.map((d) => [d.name, d.cron]));
    assert.equal(byName.get("matchday-poll"), "* * * * *");
    assert.equal(byName.get("deadline-lock"), "* * * * *");
    assert.ok(byName.has("gameweek-settlement"));
    assert.ok(byName.has("league-refunds"));
    assert.equal(byName.get("price-sync"), "0 3 * * *");
  });

  it("records success, failure and retry metrics", async () => {
    let shouldFail = true;
    const def = {
      name: "matchday-poll",
      cron: "* * * * *",
      handler: async () => {
        if (shouldFail) throw new Error("FPL API down");
      },
    };

    const originalError = console.error;
    const originalLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await assert.rejects(() => runWithMetrics(def, 0), /FPL API down/);
      shouldFail = false;
      await runWithMetrics(def, 1);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }

    const health = await getQueueHealth();
    assert.equal(health.running, false);
    const poll = health.queues.find((q) => q.name === "matchday-poll")!;
    assert.equal(poll.processed, 2);
    assert.equal(poll.failed, 1);
    assert.equal(poll.succeeded, 1);
    assert.equal(poll.retried, 1);
    assert.equal(poll.lastError, "FPL API down");
  });
});

describe("FPL Sync Queue Retry & Dead-Letter Queue", () => {
  it("configures exponential backoff for failed sync attempts", () => {
    const config = fplSyncQueueConfig();
    assert.equal(config.retryBackoff, true);
    assert.equal(config.retryDelay, FPL_SYNC_RETRY_DELAY_SECONDS);
    assert.equal(config.retryLimit, FPL_SYNC_RETRY_LIMIT);
  });

  it("routes a task to the DLQ once its retry budget is exhausted", () => {
    assert.equal(shouldRouteToDlq(0, FPL_SYNC_RETRY_LIMIT), false);
    assert.equal(shouldRouteToDlq(1, FPL_SYNC_RETRY_LIMIT), false);
    assert.equal(shouldRouteToDlq(FPL_SYNC_RETRY_LIMIT - 1, FPL_SYNC_RETRY_LIMIT), false);
    assert.equal(shouldRouteToDlq(FPL_SYNC_RETRY_LIMIT, FPL_SYNC_RETRY_LIMIT), true);
  });

  it("retries failing syncs with backoff and dead-letters permanently failed jobs", async () => {
    // Mock the external FPL API to return 500s for the whole sync attempt.
    mock.method(fplSyncService, "syncFixtures", async () => {
      throw new Error("FPL API request failed: [500] Internal Server Error");
    });

    const task: FplSyncTask = { type: "fixtures" };
    const deadLettered: FplSyncTask[] = [];
    const sendToDlq = async (t: FplSyncTask) => {
      deadLettered.push(t);
    };

    try {
      // Non-terminal attempts retry (throw) without touching the DLQ.
      for (let retryCount = 0; retryCount < FPL_SYNC_RETRY_LIMIT; retryCount++) {
        await assert.rejects(
          () => runFplSyncTaskWithRetry(task, retryCount, FPL_SYNC_RETRY_LIMIT, sendToDlq),
          /500/
        );
      }
      assert.deepEqual(deadLettered, []);

      // The attempt at the retry limit is forwarded to the DLQ before failing.
      await assert.rejects(
        () => runFplSyncTaskWithRetry(task, FPL_SYNC_RETRY_LIMIT, FPL_SYNC_RETRY_LIMIT, sendToDlq),
        /500/
      );
      assert.deepEqual(deadLettered, [task]);
    } finally {
      mock.restoreAll();
    }
  });

  it("exposes the sync queue and DLQ in the queue health snapshot", async () => {
    const health = await getQueueHealth();
    assert.equal(health.sync.name, "fpl-sync");
    assert.equal(health.sync.retryDelaySeconds, FPL_SYNC_RETRY_DELAY_SECONDS);
    assert.equal(health.sync.backoffExponential, true);
    assert.equal(health.sync.queued, null);
    assert.equal(health.dlq.name, "fpl-sync-dlq");
    assert.equal(health.dlq.queued, null);
  });
});
