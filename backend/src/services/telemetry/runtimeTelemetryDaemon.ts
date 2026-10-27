/**
 * Runtime Telemetry Daemon & Worker Recycling Coordinator
 *
 * Implements continuous runtime telemetry tracking:
 * 1. V8 Heap usage, RSS, and threshold-based memory leak alerting.
 * 2. Event loop delay metrics via Node.js perf_hooks.
 * 3. Garbage collection cycle observability.
 * 4. Slow database query tracer (>200ms) with execution duration and stack traces.
 * 5. Graceful worker recycling coordinator ensuring in-flight jobs finish before termination.
 *
 * Built strictly on Node.js built-ins (`v8` and `perf_hooks`) with zero external APM dependencies.
 * Closes #366
 */

import v8 from "node:v8";
import { monitorEventLoopDelay, performance, PerformanceObserver, IntervalHistogram } from "node:perf_hooks";
import { logger } from "../../config/logger.js";

export interface MemoryMetrics {
  totalHeapMb: number;
  usedHeapMb: number;
  heapLimitMb: number;
  heapUsagePercent: number;
  externalMb: number;
  rssMb: number;
}

export interface EventLoopMetrics {
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
}

export interface GcMetrics {
  totalRuns: number;
  totalDurationMs: number;
  majorGcRuns: number;
  minorGcRuns: number;
}

export interface MemoryWarning {
  level: "WARNING" | "CRITICAL";
  heapUsagePercent: number;
  usedHeapMb: number;
  heapLimitMb: number;
  message: string;
  timestamp: Date;
}

export interface SlowQueryEvent {
  query: string;
  durationMs: number;
  thresholdMs: number;
  stackTrace: string;
  timestamp: Date;
}

export interface RuntimeTelemetryOptions {
  heapWarningThresholdPercent?: number; // default 75%
  heapCriticalThresholdPercent?: number; // default 85%
  checkIntervalMs?: number; // default 10_000ms
  slowQueryThresholdMs?: number; // default 200ms
  enableGcTracking?: boolean; // default true
  onWarning?: (warning: MemoryWarning) => void;
  onCritical?: (critical: MemoryWarning) => void;
  onSlowQuery?: (slowQuery: SlowQueryEvent) => void;
  recyclingCoordinator?: WorkerRecyclingCoordinator;
}

export class RuntimeTelemetryDaemon {
  private readonly heapWarningThresholdPercent: number;
  private readonly heapCriticalThresholdPercent: number;
  private readonly checkIntervalMs: number;
  private readonly slowQueryThresholdMs: number;
  private readonly onWarning?: (warning: MemoryWarning) => void;
  private readonly onCritical?: (critical: MemoryWarning) => void;
  private readonly onSlowQuery?: (slowQuery: SlowQueryEvent) => void;
  private readonly recyclingCoordinator?: WorkerRecyclingCoordinator;

  private timer: NodeJS.Timeout | null = null;
  private eventLoopHistogram: IntervalHistogram | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private gcStats: GcMetrics = {
    totalRuns: 0,
    totalDurationMs: 0,
    majorGcRuns: 0,
    minorGcRuns: 0,
  };
  private slowQueries: SlowQueryEvent[] = [];

  constructor(options: RuntimeTelemetryOptions = {}) {
    this.heapWarningThresholdPercent = options.heapWarningThresholdPercent ?? 75;
    this.heapCriticalThresholdPercent = options.heapCriticalThresholdPercent ?? 85;
    this.checkIntervalMs = options.checkIntervalMs ?? 10_000;
    this.slowQueryThresholdMs = options.slowQueryThresholdMs ?? 200;
    this.onWarning = options.onWarning;
    this.onCritical = options.onCritical;
    this.onSlowQuery = options.onSlowQuery;
    this.recyclingCoordinator = options.recyclingCoordinator;

    if (options.enableGcTracking !== false) {
      this.initGcObserver();
    }
  }

  public start(): void {
    if (this.timer) return;

    try {
      this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopHistogram.enable();
    } catch {
      // Event loop delay unavailable in some test mock environments
    }

    this.timer = setInterval(() => {
      this.sampleAndCheck();
    }, this.checkIntervalMs);
    this.timer.unref?.();

    // Initial check
    this.sampleAndCheck();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eventLoopHistogram) {
      this.eventLoopHistogram.disable();
      this.eventLoopHistogram = null;
    }
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
  }

  public getHeapMetrics(): MemoryMetrics {
    const heapStats = v8.getHeapStatistics();
    const mem = process.memoryUsage();

    const usedHeapMb = Math.round((heapStats.used_heap_size / (1024 * 1024)) * 100) / 100;
    const totalHeapMb = Math.round((heapStats.total_heap_size / (1024 * 1024)) * 100) / 100;
    const heapLimitMb = Math.round((heapStats.heap_size_limit / (1024 * 1024)) * 100) / 100;
    const heapUsagePercent = Math.round((heapStats.used_heap_size / heapStats.heap_size_limit) * 10000) / 100;

    return {
      usedHeapMb,
      totalHeapMb,
      heapLimitMb,
      heapUsagePercent,
      externalMb: Math.round((mem.external / (1024 * 1024)) * 100) / 100,
      rssMb: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
    };
  }

  public getEventLoopMetrics(): EventLoopMetrics {
    if (!this.eventLoopHistogram) {
      return { minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0 };
    }

    const toMs = (nanos: number) => Math.round((nanos / 1_000_000) * 100) / 100;

    return {
      minMs: toMs(this.eventLoopHistogram.min),
      maxMs: toMs(this.eventLoopHistogram.max),
      meanMs: toMs(this.eventLoopHistogram.mean),
      p50Ms: toMs(this.eventLoopHistogram.percentile(50)),
      p90Ms: toMs(this.eventLoopHistogram.percentile(90)),
      p99Ms: toMs(this.eventLoopHistogram.percentile(99)),
    };
  }

  public getGcMetrics(): GcMetrics {
    return { ...this.gcStats };
  }

  public getSlowQueries(): SlowQueryEvent[] {
    return [...this.slowQueries];
  }

  /**
   * Traces an asynchronous database operation or work block.
   * Logs warnings and stores stack trace if execution exceeds slowQueryThresholdMs (>200ms).
   */
  public async traceQuery<T>(queryDescription: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      if (durationMs >= this.slowQueryThresholdMs) {
        const stackTrace = new Error().stack || "";
        const event: SlowQueryEvent = {
          query: queryDescription,
          durationMs,
          thresholdMs: this.slowQueryThresholdMs,
          stackTrace,
          timestamp: new Date(),
        };

        this.slowQueries.push(event);
        if (this.slowQueries.length > 100) {
          this.slowQueries.shift();
        }

        logger.warn(
          {
            component: "slowQueryTracer",
            query: queryDescription,
            durationMs,
            thresholdMs: this.slowQueryThresholdMs,
          },
          `[SlowQuery] Query took ${durationMs}ms (exceeds threshold ${this.slowQueryThresholdMs}ms)`
        );

        this.onSlowQuery?.(event);
      }
    }
  }

  public sampleAndCheck(): MemoryWarning | null {
    const metrics = this.getHeapMetrics();

    if (metrics.heapUsagePercent >= this.heapCriticalThresholdPercent) {
      const warning: MemoryWarning = {
        level: "CRITICAL",
        heapUsagePercent: metrics.heapUsagePercent,
        usedHeapMb: metrics.usedHeapMb,
        heapLimitMb: metrics.heapLimitMb,
        message: `V8 Heap at ${metrics.heapUsagePercent}% (${metrics.usedHeapMb}MB / ${metrics.heapLimitMb}MB) crosses CRITICAL threshold (${this.heapCriticalThresholdPercent}%)`,
        timestamp: new Date(),
      };

      logger.error({ component: "telemetryDaemon", ...warning }, warning.message);
      this.onCritical?.(warning);

      // Trigger automated safe recycling if coordinator attached
      if (this.recyclingCoordinator && this.recyclingCoordinator.getState() === "ACTIVE") {
        void this.recyclingCoordinator.recycle(`Heap usage exceeded critical threshold: ${metrics.heapUsagePercent}%`);
      }

      return warning;
    }

    if (metrics.heapUsagePercent >= this.heapWarningThresholdPercent) {
      const warning: MemoryWarning = {
        level: "WARNING",
        heapUsagePercent: metrics.heapUsagePercent,
        usedHeapMb: metrics.usedHeapMb,
        heapLimitMb: metrics.heapLimitMb,
        message: `V8 Heap at ${metrics.heapUsagePercent}% (${metrics.usedHeapMb}MB / ${metrics.heapLimitMb}MB) crosses WARNING threshold (${this.heapWarningThresholdPercent}%)`,
        timestamp: new Date(),
      };

      logger.warn({ component: "telemetryDaemon", ...warning }, warning.message);
      this.onWarning?.(warning);
      return warning;
    }

    return null;
  }

  private initGcObserver(): void {
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gcStats.totalRuns++;
          this.gcStats.totalDurationMs += entry.duration;
          // PerformanceGCKind: 1 = GCKind.MAJOR, 2 = GCKind.MINOR
          const detail = (entry as any).detail;
          if (detail?.kind === 1) {
            this.gcStats.majorGcRuns++;
          } else {
            this.gcStats.minorGcRuns++;
          }
        }
      });

      this.gcObserver.observe({ entryTypes: ["gc"] });
    } catch {
      // GC observation non-fatal
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Recycling Coordinator (Graceful Zero-Downtime Worker Draining)
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerState = "ACTIVE" | "DRAINING" | "RECYCLED";

export interface WorkerRecyclingOptions {
  drainTimeoutMs?: number; // default 15_000ms
  onRecycle?: (reason: string) => Promise<void> | void;
}

export class WorkerRecyclingCoordinator {
  private state: WorkerState = "ACTIVE";
  private inFlightJobs = 0;
  private readonly drainTimeoutMs: number;
  private readonly onRecycleCallback?: (reason: string) => Promise<void> | void;
  private recyclePromise: Promise<void> | null = null;
  private recycleReason = "";

  constructor(options: WorkerRecyclingOptions = {}) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? 15_000;
    this.onRecycleCallback = options.onRecycle;
  }

  public getState(): WorkerState {
    return this.state;
  }

  public getInFlightJobs(): number {
    return this.inFlightJobs;
  }

  public getRecycleReason(): string {
    return this.recycleReason;
  }

  /**
   * Tracks an in-flight job.
   * Throws if worker is currently DRAINING or RECYCLED.
   */
  public acquireJob(): () => void {
    if (this.state !== "ACTIVE") {
      throw new Error(`Worker is currently ${this.state}; cannot accept new jobs`);
    }

    this.inFlightJobs++;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.inFlightJobs--;
    };
  }

  /**
   * Initiates zero-downtime draining and worker recycling.
   * Waits for in-flight jobs to complete up to drainTimeoutMs before executing recycling hooks.
   */
  public async recycle(reason: string): Promise<void> {
    if (this.recyclePromise) return this.recyclePromise;

    this.recycleReason = reason;
    this.state = "DRAINING";
    logger.warn({ inFlightJobs: this.inFlightJobs, reason }, `[WorkerRecycling] Initiating worker drain: ${reason}`);

    this.recyclePromise = (async () => {
      const started = Date.now();

      // Wait for in-flight jobs to finish
      while (this.inFlightJobs > 0) {
        if (Date.now() - started >= this.drainTimeoutMs) {
          logger.error(
            { inFlightRemaining: this.inFlightJobs },
            `[WorkerRecycling] Drain timeout (${this.drainTimeoutMs}ms) exceeded; forcing recycle`
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      this.state = "RECYCLED";
      logger.info({ reason }, "[WorkerRecycling] All in-flight jobs drained; executing recycling hooks");

      if (this.onRecycleCallback) {
        await this.onRecycleCallback(reason);
      }
    })();

    return this.recyclePromise;
  }
}
