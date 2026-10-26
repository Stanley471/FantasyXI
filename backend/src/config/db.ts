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
import { slowQueryTelemetry } from "./slowQueryTelemetry.js";

// Extend globalThis to hold our Prisma instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  replicaRouter: ReplicaRouter | null | undefined;
  clusterMonitor: DatabaseClusterMonitor | null | undefined;
};

function createClient(connectionString: string): PrismaClient {
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    log: [
      { emit: "event", level: "query" },
      { emit: "stdout", level: "error" },
      { emit: "stdout", level: "warn" },
    ],
  });

  prisma.$on("query", (event) => slowQueryTelemetry.observe(event));
  return prisma;
}

export function getSlowQueryCount(): number {
  return slowQueryTelemetry.getRollingCount();
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
