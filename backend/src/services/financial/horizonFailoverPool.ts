/**
 * Automated Horizon & Soroban RPC Node Failover and Latency Health-Checking Pool (Issue #359)
 *
 * Manages a pool of Stellar Horizon or Soroban RPC endpoints for worker and
 * financial services:
 * 1. Active Heartbeat & Ledger Sync Height Benchmarking:
 *    - Periodically probes each endpoint to measure round-trip latency (ms) and
 *      current ledger sequence height (`ledgerSequence`).
 *    - Marks nodes lagging behind the pool's highest ledger height by more than
 *      `maxLedgerLag` or exceeding `degradedLatencyThresholdMs` as degraded.
 * 2. Dynamic Lowest-Latency Routing:
 *    - Routes network operations to the healthy, synced provider with the lowest
 *      measured latency (`emaLatencyMs`).
 * 3. Sub-500ms Failover & Circuit Breaking:
 *    - Immediately trips or increments circuit breaker state on HTTP 5xx, 429,
 *      timeouts, or abrupt socket closures (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`)
 *      and retries transparently on the next lowest-latency healthy provider.
 * 4. Automatic Reinstatement & Telemetry:
 *    - Reinstates degraded/open nodes after `reinstatementSuccessThreshold`
 *      consecutive healthy probes and emits structured telemetry events.
 */

import { EventEmitter } from "node:events";
import { CircuitState } from "../fpl/circuitBreaker.js";

export { CircuitState };

export interface RpcNodeConfig<TClient = unknown> {
  id?: string;
  url: string;
  priority?: number;
  client?: TClient;
}

export interface HealthProbeResult {
  ledgerSequence: number;
  latencyMs?: number;
}

export type HealthProbeFn<TClient> = (
  client: TClient,
  url: string
) => Promise<HealthProbeResult>;

export interface PooledRpcNode<TClient = unknown> {
  id: string;
  url: string;
  priority: number;
  client: TClient;
  healthy: boolean;
  circuitState: CircuitState;
  latencyMs: number | null;
  emaLatencyMs: number | null;
  ledgerSequence: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalFailures: number;
  openedAt: number | null;
  nextAttemptAt: number;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export interface PooledNodeStatus {
  id: string;
  url: string;
  priority: number;
  healthy: boolean;
  eligible: boolean;
  circuitState: CircuitState;
  latencyMs: number | null;
  emaLatencyMs: number | null;
  ledgerSequence: number | null;
  ledgerLag: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalFailures: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface FailoverTelemetryEvent {
  fromNodeId: string;
  fromUrl: string;
  toNodeId: string;
  toUrl: string;
  reason: string;
  failoverDurationMs: number;
  timestamp: string;
}

export interface LatencyTelemetryEvent {
  nodeId: string;
  url: string;
  latencyMs: number;
  emaLatencyMs: number;
  ledgerSequence: number | null;
  source: "heartbeat" | "request";
  timestamp: string;
}

export interface StellarNodeFailoverPoolOptions<TClient = unknown> {
  nodes: Array<RpcNodeConfig<TClient> | string>;
  createClient?: (url: string) => TClient;
  probe?: HealthProbeFn<TClient>;
  /** Consecutive failures before tripping node circuit to OPEN (default: 2) */
  failureThreshold?: number;
  /** Consecutive healthy probes required to reinstate a degraded/OPEN node (default: 2) */
  reinstatementSuccessThreshold?: number;
  /** Cooldown in ms before an OPEN node enters HALF_OPEN for probing (default: 10,000ms) */
  cooldownPeriodMs?: number;
  /** Per-attempt timeout in ms so primary failure shifts traffic within <500ms (default: 350ms) */
  requestTimeoutMs?: number;
  /** Timeout in ms for background health check probes (default: 1,500ms) */
  healthCheckTimeoutMs?: number;
  /** Background heartbeat interval in ms (default: 5,000ms) */
  healthCheckIntervalMs?: number;
  /** Maximum allowed ledger lag behind the pool's highest ledger height (default: 5) */
  maxLedgerLag?: number;
  /** Latency ceiling in ms above which a node is considered degraded (default: 2,500ms) */
  degradedLatencyThresholdMs?: number;
  /** EMA smoothing factor alpha in (0, 1] for latency tracking (default: 0.4) */
  emaAlpha?: number;
  now?: () => number;
  emitter?: EventEmitter;
}

export function parseEndpointList(
  rawUrls: string | undefined,
  fallbackUrl: string
): string[] {
  const list = (rawUrls ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [fallbackUrl];
}

/**
 * Determines whether an error represents an upstream node/network failure
 * (HTTP 5xx, 429 rate-limit, timeout, or abrupt socket closure) that warrants
 * circuit breaking and immediate failover to another node.
 */
export function isRetriableNodeError(error: unknown): boolean {
  if (!error) return false;
  const errObj = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    response?: { status?: number };
  };

  const status =
    errObj.status ?? errObj.statusCode ?? errObj.response?.status;
  if (typeof status === "number") {
    if (status >= 500 && status <= 599) return true;
    if (status === 429 || status === 408) return true;
    if (status >= 400 && status < 500) return false;
  }

  const code = String(errObj.code ?? "");
  if (
    /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|ABORT_ERR)$/i.test(
      code
    )
  ) {
    return true;
  }

  const message = String(errObj.message ?? error);
  return /5\d\d|502|503|504|timeout|timed out|socket|econnreset|econnrefused|epipe|abrupt|network|fetch failed|rate limit|bad gateway|service unavailable/i.test(
    message
  );
}

export class StellarNodeFailoverPool<TClient = unknown> {
  public readonly nodes: PooledRpcNode<TClient>[];
  public readonly events: EventEmitter;

  private readonly createClient: (url: string) => TClient;
  private readonly probe?: HealthProbeFn<TClient>;
  private readonly failureThreshold: number;
  private readonly reinstatementSuccessThreshold: number;
  private readonly cooldownPeriodMs: number;
  private readonly requestTimeoutMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly maxLedgerLag: number;
  private readonly degradedLatencyThresholdMs: number;
  private readonly emaAlpha: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: StellarNodeFailoverPoolOptions<TClient>) {
    if (!options.nodes || options.nodes.length === 0) {
      throw new Error("StellarNodeFailoverPool requires at least one RPC node endpoint");
    }

    this.createClient =
      options.createClient ?? ((url: string) => ({ url }) as unknown as TClient);
    this.probe = options.probe;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 2);
    this.reinstatementSuccessThreshold = Math.max(
      1,
      options.reinstatementSuccessThreshold ?? 2
    );
    this.cooldownPeriodMs = Math.max(50, options.cooldownPeriodMs ?? 10_000);
    this.requestTimeoutMs = Math.max(20, options.requestTimeoutMs ?? 350);
    this.healthCheckTimeoutMs = Math.max(50, options.healthCheckTimeoutMs ?? 1_500);
    this.healthCheckIntervalMs = Math.max(100, options.healthCheckIntervalMs ?? 5_000);
    this.maxLedgerLag = Math.max(0, options.maxLedgerLag ?? 5);
    this.degradedLatencyThresholdMs = Math.max(
      50,
      options.degradedLatencyThresholdMs ?? 2_500
    );
    this.emaAlpha = options.emaAlpha ?? 0.4;
    this.now = options.now ?? (() => Date.now());
    this.events = options.emitter ?? new EventEmitter();

    this.nodes = options.nodes.map((entry, idx) => {
      const normalized: RpcNodeConfig<TClient> =
        typeof entry === "string" ? { url: entry } : entry;
      const id = normalized.id ?? `rpc-node-${idx + 1}`;
      return {
        id,
        url: normalized.url,
        priority: normalized.priority ?? idx,
        client: normalized.client ?? this.createClient(normalized.url),
        healthy: true,
        circuitState: CircuitState.CLOSED,
        latencyMs: null,
        emaLatencyMs: null,
        ledgerSequence: null,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        totalFailures: 0,
        openedAt: null,
        nextAttemptAt: 0,
        lastCheckedAt: null,
        lastError: null,
      };
    });
  }

  /**
   * Returns the highest ledger sequence reported across all nodes in the pool.
   */
  public getMaxObservedLedger(): number {
    let maxLedger = 0;
    for (const node of this.nodes) {
      if (node.ledgerSequence !== null && node.ledgerSequence > maxLedger) {
        maxLedger = node.ledgerSequence;
      }
    }
    return maxLedger;
  }

  public getNodeLedgerLag(node: PooledRpcNode<TClient>): number {
    const maxLedger = this.getMaxObservedLedger();
    if (maxLedger === 0 || node.ledgerSequence === null) return 0;
    return Math.max(0, maxLedger - node.ledgerSequence);
  }

  private refreshCircuitState(node: PooledRpcNode<TClient>): CircuitState {
    if (
      node.circuitState === CircuitState.OPEN &&
      this.now() >= node.nextAttemptAt
    ) {
      node.circuitState = CircuitState.HALF_OPEN;
      node.consecutiveSuccesses = 0;
    }
    return node.circuitState;
  }

  public isNodeEligible(node: PooledRpcNode<TClient>): boolean {
    const state = this.refreshCircuitState(node);
    if (state === CircuitState.OPEN || !node.healthy) {
      return false;
    }
    if (this.getNodeLedgerLag(node) > this.maxLedgerLag) {
      return false;
    }
    if (
      node.emaLatencyMs !== null &&
      node.emaLatencyMs > this.degradedLatencyThresholdMs
    ) {
      return false;
    }
    return true;
  }

  /**
   * Returns all eligible nodes sorted by lowest latency (`emaLatencyMs ?? latencyMs`),
   * then by configured priority.
   */
  public getRankedCandidates(): PooledRpcNode<TClient>[] {
    const eligible = this.nodes.filter((n) => this.isNodeEligible(n));
    const pool =
      eligible.length > 0
        ? eligible
        : // Fallback when all circuits are open/degraded: try HALF_OPEN first, then earliest cooldown
          [...this.nodes].sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

    return [...pool].sort((a, b) => {
      const aLat = a.emaLatencyMs ?? a.latencyMs ?? Infinity;
      const bLat = b.emaLatencyMs ?? b.latencyMs ?? Infinity;
      if (aLat !== bLat) return aLat - bLat;
      return a.priority - b.priority;
    });
  }

  /**
   * Dynamically selects the lowest-latency healthy provider.
   */
  public selectHealthyNode(): PooledRpcNode<TClient> {
    return this.getRankedCandidates()[0];
  }

  private updateLatency(
    node: PooledRpcNode<TClient>,
    measuredMs: number,
    ledgerSequence: number | null,
    source: "heartbeat" | "request"
  ): void {
    const rounded = Math.max(0, Math.round(measuredMs * 100) / 100);
    node.latencyMs = rounded;
    node.emaLatencyMs =
      node.emaLatencyMs === null
        ? rounded
        : Math.round(
            (this.emaAlpha * rounded + (1 - this.emaAlpha) * node.emaLatencyMs) *
              100
          ) / 100;

    if (ledgerSequence !== null && Number.isFinite(ledgerSequence)) {
      node.ledgerSequence = ledgerSequence;
    }

    const telemetryEvent: LatencyTelemetryEvent = {
      nodeId: node.id,
      url: node.url,
      latencyMs: node.latencyMs,
      emaLatencyMs: node.emaLatencyMs,
      ledgerSequence: node.ledgerSequence,
      source,
      timestamp: new Date(this.now()).toISOString(),
    };
    this.events.emit("telemetry:latency", telemetryEvent);
  }

  public recordNodeSuccess(
    node: PooledRpcNode<TClient>,
    latencyMs: number,
    ledgerSequence: number | null = null,
    source: "heartbeat" | "request" = "request"
  ): void {
    this.refreshCircuitState(node);
    this.updateLatency(node, latencyMs, ledgerSequence, source);
    node.consecutiveFailures = 0;
    node.consecutiveSuccesses += 1;
    node.lastError = null;

    const withinLatencyThreshold =
      latencyMs <= this.degradedLatencyThresholdMs;
    const withinLedgerLag =
      this.getNodeLedgerLag(node) <= this.maxLedgerLag;

    if (!withinLatencyThreshold || !withinLedgerLag) {
      const reason = !withinLedgerLag
        ? `Ledger lag ${this.getNodeLedgerLag(node)} exceeds maxLedgerLag ${this.maxLedgerLag}`
        : `Latency ${latencyMs}ms exceeds threshold ${this.degradedLatencyThresholdMs}ms`;
      node.healthy = false;
      node.lastError = reason;
      this.events.emit("node:degraded", {
        nodeId: node.id,
        url: node.url,
        reason,
        latencyMs,
        ledgerSequence: node.ledgerSequence,
      });
      return;
    }

    if (
      node.circuitState === CircuitState.HALF_OPEN ||
      !node.healthy
    ) {
      if (node.consecutiveSuccesses >= this.reinstatementSuccessThreshold) {
        node.circuitState = CircuitState.CLOSED;
        node.healthy = true;
        node.openedAt = null;
        node.nextAttemptAt = 0;
        this.events.emit("node:reinstated", {
          nodeId: node.id,
          url: node.url,
          latencyMs: node.latencyMs,
          ledgerSequence: node.ledgerSequence,
          consecutiveSuccesses: node.consecutiveSuccesses,
        });
      }
    } else {
      node.healthy = true;
    }
  }

  public recordNodeFailure(
    node: PooledRpcNode<TClient>,
    error: unknown,
    tripImmediately = false
  ): void {
    const errMsg = (error as Error)?.message ?? String(error);
    node.consecutiveFailures += 1;
    node.consecutiveSuccesses = 0;
    node.totalFailures += 1;
    node.lastError = errMsg;

    if (
      tripImmediately ||
      node.circuitState === CircuitState.HALF_OPEN ||
      node.consecutiveFailures >= this.failureThreshold
    ) {
      const nowMs = this.now();
      node.circuitState = CircuitState.OPEN;
      node.healthy = false;
      node.openedAt = nowMs;
      node.nextAttemptAt = nowMs + this.cooldownPeriodMs;
      this.events.emit("node:degraded", {
        nodeId: node.id,
        url: node.url,
        reason: errMsg,
        circuitState: node.circuitState,
        consecutiveFailures: node.consecutiveFailures,
      });
    }
  }

  /**
   * Runs a single active health check against `node` measuring latency and ledger height.
   */
  public async checkNodeHealth(node: PooledRpcNode<TClient>): Promise<boolean> {
    if (!this.probe) {
      node.lastCheckedAt = new Date(this.now());
      return node.healthy;
    }

    this.refreshCircuitState(node);
    const startMs = performance.now();

    try {
      const result = await this.withTimeout(
        () => this.probe!(node.client, node.url),
        this.healthCheckTimeoutMs,
        `Health check timed out after ${this.healthCheckTimeoutMs}ms for ${node.url}`
      );
      const measuredMs = result.latencyMs ?? performance.now() - startMs;
      this.recordNodeSuccess(
        node,
        measuredMs,
        result.ledgerSequence,
        "heartbeat"
      );
      return node.healthy;
    } catch (error) {
      this.recordNodeFailure(node, error, false);
      return false;
    } finally {
      node.lastCheckedAt = new Date(this.now());
    }
  }

  /**
   * Probes all nodes concurrently and re-evaluates ledger lag across the pool.
   */
  public async checkAllNodes(): Promise<PooledNodeStatus[]> {
    await Promise.all(this.nodes.map((node) => this.checkNodeHealth(node)));

    // Second pass: if a node passed its individual probe before a higher ledger was
    // recorded by a peer in the same batch, enforce maxLedgerLag across the pool.
    for (const node of this.nodes) {
      const lag = this.getNodeLedgerLag(node);
      if (node.healthy && lag > this.maxLedgerLag) {
        node.healthy = false;
        node.lastError = `Ledger lag ${lag} exceeds maxLedgerLag ${this.maxLedgerLag}`;
        this.events.emit("node:degraded", {
          nodeId: node.id,
          url: node.url,
          reason: node.lastError,
          ledgerLag: lag,
        });
      }
    }

    return this.getPoolStatus();
  }

  /**
   * Executes an operation against the lowest-latency healthy node with automatic
   * sub-500ms failover if the selected endpoint degrades, times out, or drops its socket.
   */
  public async execute<TResult>(
    operation: (client: TClient, node: PooledRpcNode<TClient>) => Promise<TResult>
  ): Promise<TResult> {
    const candidates = this.getRankedCandidates();
    let lastError: unknown;
    const failoverStartedAt = performance.now();

    for (let i = 0; i < candidates.length; i++) {
      const node = candidates[i];
      node.totalRequests += 1;
      const attemptStartedAt = performance.now();

      try {
        const result = await this.withTimeout(
          () => operation(node.client, node),
          this.requestTimeoutMs,
          `RPC request to ${node.url} timed out after ${this.requestTimeoutMs}ms`
        );
        const elapsedMs = performance.now() - attemptStartedAt;
        this.recordNodeSuccess(node, elapsedMs, null, "request");

        if (i > 0) {
          const primaryNode = candidates[0];
          const failoverEvent: FailoverTelemetryEvent = {
            fromNodeId: primaryNode.id,
            fromUrl: primaryNode.url,
            toNodeId: node.id,
            toUrl: node.url,
            reason:
              (lastError as Error)?.message ?? "Primary provider unavailable",
            failoverDurationMs:
              Math.round((performance.now() - failoverStartedAt) * 100) / 100,
            timestamp: new Date(this.now()).toISOString(),
          };
          this.events.emit("pool:failover", failoverEvent);
        }

        return result;
      } catch (error) {
        lastError = error;
        if (!isRetriableNodeError(error)) {
          throw error;
        }
        // Trip immediately on 5xx / socket closure / timeout during live traffic so
        // subsequent requests route directly to the healthy secondary without delay
        this.recordNodeFailure(node, error, true);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("All Stellar RPC providers in failover pool failed");
  }

  public startHeartbeat(): void {
    if (this.timer) return;
    void this.checkAllNodes();
    this.timer = setInterval(() => {
      void this.checkAllNodes();
    }, this.healthCheckIntervalMs);
    this.timer.unref?.();
  }

  public stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getPoolStatus(): PooledNodeStatus[] {
    return this.nodes.map((node) => ({
      id: node.id,
      url: node.url,
      priority: node.priority,
      healthy: node.healthy,
      eligible: this.isNodeEligible(node),
      circuitState: this.refreshCircuitState(node),
      latencyMs: node.latencyMs,
      emaLatencyMs: node.emaLatencyMs,
      ledgerSequence: node.ledgerSequence,
      ledgerLag: this.getNodeLedgerLag(node),
      consecutiveFailures: node.consecutiveFailures,
      consecutiveSuccesses: node.consecutiveSuccesses,
      totalRequests: node.totalRequests,
      totalFailures: node.totalFailures,
      lastCheckedAt: node.lastCheckedAt?.toISOString() ?? null,
      lastError: node.lastError,
    }));
  }

  private async withTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(timeoutMessage) as Error & { code?: string };
            err.code = "ETIMEDOUT";
            reject(err);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
