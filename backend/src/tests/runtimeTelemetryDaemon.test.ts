import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeTelemetryDaemon,
  SlowQueryTracer,
  WorkerDrainingError,
  createSlowQueryPrismaExtension,
  type HeapAlertPayload,
  type EventLoopLagAlertPayload,
  type SlowQueryRecord,
  type WorkerRecycleReport,
} from "../workers/runtimeTelemetryDaemon.js";
import { traceStorage } from "../config/tracing.js";

function createTestLogger() {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  return {
    warnings,
    errors,
    infos,
    logger: {
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        errors.push({ message, meta });
      },
      info: (message: string, meta?: Record<string, unknown>) => {
        infos.push({ message, meta });
      },
    },
  };
}

describe("RuntimeTelemetryDaemon & SlowQueryTracer (Issue #366)", () => {
  let daemon: RuntimeTelemetryDaemon | null = null;

  afterEach(() => {
    daemon?.stop();
    daemon = null;
  });

  describe("V8 Heap Telemetry, Leak Detection & Threshold Warnings", () => {
    it("samples real Node.js V8 heap and perf_hooks event loop metrics", async () => {
      const { logger } = createTestLogger();
      daemon = new RuntimeTelemetryDaemon({
        sampleIntervalMs: 50,
        logger,
      });

      daemon.start();
      daemon.recordGcCycle(4.25, 1);

      const snapshot = await daemon.sampleOnce();
      assert.ok(snapshot.heap.heapUsedBytes > 0);
      assert.ok(snapshot.heap.heapTotalBytes >= snapshot.heap.heapUsedBytes);
      assert.ok(snapshot.heap.heapSizeLimitBytes > 0);
      assert.ok(snapshot.heap.heapUsagePercent > 0 && snapshot.heap.heapUsagePercent < 100);
      assert.equal(snapshot.gc.totalCycles, 1);
      assert.equal(snapshot.gc.lastGcDurationMs, 4.25);
      assert.equal(snapshot.workerState, "ACTIVE");
    });

    it("emits heap:warning when heap usage crosses configured warning percentage threshold", async () => {
      const { logger, warnings } = createTestLogger();
      let currentUsed = 600 * 1024 * 1024;
      const heapLimit = 1000 * 1024 * 1024;

      daemon = new RuntimeTelemetryDaemon({
        warningHeapPercent: 75,
        criticalHeapPercent: 90,
        heapStatsProvider: () => ({
          used_heap_size: currentUsed,
          total_heap_size: 800 * 1024 * 1024,
          heap_size_limit: heapLimit,
        }),
        logger,
      });

      const emittedWarnings: HeapAlertPayload[] = [];
      daemon.events.on("heap:warning", (alert: HeapAlertPayload) => {
        emittedWarnings.push(alert);
      });

      // 60% usage -> below 75% threshold
      await daemon.sampleOnce();
      assert.equal(emittedWarnings.length, 0);

      // 78% usage -> crosses 75% warning threshold
      currentUsed = 780 * 1024 * 1024;
      await daemon.sampleOnce();

      assert.equal(emittedWarnings.length, 1);
      assert.equal(emittedWarnings[0].level, "WARNING");
      assert.equal(emittedWarnings[0].heapUsagePercent, 78);
      assert.equal(emittedWarnings[0].thresholdPercent, 75);
      assert.ok(warnings.some((w) => w.message.includes("High heap usage warning")));
    });

    it("detects sustained monotonic memory retention across consecutive samples", async () => {
      const { logger, warnings } = createTestLogger();
      let usedBytes = 100 * 1024 * 1024;
      const limitBytes = 1000 * 1024 * 1024;

      daemon = new RuntimeTelemetryDaemon({
        warningHeapPercent: 80,
        criticalHeapPercent: 95,
        leakConsecutiveSamplesThreshold: 3,
        minGrowthDeltaBytes: 1024 * 1024, // 1 MB
        heapStatsProvider: () => ({
          used_heap_size: usedBytes,
          total_heap_size: 500 * 1024 * 1024,
          heap_size_limit: limitBytes,
        }),
        logger,
      });

      const leakAlerts: HeapAlertPayload[] = [];
      daemon.events.on("heap:leak_suspected", (alert: HeapAlertPayload) => {
        leakAlerts.push(alert);
      });

      // Sample 0 (baseline) + 3 consecutive +5MB increases
      await daemon.sampleOnce();
      for (let i = 0; i < 3; i++) {
        usedBytes += 5 * 1024 * 1024;
        await daemon.sampleOnce();
      }

      assert.equal(leakAlerts.length, 1);
      assert.equal(leakAlerts[0].level, "LEAK_SUSPECTED");
      assert.equal(leakAlerts[0].consecutiveGrowthSamples, 3);
      assert.ok(warnings.some((w) => w.message.includes("Suspected memory leak")));
    });

    it("emits eventloop:lag when event loop delay exceeds threshold", async () => {
      const { logger, warnings } = createTestLogger();
      daemon = new RuntimeTelemetryDaemon({
        eventLoopLagThresholdMs: 100,
        eventLoopMetricsProvider: () => ({
          meanMs: 22.5,
          maxMs: 185.4,
          p95Ms: 95.0,
          p99Ms: 142.8,
        }),
        logger,
      });

      const lagAlerts: EventLoopLagAlertPayload[] = [];
      daemon.events.on("eventloop:lag", (payload: EventLoopLagAlertPayload) => {
        lagAlerts.push(payload);
      });

      await daemon.sampleOnce();
      assert.equal(lagAlerts.length, 1);
      assert.equal(lagAlerts[0].p99Ms, 142.8);
      assert.equal(lagAlerts[0].maxMs, 185.4);
      assert.ok(warnings.some((w) => w.message.includes("Event loop lag threshold exceeded")));
    });
  });

  describe("SlowQueryTracer (>200ms threshold & stack trace capture)", () => {
    let simulatedClockMs = 1_000;
    let tracer: SlowQueryTracer;
    let loggerState: ReturnType<typeof createTestLogger>;

    beforeEach(() => {
      simulatedClockMs = 1_000;
      loggerState = createTestLogger();
      tracer = new SlowQueryTracer({
        thresholdMs: 200,
        maxRetainedRecords: 5,
        logger: loggerState.logger,
        nowFn: () => simulatedClockMs,
      });
    });

    it("ignores fast queries (<= 200ms) and logs slow queries (> 200ms) with stack traces and sanitized params", async () => {
      const slowEvents: SlowQueryRecord[] = [];
      tracer.events.on("query:slow", (rec: SlowQueryRecord) => slowEvents.push(rec));

      // Fast query: 85ms <= 200ms
      const fastResult = await tracer.traceQuery(
        {
          query: "SELECT * FROM leagues WHERE id = $1",
          model: "League",
          operation: "findUnique",
          params: { id: "league-1" },
        },
        async () => {
          simulatedClockMs += 85;
          return { id: "league-1" };
        }
      );
      assert.deepEqual(fastResult, { id: "league-1" });
      assert.equal(slowEvents.length, 0);

      // Slow query: 245ms > 200ms inside a W3C trace context
      const customTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      await traceStorage.run(
        { traceId: customTraceId, spanId: "00f067aa0ba902b7", sampled: true },
        async () => {
          await tracer.traceQuery(
            {
              query: "SELECT * FROM player_gameweek_points WHERE gameweek_id = $1 FOR UPDATE",
              model: "PlayerGameweekPoints",
              operation: "findMany",
              params: {
                gameweekId: 12,
                password: "super-secret-db-password",
                authToken: "jwt-secret",
              },
            },
            async () => {
              simulatedClockMs += 245;
              return [];
            }
          );
        }
      );

      assert.equal(slowEvents.length, 1);
      const record = slowEvents[0];
      assert.equal(record.durationMs, 245);
      assert.equal(record.thresholdMs, 200);
      assert.equal(record.model, "PlayerGameweekPoints");
      assert.equal(record.operation, "findMany");
      assert.equal(record.traceId, customTraceId);
      assert.equal(record.status, "OK");
      assert.equal(record.params.gameweekId, 12);
      assert.equal(record.params.password, "[REDACTED]");
      assert.equal(record.params.authToken, "[REDACTED]");
      assert.ok(
        record.stackTrace.includes("runtimeTelemetryDaemon.test"),
        `Expected caller stack trace to reference test file, got: ${record.stackTrace}`
      );
      assert.equal(loggerState.warnings.length, 1);
      assert.ok(loggerState.warnings[0].message.includes("Query exceeded 200ms threshold (245ms)"));
    });

    it("records slow queries that throw errors and bounds retained history", async () => {
      for (let i = 1; i <= 7; i++) {
        await assert.rejects(
          () =>
            tracer.traceQuery(
              { query: `SELECT pg_sleep(${i})`, model: "Raw", operation: "queryRaw" },
              async () => {
                simulatedClockMs += 250 + i;
                throw new Error(`Query timeout #${i}`);
              }
            ),
          /Query timeout/
        );
      }

      const retained = tracer.getSlowQueries();
      assert.equal(retained.length, 5, "Ring buffer must cap retained slow query records at 5");
      assert.equal(retained[0].query, "SELECT pg_sleep(3)");
      assert.equal(retained[4].query, "SELECT pg_sleep(7)");
      assert.equal(retained[4].status, "ERROR");
      assert.equal(retained[4].error, "Query timeout #7");
    });

    it("traces Prisma model operations via createSlowQueryPrismaExtension", async () => {
      const ext = createSlowQueryPrismaExtension(tracer);
      const res = await ext.query.$allModels.$allOperations({
        model: "Transaction",
        operation: "findMany",
        args: { where: { status: "PENDING" } },
        query: async () => {
          simulatedClockMs += 310;
          return [{ id: "tx-1" }];
        },
      });

      assert.deepEqual(res, [{ id: "tx-1" }]);
      const recorded = tracer.getSlowQueries();
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].query, "Transaction.findMany");
      assert.equal(recorded[0].durationMs, 310);
    });
  });

  describe("Graceful Worker Restart Coordinator & Load Simulation", () => {
    it("waits for existing in-flight jobs to finish, rejects new jobs while draining, and recycles workers before OOM", async () => {
      const { logger } = createTestLogger();
      let currentUsedBytes = 700 * 1024 * 1024;
      const limitBytes = 1000 * 1024 * 1024;
      const lifecycleOrder: string[] = [];

      daemon = new RuntimeTelemetryDaemon({
        warningHeapPercent: 75,
        criticalHeapPercent: 85,
        drainTimeoutMs: 2_000,
        drainPollIntervalMs: 10,
        heapStatsProvider: () => ({
          used_heap_size: currentUsedBytes,
          total_heap_size: 900 * 1024 * 1024,
          heap_size_limit: limitBytes,
        }),
        onRecycle: (report) => {
          lifecycleOrder.push(`onRecycle:${report.drainedJobs}`);
          // Simulate memory freed after worker recycle
          currentUsedBytes = 400 * 1024 * 1024;
        },
        logger,
      });

      daemon.registerWorker({
        name: "live-score-poller",
        stop: async () => {
          lifecycleOrder.push("worker:stop:live-score-poller");
        },
        start: async () => {
          lifecycleOrder.push("worker:start:live-score-poller");
        },
      });

      daemon.registerWorker({
        name: "escrow-event-indexer",
        stop: async () => {
          lifecycleOrder.push("worker:stop:escrow-event-indexer");
        },
        start: async () => {
          lifecycleOrder.push("worker:start:escrow-event-indexer");
        },
      });

      // Start an in-flight job that takes 60ms to complete
      let releaseJob!: () => void;
      const jobGate = new Promise<void>((resolve) => {
        releaseJob = resolve;
      });

      const inFlightPromise = daemon.runInFlightJob("settle-gameweek-38", async () => {
        lifecycleOrder.push("job:started");
        await jobGate;
        lifecycleOrder.push("job:finished");
        return "settled";
      });

      assert.equal(daemon.getInFlightJobCount(), 1);

      // Simulate memory spike to 88% (>= 85% critical threshold)
      currentUsedBytes = 880 * 1024 * 1024;
      const recycleReports: WorkerRecycleReport[] = [];
      daemon.events.on("worker:recycled", (r: WorkerRecycleReport) => recycleReports.push(r));

      const samplePromise = daemon.sampleOnce();

      // Wait a tick so daemon enters DRAINING state while job is still in-flight
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(daemon.getState(), "DRAINING");
      assert.equal(daemon.isAcceptingJobs(), false);

      // Attempting to start a new job while draining must be rejected with WorkerDrainingError
      await assert.rejects(
        () => daemon!.runInFlightJob("new-job-during-drain", async () => "nope"),
        (err: unknown) => err instanceof WorkerDrainingError
      );

      // Now complete the in-flight job; worker recycling must wait for it before stopping workers
      releaseJob();
      const [jobResult] = await Promise.all([inFlightPromise, samplePromise]);
      assert.equal(jobResult, "settled");

      assert.deepEqual(lifecycleOrder, [
        "job:started",
        "job:finished",
        "worker:stop:live-score-poller",
        "worker:start:live-score-poller",
        "worker:stop:escrow-event-indexer",
        "worker:start:escrow-event-indexer",
        "onRecycle:1",
      ]);

      assert.equal(recycleReports.length, 1);
      assert.equal(recycleReports[0].drainedJobs, 1);
      assert.equal(recycleReports[0].timedOut, false);
      assert.deepEqual(recycleReports[0].recycledWorkers, [
        "live-score-poller",
        "escrow-event-indexer",
      ]);
      assert.equal(daemon.getRecycleCount(), 1);
      assert.equal(daemon.getState(), "ACTIVE");
    });

    it("handles load simulation injecting memory retention and artificial slow queries", async () => {
      const { logger } = createTestLogger();
      const retainedBuffers: Buffer[] = [];
      let simulatedHeapUsed = 500 * 1024 * 1024;
      const simulatedHeapLimit = 1000 * 1024 * 1024;

      daemon = new RuntimeTelemetryDaemon({
        warningHeapPercent: 70,
        criticalHeapPercent: 85,
        slowQueryThresholdMs: 200,
        heapStatsProvider: () => ({
          used_heap_size: simulatedHeapUsed,
          total_heap_size: 900 * 1024 * 1024,
          heap_size_limit: simulatedHeapLimit,
        }),
        onRecycle: () => {
          retainedBuffers.length = 0;
          simulatedHeapUsed = 450 * 1024 * 1024;
        },
        logger,
      });

      daemon.registerWorker({
        name: "fpl-tracking-worker",
        stop: () => {
          retainedBuffers.length = 0;
        },
      });

      // Inject 10 concurrent jobs, some executing artificial slow queries (>200ms) and retaining buffers
      const jobs = Array.from({ length: 10 }, (_, idx) =>
        daemon!.runInFlightJob(`matchday-batch-${idx}`, async () => {
          retainedBuffers.push(Buffer.alloc(1024, idx));
          simulatedHeapUsed += 40 * 1024 * 1024;

          if (idx % 3 === 0) {
            await daemon!.slowQueryTracer.traceQuery(
              {
                query: `SELECT * FROM live_match_events WHERE batch = ${idx}`,
                model: "LiveMatchEvent",
                operation: "findMany",
              },
              async () => {
                await new Promise((r) => setTimeout(r, 215));
                return [];
              }
            );
          }
        })
      );

      await Promise.all(jobs);

      // Slow queries for idx 0, 3, 6, 9 (4 queries > 200ms) were traced
      const slowQueries = daemon.slowQueryTracer.getSlowQueries();
      assert.equal(slowQueries.length, 4);
      for (const sq of slowQueries) {
        assert.ok(sq.durationMs >= 200);
        assert.ok(sq.stackTrace.length > 0);
      }

      // Simulated heap is now 900MB / 1000MB (90% >= 85% critical) -> sampleOnce recycles worker & frees memory
      await daemon.sampleOnce();
      assert.equal(daemon.getRecycleCount(), 1);
      assert.equal(retainedBuffers.length, 0);
      assert.equal(daemon.collectHeapMetrics().heapUsagePercent, 45);
    });
  });
});
