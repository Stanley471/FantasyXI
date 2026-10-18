/**
 * Partitioning migration for high-velocity event tables (issue #263).
 *
 * Usage (from backend/):
 *   npm run db:partition -- status            # show partition layout of every managed table
 *   npm run db:partition -- convert [table]   # zero-downtime conversion (roll forward)
 *   npm run db:partition -- rotate            # pre-create upcoming / archive expired partitions now
 *   npm run db:partition -- rollback <table>  # emergency rollback to a plain table
 *
 * Deployment order: `prisma db push` creates the tables, then `convert` turns
 * them into partitioned tables. On a database where contract_events already
 * holds many rows, run `convert contract_events` before `prisma db push`: the
 * conversion swaps in the (id, created_at) primary key with a concurrently
 * built index, whereas db push would rebuild it under an exclusive lock.
 * Re-running `convert` is safe; partitioned tables are skipped.
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  PARTITIONED_TABLES,
  PartitionManager,
  prismaSqlExecutor,
} from "../services/partitioning/partitionManager.js";
import { PartitionRotationWorker } from "../services/partitioning/partitionRotationWorker.js";

function selectTables(name?: string) {
  if (!name) return [...PARTITIONED_TABLES];
  const spec = PARTITIONED_TABLES.find((t) => t.table === name);
  if (!spec) {
    throw new Error(
      `Unknown table "${name}". Managed tables: ${PARTITIONED_TABLES.map((t) => t.table).join(", ")}`
    );
  }
  return [spec];
}

async function main(): Promise<void> {
  const [command = "status", tableArg] = process.argv.slice(2);
  const url =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/fantasyxi?schema=public";
  const client = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: url, max: 2 })) });
  const manager = new PartitionManager(prismaSqlExecutor(client));

  try {
    switch (command) {
      case "convert":
        for (const spec of selectTables(tableArg)) {
          console.log("[partition] convert", await manager.convertToPartitioned(spec));
        }
        break;
      case "rollback":
        if (!tableArg) throw new Error("rollback needs a table name");
        console.log("[partition] rollback", await manager.revertToPlain(selectTables(tableArg)[0]));
        break;
      case "rotate":
        console.log("[partition] rotate", await new PartitionRotationWorker(manager).run());
        break;
      case "status":
        for (const spec of selectTables(tableArg)) {
          const kind = await manager.getTableKind(spec.table);
          const partitions = kind === "p" ? await manager.listPartitions(spec) : [];
          console.log(`[partition] ${spec.table}: ${kind === "p" ? "partitioned" : kind === "r" ? "plain" : "missing"}`);
          for (const p of partitions) {
            const show = (v: number | null) =>
              v === null ? "unbounded" : spec.strategy === "weekly" ? new Date(v).toISOString() : String(v);
            console.log(`  ${p.schema}.${p.name}  [${show(p.range.from)}, ${show(p.range.to)})${p.detachPending ? "  DETACH PENDING" : ""}`);
          }
        }
        break;
      default:
        throw new Error(`Unknown command "${command}" (expected status, convert, rotate or rollback)`);
    }
  } finally {
    await client.$disconnect();
  }
}

main().catch((error) => {
  console.error("[partition] Failed:", error.message);
  process.exitCode = 1;
});
