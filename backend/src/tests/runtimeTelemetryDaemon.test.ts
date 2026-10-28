import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeTelemetryDaemon,
  WorkerRecyclingCoordinator,
  MemoryWarning,
  SlowQueryEvent,
} from "../services/telemetry/runtimeTelemetryDaemon.js";

describe("RuntimeTelemetryDaemon and WorkerRecyclingCoordinator (#366)", () => {
  let daemons: RuntimeTelemetryDaemon[] = [];

  afterEach(() => {
    for (const d of daemons) {
      d.stop();
    }
    daemons = [];
  });

  function trackDaemon(d: RuntimeTelemetryDaemon): RuntimeTelemetryDaemon {
    daemons.push(d);
    return d;
  }

  describe("Memory & Event Loop Metrics", () => {
    it("reports accurate V8 heap, memory usage, and event loop metrics", () => {
      const daemon = trackDaemon(new RuntimeTelemetryDaemon());
      daemon.start();

      const heapMetrics = daemon.getHeapMetrics();
      assert.ok(heapMetrics.usedHeapMb > 0, "usedHeapMb should be > 0");
      assert.ok(heapMetrics.heapLimitMb > 0, "heapLimitMb should be > 0");
      assert.ok(heapMetrics.heapUsagePercent >= 0 && heapMetrics.heapUsagePercent <= 100);
      assert.ok(heapMetrics.rssMb > 0, "rssMb should be > 0");

      const eventLoop = daemon.getEventLoopMetrics();
      assert.ok(typeof eventLoop.p50Ms === "number");
      assert.ok(typeof eventLoop.p99Ms === "number");
      assert.ok(typeof eventLoop.meanMs === "number");

      const gcMetrics = daemon.getGcMetrics();
      assert.ok(typeof gcMetrics.totalRuns === "number");
      assert.ok(typeof gcMetrics.totalDurationMs === "number");
    });

    it("triggers memory WARNING when usage crosses warning threshold", () => {
      const warnings: MemoryWarning[] = [];

      // Set threshold very low (e.g. 0.001%) so current heap usage crosses warning but not critical
      const daemon = trackDaemon(
        new RuntimeTelemetryDaemon({
          heapWarningThresholdPercent: 0.0001,
          heapCriticalThresholdPercent: 99.99,
          onWarning: (w) => warnings.push(w),
        })
      );

      const result = daemon.sampleAndCheck();
      assert.ok(result);
      assert.equal(result.level, "WARNING");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].level, "WARNING");
      assert.ok(warnings[0].heapUsagePercent > 0);
      assert.ok(warnings[0].message.includes("crosses WARNING threshold"));
    });

    it("triggers memory CRITICAL alert when usage crosses critical threshold", () => {
      const criticals: MemoryWarning[] = [];

      // Set critical threshold very low (e.g. 0.0001%)
      const daemon = trackDaemon(
        new RuntimeTelemetryDaemon({
          heapWarningThresholdPercent: 0.00005,
          heapCriticalThresholdPercent: 0.0001,
          onCritical: (c) => criticals.push(c),
        })
      );

      const result = daemon.sampleAndCheck();
      assert.ok(result);
      assert.equal(result.level, "CRITICAL");
      assert.equal(criticals.length, 1);
      assert.equal(criticals[0].level, "CRITICAL");
      assert.ok(criticals[0].message.includes("crosses CRITICAL threshold"));
    });
  });

  describe("Slow Query Tracer", () => {
    it("does not flag fast queries below threshold", async () => {
      const captured: SlowQueryEvent[] = [];
      const daemon = trackDaemon(
        new RuntimeTelemetryDaemon({
          slowQueryThresholdMs: 150,
          onSlowQuery: (e) => captured.push(e),
        })
      );

      const res = await daemon.traceQuery("SELECT id FROM users", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { count: 42 };
      });

      assert.deepEqual(res, { count: 42 });
      assert.equal(daemon.getSlowQueries().length, 0);
      assert.equal(captured.length, 0);
    });

    it("records slow queries exceeding threshold with stack traces", async () => {
      const captured: SlowQueryEvent[] = [];
      const daemon = trackDaemon(
        new RuntimeTelemetryDaemon({
          slowQueryThresholdMs: 50,
          onSlowQuery: (e) => captured.push(e),
        })
      );

      const res = await daemon.traceQuery("SELECT * FROM large_transactions_audit", async () => {
        await new Promise((r) => setTimeout(r, 70));
        return "query_done";
      });

      assert.equal(res, "query_done");
      const slowQueries = daemon.getSlowQueries();
      assert.equal(slowQueries.length, 1);
      assert.equal(captured.length, 1);

      const item = slowQueries[0];
      assert.equal(item.query, "SELECT * FROM large_transactions_audit");
      assert.ok(item.durationMs >= 50, `duration ${item.durationMs}ms should be >= 50ms`);
      assert.equal(item.thresholdMs, 50);
      assert.ok(item.stackTrace.length > 0, "stackTrace should be captured");
    });

    it("rethrows error from failing traced query while still tracking execution time", async () => {
      const daemon = trackDaemon(
        new RuntimeTelemetryDaemon({
          slowQueryThresholdMs: 30,
        })
      );

      await assert.rejects(
        daemon.traceQuery("SELECT error_probe()", async () => {
          await new Promise((r) => setTimeout(r, 45));
          throw new Error("DB Connection Reset");
        }),
        /DB Connection Reset/
      );

      const slowQueries = daemon.getSlowQueries();
      assert.equal(slowQueries.length, 1);
      assert.equal(slowQueries[0].query, "SELECT error_probe()");
    });
  });

  describe("WorkerRecyclingCoordinator", () => {
    it("manages in-flight jobs and drains them gracefully during recycle", async () => {
      let recycleCalledWith = "";
      const coordinator = new WorkerRecyclingCoordinator({
        drainTimeoutMs: 2_000,
        onRecycle: (reason) => {
          recycleCalledWith = reason;
        },
      });

      assert.equal(coordinator.getState(), "ACTIVE");
      assert.equal(coordinator.getInFlightJobs(), 0);

      // Acquire two concurrent jobs
      const releaseJob1 = coordinator.acquireJob();
      const releaseJob2 = coordinator.acquireJob();
      assert.equal(coordinator.getInFlightJobs(), 2);

      // Trigger recycling in background
      const recyclePromise = coordinator.recycle("Memory threshold exceeded");
      assert.equal(coordinator.getState(), "DRAINING");
      assert.equal(coordinator.getRecycleReason(), "Memory threshold exceeded");

      // Attempting to acquire a new job during draining must throw
      assert.throws(
        () => coordinator.acquireJob(),
        /Worker is currently DRAINING; cannot accept new jobs/
      );

      // Release job 1
      releaseJob1();
      assert.equal(coordinator.getInFlightJobs(), 1);
      assert.equal(coordinator.getState(), "DRAINING");

      // Release job 2 after a small delay
      await new Promise((r) => setTimeout(r, 60));
      releaseJob2();

      // Recycling promise should now resolve
      await recyclePromise;

      assert.equal(coordinator.getState(), "RECYCLED");
      assert.equal(coordinator.getInFlightJobs(), 0);
      assert.equal(recycleCalledWith, "Memory threshold exceeded");
    });

    it("forces recycling if drain timeout is exceeded", async () => {
      const coordinator = new WorkerRecyclingCoordinator({
        drainTimeoutMs: 100, // short timeout
      });

      const releaseJob = coordinator.acquireJob();
      assert.equal(coordinator.getInFlightJobs(), 1);

      const start = Date.now();
      await coordinator.recycle("Forced timeout test");
      const elapsed = Date.now() - start;

      assert.ok(elapsed >= 90, "Should have waited for drain timeout");
      assert.equal(coordinator.getState(), "RECYCLED");
      // Clean up job release
      releaseJob();
    });

    it("triggers automated worker recycling when telemetry daemon hits critical heap threshold", async () => {
      let recycled = false;
      let recycledReason = "";

      const coordinator = new WorkerRecyclingCoordinator({
        drainTimeoutMs: 500,
        onRecycle: (reason) => {
          recycled = true;
          recycledReason = reason;
        },
      });

      const daemon = trackDaemon(
        new RuntimeTelemetryDaemon({
          heapCriticalThresholdPercent: 0.0001,
          recyclingCoordinator: coordinator,
        })
      );

      assert.equal(coordinator.getState(), "ACTIVE");

      daemon.sampleAndCheck();

      // Coordinator should have transitioned to DRAINING and then RECYCLED
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(coordinator.getState(), "RECYCLED");
      assert.equal(recycled, true);
      assert.ok(recycledReason.includes("Heap usage exceeded critical threshold"));
    });
  });
});
