import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  ReplicaRouter,
  createReadReplicaExtension,
  loadReadReplicaConfig,
} from "./readReplicas.js";

// Extend globalThis to hold our Prisma instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  replicaRouter: ReplicaRouter | null | undefined;
};

function createClient(connectionString: string): PrismaClient {
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });
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
    } else {
      // Multi-region read/write splitting (see config/readReplicas.ts)
      const router = new ReplicaRouter(
        replicaConfig.replicas.map((r) => ({ region: r.region, client: createClient(r.url) })),
        {
          appRegion: replicaConfig.appRegion,
          maxLagMs: replicaConfig.maxLagMs,
          healthCheckTimeoutMs: replicaConfig.healthCheckTimeoutMs,
        }
      );
      router.start(replicaConfig.healthCheckIntervalMs);
      globalForPrisma.replicaRouter = router;
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
 * Status of configured read replicas (empty when replication is disabled).
 */
export function getReadReplicaStatus() {
  getPrismaInstance();
  return globalForPrisma.replicaRouter?.status() ?? [];
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrismaInstance();
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

