/**
 * Multi-region read replicas: configuration, health tracking and query routing.
 *
 * Laravel analogy: the `read` / `write` connection split in config/database.php,
 * plus the "sticky" option, but region aware and lag aware.
 *
 * Routing rules (implemented by the Prisma extension below):
 * - Only model *read* operations are eligible, and only inside a request context
 *   that opted in (GET/HEAD requests and the read-only GraphQL endpoint, see
 *   middleware/readConsistency.ts). Writes, POST flows such as payments, workers
 *   and jobs always use the primary, so money never moves on a stale read.
 * - Queries inside a transaction always use the primary.
 * - Once a request context performs a write, its later reads use the primary
 *   (read-your-writes).
 * - The replica is chosen from healthy replicas whose replication lag is within
 *   REPLICA_MAX_LAG_MS: same region as APP_REGION first, then lowest measured
 *   round-trip latency. With no eligible replica, reads fall back to the primary.
 * - A replica that fails with a connection-level error is marked unhealthy and
 *   the query is transparently re-run on the primary.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";

// ============================================================
// Configuration
// ============================================================

export interface ReplicaDefinition {
  region: string;
  url: string;
}

export interface ReadReplicaConfig {
  appRegion: string | null;
  replicas: ReplicaDefinition[];
  maxLagMs: number;
  healthCheckIntervalMs: number;
  healthCheckTimeoutMs: number;
}

/**
 * Parses DATABASE_READ_REPLICAS: comma-separated `region=postgresql://...` entries.
 * Only the first `=` separates the region, so URLs may contain query strings.
 */
export function parseReplicaDefinitions(raw: string | undefined): ReplicaDefinition[] {
  if (!raw?.trim()) return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      const region = separator > 0 ? entry.slice(0, separator).trim() : "";
      const url = separator > 0 ? entry.slice(separator + 1).trim() : "";
      if (!region || !/^postgres(ql)?:\/\//.test(url)) {
        throw new Error(
          `Invalid DATABASE_READ_REPLICAS entry "${entry.replace(/\/\/[^@]*@/, "//***@")}". Expected region=postgresql://...`
        );
      }
      return { region, url };
    });
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadReadReplicaConfig(env: NodeJS.ProcessEnv = process.env): ReadReplicaConfig {
  return {
    appRegion: env.APP_REGION?.trim() || null,
    replicas: parseReplicaDefinitions(env.DATABASE_READ_REPLICAS),
    maxLagMs: positiveInt(env.REPLICA_MAX_LAG_MS, 5_000),
    healthCheckIntervalMs: positiveInt(env.REPLICA_HEALTH_CHECK_INTERVAL_MS, 10_000),
    healthCheckTimeoutMs: positiveInt(env.REPLICA_HEALTH_CHECK_TIMEOUT_MS, 2_000),
  };
}

// ============================================================
// Request-scoped read consistency
// ============================================================

export interface ReadConsistencyContext {
  /** Reads in this context may be served by a replica */
  allowReplica: boolean;
  /** Set after the first write so later reads see it (read-your-writes) */
  hasWritten: boolean;
}

export const readConsistencyStorage = new AsyncLocalStorage<ReadConsistencyContext>();

/** Runs `fn` with reads allowed to go to replicas (e.g. a GET request). */
export function runWithReplicaReads<T>(fn: () => T): T {
  return readConsistencyStorage.run({ allowReplica: true, hasWritten: false }, fn);
}

/** Runs `fn` with every query pinned to the primary. */
export function runOnPrimary<T>(fn: () => T): T {
  return readConsistencyStorage.run({ allowReplica: false, hasWritten: false }, fn);
}

// ============================================================
// Replica health & selection
// ============================================================

/** Just the raw-query surface the router needs from a replica client. */
export interface ReplicaClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $disconnect?(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [model: string]: any;
}

export interface ReplicaNode {
  region: string;
  client: ReplicaClient;
  healthy: boolean;
  lagMs: number | null;
  latencyMs: number | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export interface ReplicaStatus {
  region: string;
  healthy: boolean;
  eligible: boolean;
  lagMs: number | null;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

/**
 * Replication lag in ms. A replica that has replayed everything it received is
 * reported as 0 lag, otherwise an idle primary would make it look stale.
 */
export const REPLICATION_LAG_SQL = `
  SELECT CASE
    WHEN NOT pg_is_in_recovery() THEN 0
    WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
    ELSE COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, 0)
  END::float8 AS lag_ms
`;

export class ReplicaRouter {
  public readonly nodes: ReplicaNode[];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    replicas: Array<{ region: string; client: ReplicaClient }>,
    private readonly options: {
      appRegion: string | null;
      maxLagMs: number;
      healthCheckTimeoutMs?: number;
    }
  ) {
    // Replicas start unhealthy: no traffic until the first successful health check
    this.nodes = replicas.map((r) => ({
      region: r.region,
      client: r.client,
      healthy: false,
      lagMs: null,
      latencyMs: null,
      lastCheckedAt: null,
      lastError: null,
    }));
  }

  private isEligible(node: ReplicaNode): boolean {
    return node.healthy && node.lagMs !== null && node.lagMs <= this.options.maxLagMs;
  }

  /**
   * Nearest eligible replica: same region as the app first, then lowest latency.
   * Returns null when reads should go to the primary.
   */
  public pick(): ReplicaNode | null {
    const eligible = this.nodes.filter((n) => this.isEligible(n));
    if (eligible.length === 0) return null;

    const appRegion = this.options.appRegion;
    return eligible.reduce((best, node) => {
      const bestLocal = best.region === appRegion;
      const nodeLocal = node.region === appRegion;
      if (nodeLocal !== bestLocal) return nodeLocal ? node : best;
      return (node.latencyMs ?? Infinity) < (best.latencyMs ?? Infinity) ? node : best;
    });
  }

  public markUnhealthy(node: ReplicaNode, error: unknown): void {
    node.healthy = false;
    node.lastError = (error as Error)?.message ?? String(error);
    console.warn(`[db] Read replica ${node.region} marked unhealthy: ${node.lastError}`);
  }

  public async checkHealth(node: ReplicaNode): Promise<void> {
    const startedAt = performance.now();
    const timeoutMs = this.options.healthCheckTimeoutMs ?? 2_000;
    let timeout: NodeJS.Timeout | undefined;

    try {
      const rows = await Promise.race([
        node.client.$queryRawUnsafe<Array<{ lag_ms: number | string }>>(REPLICATION_LAG_SQL),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      const lagMs = Number(rows?.[0]?.lag_ms);
      if (!Number.isFinite(lagMs)) {
        throw new Error("replica returned no replication lag");
      }

      const wasEligible = this.isEligible(node);
      node.latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      node.lagMs = Math.round(lagMs);
      node.healthy = true;
      node.lastError = null;
      if (wasEligible && !this.isEligible(node)) {
        console.warn(
          `[db] Read replica ${node.region} lag ${node.lagMs}ms exceeds ${this.options.maxLagMs}ms; routing reads elsewhere`
        );
      }
    } catch (error) {
      if (node.healthy) this.markUnhealthy(node, error);
      else node.lastError = (error as Error).message;
    } finally {
      clearTimeout(timeout);
      node.lastCheckedAt = new Date();
    }
  }

  public async checkAll(): Promise<void> {
    await Promise.all(this.nodes.map((node) => this.checkHealth(node)));
  }

  public start(intervalMs: number): void {
    if (this.timer) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    this.timer.unref?.();
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all(this.nodes.map((n) => n.client.$disconnect?.().catch(() => undefined)));
  }

  public status(): ReplicaStatus[] {
    return this.nodes.map((n) => ({
      region: n.region,
      healthy: n.healthy,
      eligible: this.isEligible(n),
      lagMs: n.lagMs,
      latencyMs: n.latencyMs,
      lastCheckedAt: n.lastCheckedAt?.toISOString() ?? null,
      lastError: n.lastError,
    }));
  }
}

// ============================================================
// Prisma query routing
// ============================================================

export const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Query-level Prisma errors (P2xxx: constraint, not found, ...) would fail the same
 * way on the primary; anything else (connection, timeout) is a replica problem.
 */
function isReplicaFailure(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return !(typeof code === "string" && /^P2\d{3}$/.test(code));
}

export interface RoutedOperation {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
  __internalParams?: { transaction?: unknown };
}

/**
 * The routing decision for one Prisma operation. Exported for unit testing.
 */
export async function routeOperation(router: ReplicaRouter, op: RoutedOperation): Promise<unknown> {
  const context = readConsistencyStorage.getStore();
  const isRead = READ_OPERATIONS.has(op.operation);

  if (!isRead) {
    if (op.model && context) context.hasWritten = true;
    return op.query(op.args);
  }

  if (!op.model || !context?.allowReplica || context.hasWritten || op.__internalParams?.transaction) {
    return op.query(op.args);
  }

  const node = router.pick();
  if (!node) {
    return op.query(op.args);
  }

  const delegateName = op.model.charAt(0).toLowerCase() + op.model.slice(1);
  try {
    return await node.client[delegateName][op.operation](op.args);
  } catch (error) {
    if (!isReplicaFailure(error)) throw error;
    router.markUnhealthy(node, error);
    return op.query(op.args);
  }
}

export function createReadReplicaExtension(router: ReplicaRouter) {
  return Prisma.defineExtension({
    name: "fantasyxi-read-replicas",
    query: {
      async $allOperations(params) {
        return routeOperation(router, params as unknown as RoutedOperation);
      },
    },
  });
}
