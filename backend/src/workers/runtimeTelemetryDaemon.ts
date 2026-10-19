/**
 * Real-Time Memory Leak, Event Loop Lag & Slow Query Tracer Daemon (Issue #366)
 *
 * Self-contained runtime telemetry and graceful worker recycling daemon for
 * long-running background workers (live match feeds, event indexers, queue workers):
 *
 * 1. V8 Heap & GC Instrumentation (`node:v8`, `node:perf_hooks`):
 *    - Samples V8 heap usage (`used_heap_size`, `total_heap_size`, `heap_size_limit`,
 *      `external_memory`, `malloced_memory`) and computes percentage against limit.
 *    - Tracks garbage collection cycles and pause durations via `PerformanceObserver`.
 *    - Detects sustained heap growth across consecutive samples (memory leak trend)
 *      and emits warnings when heap usage crosses configured percentage thresholds.
 *
 * 2. Event Loop Delay Monitor (`node:perf_hooks.monitorEventLoopDelay`):
 *    - Continuously measures event loop lag (`mean`, `max`, `p95`, `p99` in ms)
 *      and emits lag alerts when delay exceeds configured thresholds.
 *
 * 3. Slow Query Tracer (>200ms default threshold):
 *    - Captures caller stack traces prior to async query execution so call sites
 *      are preserved across async boundaries.
 *    - Logs detailed query metadata, sanitized parameters, execution duration,
 *      W3C traceId context, and stack traces for queries exceeding 200ms.
 *    - Provides a Prisma client extension and raw client wrapper.
 *
 * 4. Graceful Worker Restart Coordinator:
 *    - Tracks active in-flight jobs and registered background workers.
 *    - Rejects new jobs once draining starts, waits for all in-flight jobs to
 *      finish (up to `drainTimeoutMs`), stops and restarts managed workers for
 *      zero-downtime recycling before Out-Of-Memory (OOM) termination.
 */

import { EventEmitter } from "node:events";
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
  type IntervalHistogram,
} from "node:perf_hooks";
import v8 from "node:v8";
import {
  generateTraceId,
  sanitizeSpanAttributes,
  traceStorage,
} from "../config/tracing.js";

export interface V8HeapMetrics {
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapSizeLimitBytes: number;
  externalBytes: number;
  mallocedMemoryBytes: number;
  heapUsagePercent: number;
}

export interface EventLoopDelayMetrics {
  meanMs: number;
  maxMs: number;
  p95Ms: number;
  p99Ms: number;
}

export interface GcCycleMetrics {
  totalCycles: number;
  lastGcDurationMs: number;
  maxGcDurationMs: number;
  lastGcKind: number | null;
}

export interface TelemetrySnapshot {
  timestamp: string;
  heap: V8HeapMetrics;
  eventLoop: EventLoopDelayMetrics;
  gc: GcCycleMetrics;
  consecutiveHeapGrowthSamples: number;
  inFlightJobs: number;
  workerState: WorkerLifecycleState;
  recycleCount: number;
}

export interface HeapAlertPayload {
  level: "WARNING" | "CRITICAL" | "LEAK_SUSPECTED";
  heapUsagePercent: number;
  thresholdPercent: number;
  heapUsedBytes: number;
  heapSizeLimitBytes: number;
  consecutiveGrowthSamples: number;
  timestamp: string;
}

export interface EventLoopLagAlertPayload {
  p99Ms: number;
  maxMs: number;
  thresholdMs: number;
  timestamp: string;
}

export interface SlowQueryContext {
  query: string;
  model?: string;
  operation?: string;
  params?: Record<string, unknown>;
}

export interface SlowQueryRecord {
  query: string;
  model?: string;
  operation?: string;
  durationMs: number;
  thresholdMs: number;
  traceId: string;
  stackTrace: string;
  params: Record<string, unknown>;
  status: "OK" | "ERROR";
  error?: string;
  timestamp: string;
}

export type WorkerLifecycleState = "ACTIVE" | "DRAINING" | "RECYCLING" | "STOPPED";

export interface ManagedWorker {
  name: string;
  stop: () => Promise<void> | void;
  start?: () => Promise<void> | void;
}

export interface WorkerRecycleReport {
  reason: string;
  drainedJobs: number;
  timedOut: boolean;
  recycledWorkers: string[];
  durationMs: number;
  heapUsagePercentAtTrigger: number;
  timestamp: string;
}

export interface TelemetryLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
}

const defaultLogger: TelemetryLogger = {
  warn: (msg, meta) => console.warn(msg, meta ?? ""),
  error: (msg, meta) => console.error(msg, meta ?? ""),
  info: (msg, meta) => console.log(msg, meta ?? ""),
};

export class WorkerDrainingError extends Error {
  public readonly code = "WORKER_DRAINING";

  constructor(jobName: string) {
    super(`Cannot accept new job "${jobName}" while worker is draining for recycling`);
    this.name = "WorkerDrainingError";
  }
}

export interface SlowQueryTracerOptions {
  /** Threshold in milliseconds above which queries are logged & emitted (default: 200ms) */
  thresholdMs?: number;
  /** Maximum slow query records kept in memory ring buffer (default: 250) */
  maxRetainedRecords?: number;
  logger?: TelemetryLogger;
  emitter?: EventEmitter;
  nowFn?: () => number;
}

/**
 * Captures caller stack traces and execution timing for database queries,
 * emitting alerts and structured logs whenever a query exceeds `thresholdMs` (default 200ms).
 */
export class SlowQueryTracer {
  public readonly thresholdMs: number;
  private readonly maxRetainedRecords: number;
  private readonly logger: TelemetryLogger;
  public readonly events: EventEmitter;
  private readonly nowFn: () => number;
  private readonly records: SlowQueryRecord[] = [];

  constructor(options: SlowQueryTracerOptions = {}) {
    this.thresholdMs = options.thresholdMs ?? 200;
    this.maxRetainedRecords = Math.max(1, options.maxRetainedRecords ?? 250);
    this.logger = options.logger ?? defaultLogger;
    this.events = options.emitter ?? new EventEmitter();
    this.nowFn = options.nowFn ?? (() => performance.now());
  }

  /**
   * Captures a clean caller stack trace before entering async I/O.
   */
  public static captureCallerStack(skipFrames = 2): string {
    const raw = new Error().stack ?? "";
    const lines = raw
      .split("\n")
      .slice(1)
      .map((line) => line.trim());
    return lines.slice(skipFrames).join("\n");
  }

  /**
   * Traces an async database query and records/logs detailed diagnostics if duration > thresholdMs.
   */
  public async traceQuery<T>(
    context: SlowQueryContext,
    executor: () => Promise<T>
  ): Promise<T> {
    const callerStack = SlowQueryTracer.captureCallerStack(2);
    const activeTrace = traceStorage.getStore();
    const traceId = activeTrace?.traceId ?? generateTraceId();
    const startMs = this.nowFn();

    try {
      const result = await executor();
      const durationMs = Number((this.nowFn() - startMs).toFixed(2));
      if (durationMs > this.thresholdMs) {
        this.recordSlowQuery(context, durationMs, traceId, callerStack, "OK");
      }
      return result;
    } catch (err: unknown) {
      const durationMs = Number((this.nowFn() - startMs).toFixed(2));
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (durationMs > this.thresholdMs) {
        this.recordSlowQuery(context, durationMs, traceId, callerStack, "ERROR", errorMsg);
      }
      throw err;
    }
  }

  private recordSlowQuery(
    context: SlowQueryContext,
    durationMs: number,
    traceId: string,
    stackTrace: string,
    status: "OK" | "ERROR",
    error?: string
  ): void {
    const sanitizedParams = context.params
      ? sanitizeSpanAttributes(context.params)
      : {};

    const record: SlowQueryRecord = {
      query: context.query,
      model: context.model,
      operation: context.operation,
      durationMs,
      thresholdMs: this.thresholdMs,
      traceId,
      stackTrace,
      params: sanitizedParams,
      status,
      ...(error ? { error } : {}),
      timestamp: new Date().toISOString(),
    };

    if (this.records.length >= this.maxRetainedRecords) {
      this.records.shift();
    }
    this.records.push(record);

    this.logger.warn(
      `[SlowQueryTracer] Query exceeded ${this.thresholdMs}ms threshold (${durationMs}ms): ${context.query}`,
      {
        durationMs,
        thresholdMs: this.thresholdMs,
        model: context.model,
        operation: context.operation,
        traceId,
        params: sanitizedParams,
        status,
        error,
        stackTrace,
      }
    );

    this.events.emit("query:slow", record);
  }

  public getSlowQueries(): SlowQueryRecord[] {
    return [...this.records];
  }

  public clear(): void {
    this.records.length = 0;
  }
}

/**
 * Creates a Prisma `$extends` query component that routes all model queries
 * through the provided `SlowQueryTracer`.
 */
export function createSlowQueryPrismaExtension(tracer: SlowQueryTracer) {
  return {
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
        }) {
          return tracer.traceQuery(
            {
              query: `${model ?? "raw"}.${operation}`,
              model,
              operation,
              params: args && typeof args === "object" ? args : {},
            },
            () => query(args)
          );
        },
      },
    },
  };
}

export interface RuntimeTelemetryDaemonOptions {
  /** Sampling interval in milliseconds (default: 5,000ms) */
  sampleIntervalMs?: number;
  /** Heap usage percentage at which a warning is emitted (default: 75%) */
  warningHeapPercent?: number;
  /** Heap usage percentage at which critical alert & graceful worker recycling triggers (default: 85%) */
  criticalHeapPercent?: number;
  /** Number of consecutive monotonically increasing heap samples to flag a suspected leak (default: 5) */
  leakConsecutiveSamplesThreshold?: number;
  /** Minimum byte delta per sample to count toward monotonic heap growth (default: 64 KB) */
  minGrowthDeltaBytes?: number;
  /** Event loop p99/max delay threshold in milliseconds (default: 100ms) */
  eventLoopLagThresholdMs?: number;
  /** Slow query threshold in milliseconds (default: 200ms) */
  slowQueryThresholdMs?: number;
  /** Maximum time in milliseconds to wait for in-flight jobs to drain before recycling (default: 10,000ms) */
  drainTimeoutMs?: number;
  /** Poll interval while waiting for in-flight jobs to drain (default: 25ms) */
  drainPollIntervalMs?: number;
  /** Optional override for heap size limit in bytes */
  heapLimitOverrideBytes?: number;
  /** Optional custom provider for V8 heap statistics (used for deterministic testing) */
  heapStatsProvider?: () => {
    used_heap_size: number;
    total_heap_size: number;
    heap_size_limit: number;
    external_memory?: number;
    malloced_memory?: number;
  };
  /** Optional custom provider for event loop delay metrics (used for deterministic testing) */
  eventLoopMetricsProvider?: () => EventLoopDelayMetrics;
  /** Optional callback executed during worker recycling after workers stop */
  onRecycle?: (report: WorkerRecycleReport) => Promise<void> | void;
  logger?: TelemetryLogger;
  emitter?: EventEmitter;
}

export class RuntimeTelemetryDaemon {
  private readonly sampleIntervalMs: number;
  private readonly warningHeapPercent: number;
  private readonly criticalHeapPercent: number;
  private readonly leakConsecutiveSamplesThreshold: number;
  private readonly minGrowthDeltaBytes: number;
  private readonly eventLoopLagThresholdMs: number;
  private readonly drainTimeoutMs: number;
  private readonly drainPollIntervalMs: number;
  private readonly heapLimitOverrideBytes?: number;
  private readonly heapStatsProvider: NonNullable<
    RuntimeTelemetryDaemonOptions["heapStatsProvider"]
  >;
  private readonly eventLoopMetricsProvider?: () => EventLoopDelayMetrics;
  private readonly onRecycle?: (report: WorkerRecycleReport) => Promise<void> | void;
  private readonly logger: TelemetryLogger;

  public readonly events: EventEmitter;
  public readonly slowQueryTracer: SlowQueryTracer;

  private histogram: IntervalHistogram | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: WorkerLifecycleState = "STOPPED";

  private lastHeapUsedBytes: number | null = null;
  private consecutiveHeapGrowthSamples = 0;
  private gcMetrics: GcCycleMetrics = {
    totalCycles: 0,
    lastGcDurationMs: 0,
    maxGcDurationMs: 0,
    lastGcKind: null,
  };

  private readonly inFlightJobs = new Map<string, { name: string; startedAt: number }>();
  private jobCounter = 0;
  private readonly managedWorkers: ManagedWorker[] = [];
  private recycleCount = 0;
  private activeRecyclePromise: Promise<WorkerRecycleReport> | null = null;

  constructor(options: RuntimeTelemetryDaemonOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? 5_000;
    this.warningHeapPercent = options.warningHeapPercent ?? 75;
    this.criticalHeapPercent = options.criticalHeapPercent ?? 85;
    this.leakConsecutiveSamplesThreshold =
      options.leakConsecutiveSamplesThreshold ?? 5;
    this.minGrowthDeltaBytes = options.minGrowthDeltaBytes ?? 64 * 1024;
    this.eventLoopLagThresholdMs = options.eventLoopLagThresholdMs ?? 100;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
    this.drainPollIntervalMs = options.drainPollIntervalMs ?? 25;
    this.heapLimitOverrideBytes = options.heapLimitOverrideBytes;
    this.heapStatsProvider =
      options.heapStatsProvider ?? (() => v8.getHeapStatistics());
    this.eventLoopMetricsProvider = options.eventLoopMetricsProvider;
    this.onRecycle = options.onRecycle;
    this.logger = options.logger ?? defaultLogger;
    this.events = options.emitter ?? new EventEmitter();
    this.slowQueryTracer = new SlowQueryTracer({
      thresholdMs: options.slowQueryThresholdMs ?? 200,
      logger: this.logger,
      emitter: this.events,
    });
  }

  /**
   * Registers a long-running worker or daemon to be gracefully stopped and
   * restarted when memory approaches critical thresholds.
   */
  public registerWorker(worker: ManagedWorker): void {
    this.managedWorkers.push(worker);
  }

  /**
   * Starts continuous V8 heap, GC, and event-loop telemetry collection.
   */
  public start(): void {
    if (this.state === "ACTIVE" || this.state === "DRAINING" || this.state === "RECYCLING") {
      return;
    }

    this.state = "ACTIVE";

    if (!this.eventLoopMetricsProvider && !this.histogram) {
      this.histogram = monitorEventLoopDelay({ resolution: 10 });
      this.histogram.enable();
    }

    if (!this.gcObserver) {
      try {
        this.gcObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
            this.recordGcCycle(entry.duration, detail?.kind ?? null);
          }
        });
        this.gcObserver.observe({ entryTypes: ["gc"] });
      } catch {
        // GC observer may be unavailable in restricted runtimes; continue gracefully
      }
    }

    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.sampleIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the telemetry daemon and releases performance hooks.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
    this.state = "STOPPED";
  }

  public getState(): WorkerLifecycleState {
    return this.state;
  }

  public isAcceptingJobs(): boolean {
    return this.state === "ACTIVE";
  }

  public getInFlightJobCount(): number {
    return this.inFlightJobs.size;
  }

  public getRecycleCount(): number {
    return this.recycleCount;
  }

  /**
   * Records a garbage collection cycle duration (invoked by PerformanceObserver or tests).
   */
  public recordGcCycle(durationMs: number, kind: number | null = null): void {
    this.gcMetrics.totalCycles += 1;
    this.gcMetrics.lastGcDurationMs = Number(durationMs.toFixed(2));
    if (durationMs > this.gcMetrics.maxGcDurationMs) {
      this.gcMetrics.maxGcDurationMs = Number(durationMs.toFixed(2));
    }
    this.gcMetrics.lastGcKind = kind;
  }

  /**
   * Tracks an in-flight background job so graceful worker recycling waits for it
   * to complete before terminating/restarting workers.
   */
  public async runInFlightJob<T>(jobName: string, fn: () => Promise<T>): Promise<T> {
    if (this.state === "DRAINING" || this.state === "RECYCLING") {
      throw new WorkerDrainingError(jobName);
    }

    const jobId = `${jobName}-${++this.jobCounter}`;
    this.inFlightJobs.set(jobId, { name: jobName, startedAt: Date.now() });

    try {
      return await fn();
    } finally {
      this.inFlightJobs.delete(jobId);
      if (this.inFlightJobs.size === 0) {
        this.events.emit("jobs:drained");
      }
    }
  }

  /**
   * Collects current V8 heap metrics and calculates percentage of heap limit used.
   */
  public collectHeapMetrics(): V8HeapMetrics {
    const raw = this.heapStatsProvider();
    const limit =
      this.heapLimitOverrideBytes && this.heapLimitOverrideBytes > 0
        ? this.heapLimitOverrideBytes
        : raw.heap_size_limit;
    const heapUsagePercent =
      limit > 0 ? Number(((raw.used_heap_size / limit) * 100).toFixed(2)) : 0;

    return {
      heapUsedBytes: raw.used_heap_size,
      heapTotalBytes: raw.total_heap_size,
      heapSizeLimitBytes: limit,
      externalBytes: raw.external_memory ?? 0,
      mallocedMemoryBytes: raw.malloced_memory ?? 0,
      heapUsagePercent,
    };
  }

  /**
   * Collects event loop delay percentiles in milliseconds.
   */
  public collectEventLoopMetrics(): EventLoopDelayMetrics {
    if (this.eventLoopMetricsProvider) {
      return this.eventLoopMetricsProvider();
    }

    if (!this.histogram) {
      return { meanMs: 0, maxMs: 0, p95Ms: 0, p99Ms: 0 };
    }

    const nsToMs = (ns: number) =>
      Number.isFinite(ns) && ns > 0 ? Number((ns / 1e6).toFixed(2)) : 0;

    const metrics: EventLoopDelayMetrics = {
      meanMs: nsToMs(this.histogram.mean),
      maxMs: nsToMs(this.histogram.max),
      p95Ms: nsToMs(this.histogram.percentile(95)),
      p99Ms: nsToMs(this.histogram.percentile(99)),
    };

    this.histogram.reset();
    return metrics;
  }

  /**
   * Takes a single telemetry snapshot, evaluates heap/lag thresholds, emits alerts,
   * and triggers graceful worker recycling if critical heap limits are reached.
   */
  public async sampleOnce(): Promise<TelemetrySnapshot> {
    if (this.state === "STOPPED") {
      this.state = "ACTIVE";
    }

    const heap = this.collectHeapMetrics();
    const eventLoop = this.collectEventLoopMetrics();
    const nowIso = new Date().toISOString();

    if (
      this.lastHeapUsedBytes !== null &&
      heap.heapUsedBytes - this.lastHeapUsedBytes >= this.minGrowthDeltaBytes
    ) {
      this.consecutiveHeapGrowthSamples += 1;
    } else if (
      this.lastHeapUsedBytes !== null &&
      heap.heapUsedBytes < this.lastHeapUsedBytes
    ) {
      this.consecutiveHeapGrowthSamples = 0;
    }
    this.lastHeapUsedBytes = heap.heapUsedBytes;

    const snapshot: TelemetrySnapshot = {
      timestamp: nowIso,
      heap,
      eventLoop,
      gc: { ...this.gcMetrics },
      consecutiveHeapGrowthSamples: this.consecutiveHeapGrowthSamples,
      inFlightJobs: this.inFlightJobs.size,
      workerState: this.state,
      recycleCount: this.recycleCount,
    };

    this.events.emit("telemetry:sample", snapshot);

    // 1. Check sustained monotonic heap growth (memory leak trend)
    if (this.consecutiveHeapGrowthSamples >= this.leakConsecutiveSamplesThreshold) {
      const leakAlert: HeapAlertPayload = {
        level: "LEAK_SUSPECTED",
        heapUsagePercent: heap.heapUsagePercent,
        thresholdPercent: this.warningHeapPercent,
        heapUsedBytes: heap.heapUsedBytes,
        heapSizeLimitBytes: heap.heapSizeLimitBytes,
        consecutiveGrowthSamples: this.consecutiveHeapGrowthSamples,
        timestamp: nowIso,
      };
      this.logger.warn(
        `[RuntimeTelemetryDaemon] Suspected memory leak: heap grew across ${this.consecutiveHeapGrowthSamples} consecutive samples (${heap.heapUsagePercent}% used)`,
        leakAlert as unknown as Record<string, unknown>
      );
      this.events.emit("heap:leak_suspected", leakAlert);
    }

    // 2. Check event loop lag threshold
    if (
      eventLoop.p99Ms >= this.eventLoopLagThresholdMs ||
      eventLoop.maxMs >= this.eventLoopLagThresholdMs
    ) {
      const lagAlert: EventLoopLagAlertPayload = {
        p99Ms: eventLoop.p99Ms,
        maxMs: eventLoop.maxMs,
        thresholdMs: this.eventLoopLagThresholdMs,
        timestamp: nowIso,
      };
      this.logger.warn(
        `[RuntimeTelemetryDaemon] Event loop lag threshold exceeded (p99=${eventLoop.p99Ms}ms, max=${eventLoop.maxMs}ms > ${this.eventLoopLagThresholdMs}ms)`,
        lagAlert as unknown as Record<string, unknown>
      );
      this.events.emit("eventloop:lag", lagAlert);
    }

    // 3. Check critical vs warning heap usage thresholds
    if (heap.heapUsagePercent >= this.criticalHeapPercent) {
      const criticalAlert: HeapAlertPayload = {
        level: "CRITICAL",
        heapUsagePercent: heap.heapUsagePercent,
        thresholdPercent: this.criticalHeapPercent,
        heapUsedBytes: heap.heapUsedBytes,
        heapSizeLimitBytes: heap.heapSizeLimitBytes,
        consecutiveGrowthSamples: this.consecutiveHeapGrowthSamples,
        timestamp: nowIso,
      };
      this.logger.error(
        `[RuntimeTelemetryDaemon] CRITICAL heap usage ${heap.heapUsagePercent}% >= ${this.criticalHeapPercent}%; initiating graceful worker recycling`,
        criticalAlert as unknown as Record<string, unknown>
      );
      this.events.emit("heap:warning", criticalAlert);
      this.events.emit("heap:critical", criticalAlert);

      await this.drainAndRecycle(
        `heap_critical_${heap.heapUsagePercent}pct`,
        heap.heapUsagePercent
      );
    } else if (heap.heapUsagePercent >= this.warningHeapPercent) {
      const warningAlert: HeapAlertPayload = {
        level: "WARNING",
        heapUsagePercent: heap.heapUsagePercent,
        thresholdPercent: this.warningHeapPercent,
        heapUsedBytes: heap.heapUsedBytes,
        heapSizeLimitBytes: heap.heapSizeLimitBytes,
        consecutiveGrowthSamples: this.consecutiveHeapGrowthSamples,
        timestamp: nowIso,
      };
      this.logger.warn(
        `[RuntimeTelemetryDaemon] High heap usage warning: ${heap.heapUsagePercent}% >= ${this.warningHeapPercent}%`,
        warningAlert as unknown as Record<string, unknown>
      );
      this.events.emit("heap:warning", warningAlert);
    }

    return snapshot;
  }

  /**
   * Gracefully drains existing in-flight jobs before stopping and restarting
   * registered worker instances (zero-downtime worker recycling before OOM).
   */
  public async drainAndRecycle(
    reason = "manual_recycle",
    heapUsagePercentAtTrigger?: number
  ): Promise<WorkerRecycleReport> {
    if (this.activeRecyclePromise) {
      return this.activeRecyclePromise;
    }

    this.activeRecyclePromise = this.executeDrainAndRecycle(
      reason,
      heapUsagePercentAtTrigger ?? this.collectHeapMetrics().heapUsagePercent
    ).finally(() => {
      this.activeRecyclePromise = null;
    });

    return this.activeRecyclePromise;
  }

  private async executeDrainAndRecycle(
    reason: string,
    heapUsagePercentAtTrigger: number
  ): Promise<WorkerRecycleReport> {
    const startMs = performance.now();
    const initialInFlight = this.inFlightJobs.size;
    this.state = "DRAINING";

    this.events.emit("worker:draining", {
      reason,
      inFlightJobs: initialInFlight,
      heapUsagePercentAtTrigger,
    });

    let timedOut = false;
    const deadline = Date.now() + this.drainTimeoutMs;

    while (this.inFlightJobs.size > 0) {
      if (Date.now() >= deadline) {
        timedOut = true;
        this.logger.warn(
          `[RuntimeTelemetryDaemon] Drain timeout (${this.drainTimeoutMs}ms) reached with ${this.inFlightJobs.size} in-flight job(s) remaining`
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, this.drainPollIntervalMs));
    }

    this.state = "RECYCLING";
    const recycledWorkers: string[] = [];

    for (const worker of this.managedWorkers) {
      try {
        await worker.stop();
        if (worker.start) {
          await worker.start();
        }
        recycledWorkers.push(worker.name);
      } catch (err: unknown) {
        this.logger.error(
          `[RuntimeTelemetryDaemon] Error recycling worker "${worker.name}"`,
          { error: err instanceof Error ? err.message : String(err) }
        );
      }
    }

    this.consecutiveHeapGrowthSamples = 0;
    this.lastHeapUsedBytes = null;
    this.recycleCount += 1;
    this.state = "ACTIVE";

    const report: WorkerRecycleReport = {
      reason,
      drainedJobs: initialInFlight - this.inFlightJobs.size,
      timedOut,
      recycledWorkers,
      durationMs: Number((performance.now() - startMs).toFixed(2)),
      heapUsagePercentAtTrigger,
      timestamp: new Date().toISOString(),
    };

    if (this.onRecycle) {
      await this.onRecycle(report);
    }

    this.logger.info(
      `[RuntimeTelemetryDaemon] Worker recycling completed (${recycledWorkers.length} workers recycled, ${report.drainedJobs} jobs drained)`,
      report as unknown as Record<string, unknown>
    );
    this.events.emit("worker:recycled", report);

    return report;
  }
}

export const runtimeTelemetryDaemon = new RuntimeTelemetryDaemon();
