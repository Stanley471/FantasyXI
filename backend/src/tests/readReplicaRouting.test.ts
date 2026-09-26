import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  ReplicaRouter,
  ReplicaClient,
  createReadReplicaExtension,
  parseReplicaDefinitions,
  loadReadReplicaConfig,
  routeOperation,
  runWithReplicaReads,
  runOnPrimary,
  readConsistencyStorage,
} from "../config/readReplicas.js";
import { replicaReads, preferReplicaReads, primaryReads } from "../middleware/readConsistency.js";

/** Fake replica: reports a configurable lag and records the reads it serves. */
function fakeReplica(options: { lagMs?: number; fail?: Error; delayMs?: number } = {}) {
  const served: string[] = [];
  const state = { lagMs: options.lagMs ?? 0, fail: options.fail, queryError: null as any };
  const client: ReplicaClient = {
    $queryRawUnsafe: async <T>() => {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (state.fail) throw state.fail;
      return [{ lag_ms: state.lagMs }] as T;
    },
    league: {
      findMany: async (args: unknown) => {
        if (state.queryError) throw state.queryError;
        served.push(`league.findMany:${JSON.stringify(args)}`);
        return [{ id: "from-replica" }];
      },
    },
  };
  return { client, served, state };
}

function primaryQuery() {
  const calls: unknown[] = [];
  return {
    calls,
    query: async (args: unknown) => {
      calls.push(args);
      return [{ id: "from-primary" }];
    },
  };
}

async function healthyRouter(appRegion: string | null, replicas: Record<string, ReturnType<typeof fakeReplica>>, maxLagMs = 1_000) {
  const router = new ReplicaRouter(
    Object.entries(replicas).map(([region, r]) => ({ region, client: r.client })),
    { appRegion, maxLagMs }
  );
  await router.checkAll();
  return router;
}

describe("Multi-region read replicas", () => {
  describe("configuration", () => {
    it("parses region=url entries, keeping query strings intact", () => {
      assert.deepEqual(
        parseReplicaDefinitions(
          " eu-west-1=postgresql://u:p@eu.db:5432/fx?schema=public , us-east-1=postgres://u:p@us.db/fx"
        ),
        [
          { region: "eu-west-1", url: "postgresql://u:p@eu.db:5432/fx?schema=public" },
          { region: "us-east-1", url: "postgres://u:p@us.db/fx" },
        ]
      );
      assert.deepEqual(parseReplicaDefinitions(undefined), []);
      assert.deepEqual(parseReplicaDefinitions("  "), []);
    });

    it("rejects malformed entries without leaking credentials", () => {
      assert.throws(() => parseReplicaDefinitions("postgresql://u:secret@host/db"), (error: Error) => {
        assert.ok(!error.message.includes("secret"));
        return true;
      });
      assert.throws(() => parseReplicaDefinitions("eu=mysql://host/db"));
    });

    it("applies safe defaults", () => {
      const config = loadReadReplicaConfig({ APP_REGION: "eu-west-1", REPLICA_MAX_LAG_MS: "nope" } as any);
      assert.equal(config.appRegion, "eu-west-1");
      assert.equal(config.maxLagMs, 5_000);
      assert.equal(config.healthCheckIntervalMs, 10_000);
      assert.deepEqual(config.replicas, []);
    });
  });

  describe("replica selection", () => {
    it("sends no traffic to replicas before their first health check", () => {
      const router = new ReplicaRouter([{ region: "eu", client: fakeReplica().client }], {
        appRegion: "eu",
        maxLagMs: 1_000,
      });
      assert.equal(router.pick(), null);
    });

    it("prefers the replica in the app's own region", async () => {
      const router = await healthyRouter("ap-south-1", {
        "us-east-1": fakeReplica(),
        "ap-south-1": fakeReplica({ delayMs: 20 }),
      });
      assert.equal(router.pick()?.region, "ap-south-1");
    });

    it("falls back to the lowest-latency healthy replica elsewhere", async () => {
      const router = await healthyRouter("sa-east-1", {
        slow: fakeReplica({ delayMs: 30 }),
        fast: fakeReplica(),
      });
      assert.equal(router.pick()?.region, "fast");
    });

    it("stops routing to a replica whose lag exceeds the threshold, and resumes once it catches up", async () => {
      const local = fakeReplica();
      const remote = fakeReplica({ delayMs: 10 });
      const router = await healthyRouter("eu", { eu: local, us: remote }, 1_000);
      assert.equal(router.pick()?.region, "eu");

      local.state.lagMs = 4_000;
      await router.checkAll();
      assert.equal(router.pick()?.region, "us");
      assert.equal(router.status().find((s) => s.region === "eu")?.eligible, false);

      remote.state.lagMs = 4_000;
      await router.checkAll();
      assert.equal(router.pick(), null, "all replicas lagging: reads must use the primary");

      local.state.lagMs = 0;
      await router.checkAll();
      assert.equal(router.pick()?.region, "eu");
    });

    it("marks replicas that fail or time out as unhealthy", async () => {
      const broken = fakeReplica({ fail: new Error("ECONNREFUSED") });
      const router = await healthyRouter("eu", { eu: broken });
      assert.equal(router.pick(), null);
      assert.match(router.status()[0].lastError ?? "", /ECONNREFUSED/);

      const hung = new ReplicaRouter([{ region: "eu", client: fakeReplica({ delayMs: 200 }).client }], {
        appRegion: "eu",
        maxLagMs: 1_000,
        healthCheckTimeoutMs: 20,
      });
      await hung.checkAll();
      assert.equal(hung.pick(), null);
      assert.match(hung.status()[0].lastError ?? "", /timed out/);
    });
  });

  describe("query routing", () => {
    const readOp = (query: (args: unknown) => Promise<unknown>, extra: object = {}) => ({
      model: "League",
      operation: "findMany",
      args: { where: { isPrivate: false } },
      query,
      __internalParams: {},
      ...extra,
    });

    it("routes reads in a replica-eligible context to the nearest replica", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      const primary = primaryQuery();

      const result = await runWithReplicaReads(() => routeOperation(router, readOp(primary.query)));

      assert.deepEqual(result, [{ id: "from-replica" }]);
      assert.equal(primary.calls.length, 0);
      assert.equal(replica.served.length, 1);
    });

    it("keeps reads outside a request context (jobs, workers) on the primary", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      const primary = primaryQuery();

      await routeOperation(router, readOp(primary.query));
      await runOnPrimary(() => routeOperation(router, readOp(primary.query)));

      assert.equal(primary.calls.length, 2);
      assert.equal(replica.served.length, 0);
    });

    it("keeps reads inside a transaction on the primary", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      const primary = primaryQuery();

      await runWithReplicaReads(() =>
        routeOperation(router, readOp(primary.query, { __internalParams: { transaction: { kind: "itx" } } }))
      );
      assert.equal(primary.calls.length, 1);
      assert.equal(replica.served.length, 0);
    });

    it("never sends writes to a replica and reads its own writes afterwards", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      const primary = primaryQuery();

      await runWithReplicaReads(async () => {
        await routeOperation(router, readOp(primary.query));
        await routeOperation(router, { ...readOp(primary.query), operation: "update" });
        await routeOperation(router, readOp(primary.query));
      });

      assert.equal(replica.served.length, 1, "only the read before the write used the replica");
      assert.equal(primary.calls.length, 2);
    });

    it("keeps raw queries on the primary", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      const primary = primaryQuery();

      await runWithReplicaReads(() =>
        routeOperation(router, { operation: "$queryRaw", args: [], query: primary.query })
      );
      assert.equal(primary.calls.length, 1);
    });

    it("fails over to the primary when a replica connection breaks mid-query", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      const primary = primaryQuery();
      replica.state.queryError = Object.assign(new Error("Connection terminated unexpectedly"), { code: "P1017" });

      const result = await runWithReplicaReads(() => routeOperation(router, readOp(primary.query)));

      assert.deepEqual(result, [{ id: "from-primary" }]);
      assert.equal(router.pick(), null, "replica is taken out of rotation until the next health check");
    });

    it("surfaces query-level errors instead of retrying them on the primary", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      const primary = primaryQuery();
      replica.state.queryError = Object.assign(new Error("Record not found"), { code: "P2025" });

      await assert.rejects(
        () => runWithReplicaReads(() => routeOperation(router, readOp(primary.query))),
        /Record not found/
      );
      assert.equal(primary.calls.length, 0);
    });
  });

  describe("Prisma client integration", () => {
    it("routes through a real PrismaClient: replica for eligible reads, primary for everything else", async () => {
      const replica = fakeReplica();
      const router = await healthyRouter("eu", { eu: replica });
      // Unreachable primary: any query that reaches it fails, proving where it was routed
      const primary = new PrismaClient({
        adapter: new PrismaPg(
          new pg.Pool({ connectionString: "postgresql://u:p@127.0.0.1:1/none", connectionTimeoutMillis: 500 })
        ),
      });
      const db = primary.$extends(createReadReplicaExtension(router)) as unknown as PrismaClient;
      const hitPrimary = (promise: Promise<unknown>) =>
        promise.then(
          () => false,
          (error) => error?.code === "P1001" || /reach database server/i.test(error?.message ?? "")
        );

      try {
        const routed = await runWithReplicaReads(async () => db.league.findMany({ where: { isPrivate: false } }));
        assert.deepEqual(routed, [{ id: "from-replica" }]);

        assert.equal(await hitPrimary(db.league.findMany()), true, "no request context");
        assert.equal(
          await runWithReplicaReads(async () => hitPrimary(db.league.updateMany({ data: { name: "x" } }))),
          true,
          "write"
        );
        assert.equal(
          await runWithReplicaReads(async () => hitPrimary(db.$transaction(async (tx) => tx.league.findMany()))),
          true,
          "interactive transaction"
        );
        assert.equal(
          await runWithReplicaReads(async () => hitPrimary(db.$transaction([db.league.findMany()]))),
          true,
          "batch transaction"
        );
        assert.equal(replica.served.length, 1);
      } finally {
        await primary.$disconnect();
      }
    });
  });

  describe("read consistency middleware", () => {
    function contextFor(middleware: typeof replicaReads, method: string, headers: Record<string, string> = {}) {
      let captured: ReturnType<typeof readConsistencyStorage.getStore>;
      middleware({ method, headers } as unknown as Request, {} as Response, () => {
        captured = readConsistencyStorage.getStore();
      });
      return captured!;
    }

    it("allows replica reads for GET/HEAD requests only", () => {
      assert.equal(contextFor(replicaReads, "GET").allowReplica, true);
      assert.equal(contextFor(replicaReads, "HEAD").allowReplica, true);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.equal(contextFor(replicaReads, method).allowReplica, false, method);
      }
    });

    it("lets a nested route pin itself to the primary", () => {
      let captured: ReturnType<typeof readConsistencyStorage.getStore>;
      replicaReads({ method: "GET", headers: {} } as unknown as Request, {} as Response, () =>
        primaryReads({} as Request, {} as Response, () => {
          captured = readConsistencyStorage.getStore();
        })
      );
      assert.equal(captured!.allowReplica, false);
    });

    it("honours X-Read-Consistency: strong", () => {
      assert.equal(contextFor(replicaReads, "GET", { "x-read-consistency": "strong" }).allowReplica, false);
      assert.equal(contextFor(preferReplicaReads, "POST", { "x-read-consistency": "STRONG" }).allowReplica, false);
      assert.equal(contextFor(preferReplicaReads, "POST").allowReplica, true);
    });
  });
});
