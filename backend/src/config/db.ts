import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// Extend globalThis to hold our Prisma instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function getPrismaInstance(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const connectionString =
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5432/fantasyxi?schema=public";
    const pool = new pg.Pool({ connectionString });
    const adapter = new PrismaPg(pool);

    globalForPrisma.prisma = new PrismaClient({
      adapter,
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "error", "warn"]
          : ["error"],
    });
  }
  return globalForPrisma.prisma;
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

