import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { Redis } from "ioredis";
import { ReplicaRouter, createReadReplicaExtension, readConsistencyStorage } from "../../config/readReplicas.js";
import type { MutationWindow } from "../../config/mutationWindow.js";

const url = process.env.CHAOS_DATABASE_URL, redisUrl = process.env.FANOUT_REDIS_URL;
describe("PostgreSQL write-through reads with a simulated lagged replica", { skip: !url || !redisUrl }, () => {
  it("shares mutation fences across instances and routes to writer above 200ms", async () => {
    const pool = new pg.Pool({ connectionString: url });
    const primary = new PrismaClient({ adapter: new PrismaPg(pool) });
    const redis = new Redis(redisUrl!);
    const id = randomUUID();
    const key = `test:mutation:${id}`;
    let lagMs = 0, replicaReads = 0;
    const stale = { id, name: "Before write" };
    const replica: any = {
      $queryRawUnsafe: async () => [{ lag_ms: lagMs }],
      user: { findUnique: async () => { replicaReads++; return stale; } },
    };
    const router = new ReplicaRouter([{ region: "local", client: replica }], { appRegion: "local", maxLagMs: 200 });
    const routed = primary.$extends(createReadReplicaExtension(router));
    // Two independent clients to the shared Redis mimic requests on separate instances.
    const store = (): MutationWindow => ({
      mark: async () => { await redis.set(key, "1", "PX", 5000); },
      recent: async () => (await redis.get(key)) !== null,
    });
    const request = <T>(mutations: MutationWindow, query: () => T) => readConsistencyStorage.run({ allowReplica: true, hasWritten: false, userId: () => id, mutations }, async () => await query());
    try {
      await primary.user.create({ data: { id, email: `${id}@lag.test`, username: id, name: stale.name } });
      await router.checkAll();
      const a = store(), b = store();
      await request(a, () => routed.user.update({ where: { id }, data: { name: "After write" } }));
      assert.equal((await request(b, () => routed.user.findUnique({ where: { id } })))?.name, "After write");
      assert.equal(replicaReads, 0);
      assert.ok((await redis.pttl(key)) > 4500);
      // Expire the fence to isolate lag routing from read-your-writes routing.
      await redis.del(key);
      lagMs = 201; await router.checkAll();
      assert.equal((await request(b, () => routed.user.findUnique({ where: { id } })))?.name, "After write");
      lagMs = 0; stale.name = "After write"; await router.checkAll();
      await request(b, () => routed.user.findUnique({ where: { id } }));
      assert.equal(replicaReads, 1);
      const started = performance.now();
      for (let i = 0; i < 100; i++) await request(b, () => routed.user.findUnique({ where: { id } }));
      console.log(JSON.stringify({ benchmark: "replica-route-100-queries", durationMs: performance.now() - started }));
    } finally {
      await redis.del(key); redis.disconnect();
      await primary.user.deleteMany({ where: { id } }); await primary.$disconnect(); await pool.end();
    }
  });
});
