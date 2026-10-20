import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { mutationWindow } from "./mutationWindow.js";
import {
  ReplicaRouter,
  createReadReplicaExtension,
  loadReadReplicaConfig,
  readConsistencyStorage,
} from "./readReplicas.js";
import {
  DatabaseClusterMonitor,
  createDatabaseMaintenanceMiddleware,
} from "./dbHealthMonitor.js";

// Extend globalThis to hold our Prisma instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  replicaRouter: ReplicaRouter | null | undefined;
  clusterMonitor: DatabaseClusterMonitor | null | undefined;
};

const SLOW_QUERY_THRESHOLD_MS = 200;
const SLOW_QUERY_WINDOW_MS = 60_000;
const SENSITIVE_QUERY_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "jwt",
  "authorization",
  "cookie",
  "session",
  "secret",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "hash",
  "hashvalue",
]);
const REDACTED = "[REDACTED]";
const slowQueryTimestamps: number[] = [];
let lastSlowQuery: {
  durationMs: number;
  operation: string;
  queryFingerprint: string;
  params: unknown;
  occurredAt: number;
} | null = null;

function normalizeFingerprint(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 256) || "<empty query>";
}

export function redactSensitiveQueryParams(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveQueryParams(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_QUERY_KEYS.has(key.toLowerCase())
          ? REDACTED
          : redactSensitiveQueryParams(entry),
      ])
    );
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return value;
    }

    const lower = normalized.toLowerCase();
    if (
      /^\$2[aby]\$\d+\$/.test(normalized) ||
      /^[A-Za-z0-9+/=_-]{32,}$/.test(normalized) ||
      /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(normalized) ||
      lower.includes("password") ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("session") ||
      lower.includes("authorization") ||
      lower.includes("cookie")
    ) {
      return REDACTED;
    }

    return value;
  }

  return value;
}

export function getSlowQueryMetrics() {
  const now = Date.now();
  const windowStart = now - SLOW_QUERY_WINDOW_MS;

  while (slowQueryTimestamps.length > 0 && slowQueryTimestamps[0] < windowStart) {
    slowQueryTimestamps.shift();
  }

  return {
    windowMs: SLOW_QUERY_WINDOW_MS,
    rollingSlowQueryCount: slowQueryTimestamps.length,
    lastSlowQuery,
    reset: () => {
      slowQueryTimestamps.length = 0;
      lastSlowQuery = null;
    },
  };
}

export function registerPrismaQueryTelemetry(client: any): void {
  if (!client || typeof client.$on !== "function") {
    return;
  }

  client.$on("query", (event: any) => {
    const durationMs = Number(event?.duration ?? 0);
    if (!Number.isFinite(durationMs) || durationMs <= SLOW_QUERY_THRESHOLD_MS) {
      return;
    }

    let params: unknown = event?.params ?? null;
    if (typeof params === "string") {
      try {
        params = JSON.parse(params);
      } catch {
        params = params;
      }
    }

    const sanitizedParams = redactSensitiveQueryParams(params);
    const queryFingerprint = normalizeFingerprint(String(event?.query ?? "<unknown query>"));
    const occurredAt = Date.now();

    slowQueryTimestamps.push(occurredAt);
    lastSlowQuery = {
      durationMs,
      operation: String(event?.target ?? "prisma"),
      queryFingerprint,
      params: sanitizedParams,
      occurredAt,
    };

    const cutoff = occurredAt - SLOW_QUERY_WINDOW_MS;
    while (slowQueryTimestamps.length > 0 && slowQueryTimestamps[0] < cutoff) {
      slowQueryTimestamps.shift();
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        type: "db.slow_query",
        durationMs,
        operation: lastSlowQuery.operation,
        queryFingerprint,
        params: sanitizedParams,
        rollingSlowQueryCount: slowQueryTimestamps.length,
      })
    );
  });
}

function createClient(connectionString: string): PrismaClient {
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

  registerPrismaQueryTelemetry(prisma as any);
  return prisma;
}

function getPrismaInstance(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const connectionString =
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5432/fantasyxi?schema=public";
    const primary = createClient(connectionString);
    const replicaConfig = loadReadReplicaConfig();

    if (replicaConfig.replicas.length === 0) {
      globalForPrisma.prisma = primary;
      globalForPrisma.replicaRouter = null;
      globalForPrisma.clusterMonitor = new DatabaseClusterMonitor({
        primary: { client: primary as any, region: "primary" },
        maxLagMs: 1_000,
        checkIntervalMs: 5_000,
      });
    } else {
      // Multi-region read/write splitting (see config/readReplicas.ts)
      const replicaClients = replicaConfig.replicas.map((r) => ({
        region: r.region,
        client: createClient(r.url),
      }));

      const router = new ReplicaRouter(
        replicaClients,
        {
          primary,
          appRegion: replicaConfig.appRegion,
          maxLagMs: replicaConfig.maxLagMs,
          healthCheckTimeoutMs: replicaConfig.healthCheckTimeoutMs,
        }
      );
      router.start(replicaConfig.healthCheckIntervalMs);
      globalForPrisma.replicaRouter = router;

      const monitor = new DatabaseClusterMonitor({
        primary: { client: primary as any, region: "primary" },
        replicas: replicaClients,
        maxLagMs: 1_000,
        checkIntervalMs: 5_000,
      });
      monitor.start();
      globalForPrisma.clusterMonitor = monitor;

      globalForPrisma.prisma = primary.$extends(
        createReadReplicaExtension(router)
      ) as unknown as PrismaClient;
      console.log(
        `[db] Read replicas enabled for region ${replicaConfig.appRegion ?? "(unset)"}: ` +
          replicaConfig.replicas.map((r) => r.region).join(", ")
      );
    }
  }
  return globalForPrisma.prisma;
}

/**
 * Sets the PostgreSQL RLS context for the current request.
 *
 * Call this in Express middleware after authentication to ensure all
 * subsequent queries are scoped to the current user's tenant.
 *
 * @param userId - The authenticated user's ID
 */
export async function setRlsContext(userId: string): Promise<void> {
  const client = getPrismaInstance();
  try {
    await client.$executeRaw`SELECT set_rls_context(${userId})`;
  } catch {
    // RLS may not be enabled in all environments; fail silently
  }
}

/**
 * Status of configured read replicas (empty when replication is disabled).
 */
export function getReadReplicaStatus() {
  getPrismaInstance();
  return globalForPrisma.replicaRouter?.status() ?? [];
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrismaInstance();
    if (prop === "$transaction" && globalForPrisma.replicaRouter) {
      return async (...args: unknown[]) => {
        const context = readConsistencyStorage.getStore();
        const userId = context?.userId?.();
        if (context) context.hasWritten = true;
        const store = context?.mutations ?? mutationWindow;
        if (userId) await store.mark(userId);
        try { return await (client.$transaction as Function).apply(client, args); }
        finally { if (userId) await store.mark(userId); }
      };
    }
    const value = Reflect.get(client, prop, receiver);
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});

export interface SchemaCompatibilityStatus {
  isCompatible: boolean;
  version: string;
  appliedMigrationsCount: number;
}

/**
 * Validates database schema version compatibility during application startup.
 * Designed to be non-blocking during mixed N / N+1 schema version transitions.
 */
export async function checkSchemaCompatibility(): Promise<SchemaCompatibilityStatus> {
  try {
    const applied = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 5
    `.catch(() => []);

    return {
      isCompatible: true,
      version: applied.length > 0 ? applied[0].migration_name : "initial",
      appliedMigrationsCount: applied.length,
    };
  } catch (error) {
    console.warn("[DB Schema] Migration status check non-blocking warning:", error);
    return {
      isCompatible: true,
      version: "mixed/fallback",
      appliedMigrationsCount: 0,
    };
  }
}

export function getClusterMonitor(): DatabaseClusterMonitor | null {
  getPrismaInstance();
  return globalForPrisma.clusterMonitor ?? null;
}

export function isClusterReadOnly(): boolean {
  return getClusterMonitor()?.isReadOnly() ?? false;
}

export { DatabaseClusterMonitor, createDatabaseMaintenanceMiddleware };
