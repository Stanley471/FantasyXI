/**
 * Read-replica latency benchmark (before / after).
 *
 * Runs the same read workload twice from this machine:
 *   1. "before": every query goes to the primary (DATABASE_URL)
 *   2. "after":  queries are routed by the read-replica extension
 *                (DATABASE_READ_REPLICAS + APP_REGION)
 * and prints p50 / p95 / p99 latency for each.
 *
 * Run it from an app host in each region you serve, e.g.:
 *   APP_REGION=ap-south-1 BENCH_ITERATIONS=500 npm run db:benchmark-replicas
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  ReplicaRouter,
  createReadReplicaExtension,
  loadReadReplicaConfig,
  runWithReplicaReads,
} from "../config/readReplicas.js";

const ITERATIONS = Number(process.env.BENCH_ITERATIONS) || 200;
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY) || 8;
const WARMUP = Math.min(20, ITERATIONS);

function client(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: url, max: CONCURRENCY })) });
}

/** Representative API read: the public league search page. */
function workload(db: PrismaClient) {
  const where = { isPrivate: false, status: "UPCOMING" as const };
  return Promise.all([
    db.league.findMany({
      where,
      include: { creator: { select: { id: true, username: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 20,
    }),
    db.league.count({ where }),
  ]);
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)] * 100) / 100;
}

async function measure(label: string, run: () => Promise<unknown>) {
  for (let i = 0; i < WARMUP; i++) await run();

  const samples: number[] = [];
  let next = 0;
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next++ < ITERATIONS) {
        const t0 = performance.now();
        await run();
        samples.push(performance.now() - t0);
      }
    })
  );
  const elapsedMs = performance.now() - startedAt;

  samples.sort((a, b) => a - b);
  return {
    target: label,
    requests: samples.length,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    p99_ms: percentile(samples, 99),
    throughput_rps: Math.round((samples.length / elapsedMs) * 1000),
  };
}

async function main(): Promise<void> {
  const primaryUrl = process.env.DATABASE_URL;
  const config = loadReadReplicaConfig();
  if (!primaryUrl) throw new Error("DATABASE_URL is required");
  if (config.replicas.length === 0) throw new Error("DATABASE_READ_REPLICAS is required");

  const primary = client(primaryUrl);
  const router = new ReplicaRouter(
    config.replicas.map((r) => ({ region: r.region, client: client(r.url) })),
    { appRegion: config.appRegion, maxLagMs: config.maxLagMs, healthCheckTimeoutMs: config.healthCheckTimeoutMs }
  );
  await router.checkAll();
  const routed = primary.$extends(createReadReplicaExtension(router)) as unknown as PrismaClient;

  console.log(`[bench] region=${config.appRegion ?? "(unset)"} iterations=${ITERATIONS} concurrency=${CONCURRENCY}`);
  console.table(router.status().map(({ region, eligible, lagMs, latencyMs }) => ({ region, eligible, lagMs, latencyMs })));
  const chosen = router.pick();
  console.log(`[bench] Reads will be served by: ${chosen ? chosen.region : "primary (no eligible replica)"}`);

  const before = await measure("before: primary only", () => workload(primary));
  const after = await measure(`after: routed (${chosen?.region ?? "primary"})`, () =>
    runWithReplicaReads(() => workload(routed))
  );
  console.table([before, after]);

  const improvement = ((before.p95_ms - after.p95_ms) / before.p95_ms) * 100;
  console.log(`[bench] p95 change: ${improvement >= 0 ? "-" : "+"}${Math.abs(improvement).toFixed(1)}%`);

  await router.stop();
  await primary.$disconnect();
}

main().catch((error) => {
  console.error("[bench] Failed:", error.message);
  process.exitCode = 1;
});
