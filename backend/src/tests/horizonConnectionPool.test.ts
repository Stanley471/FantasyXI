import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Horizon, rpc } from "@stellar/stellar-sdk";
import {
  HorizonConnectionPool,
  SorobanRpcConnectionPool,
  type HorizonProbeResult,
} from "../config/stellar.js";

function createPool(options: {
  urls: string[];
  latencies: Record<string, number>;
  ledgers?: Record<string, number>;
  warnings?: string[];
  infoMessages?: string[];
  failureThreshold?: number;
  successThreshold?: number;
  cooldownMs?: number;
}) {
  return new HorizonConnectionPool({
    urls: options.urls,
    healthCheckIntervalMs: 60_000,
    failureThreshold: options.failureThreshold ?? 3,
    successThreshold: options.successThreshold ?? 2,
    cooldownMs: options.cooldownMs ?? 100,
    createServer: (url) =>
      ({ url, httpClient: { defaults: {} } }) as unknown as Horizon.Server,
    probe: async (url) => {
      const lat = options.latencies[url];
      if (lat === undefined || lat < 0) {
        throw new Error(`Node ${url} unreachable`);
      }
      return {
        latencyMs: lat,
        latestLedger: options.ledgers?.[url] ?? 100_000,
      } as HorizonProbeResult;
    },
    warn: (message) => options.warnings?.push(message),
    info: (message) => options.infoMessages?.push(message),
  });
}

describe("HorizonConnectionPool", () => {
  it("routes requests to the fastest healthy endpoint", async () => {
    const urls = ["https://primary.test", "https://backup.test", "https://quick.test"];
    const pool = createPool({
      urls,
      latencies: {
        [urls[0]]: 80,
        [urls[1]]: 25,
        [urls[2]]: 10,
      },
    });

    try {
      const selected = await pool.run(async (server) =>
        (server as unknown as { url: string }).url
      );
      assert.equal(selected, urls[2]);
      assert.ok(pool.getHealthSnapshot().every(({ healthy }) => healthy));
    } finally {
      pool.stop();
    }
  });

  it("fails over after a server error and logs the node URL and latency", async () => {
    const urls = ["https://primary.test", "https://backup.test"];
    const warnings: string[] = [];
    const pool = createPool({
      urls,
      latencies: { [urls[0]]: 5, [urls[1]]: 20 },
      warnings,
    });

    try {
      const selected = await pool.run(async (server) => {
        const url = (server as unknown as { url: string }).url;
        if (url === urls[0]) {
          throw Object.assign(new Error("Horizon unavailable"), {
            response: { status: 500 },
          });
        }
        return url;
      });

      assert.equal(selected, urls[1]);
      assert.equal(pool.getHealthSnapshot()[0].healthy, false);
      assert.equal(pool.getHealthSnapshot()[0].errorRate, 0.5);
      assert.match(warnings[0], /primary\.test.*after \d+ms \(HTTP 500\)/);
    } finally {
      pool.stop();
    }
  });

  it("does not retry non-transient client errors", async () => {
    const urls = ["https://primary.test", "https://backup.test"];
    const pool = createPool({
      urls,
      latencies: { [urls[0]]: 5, [urls[1]]: 20 },
    });
    let attempts = 0;

    try {
      await assert.rejects(
        pool.run(async () => {
          attempts += 1;
          throw Object.assign(new Error("Not found"), { response: { status: 404 } });
        }),
        /Not found/
      );
      assert.equal(attempts, 1);
    } finally {
      pool.stop();
    }
  });

  it("shifts traffic to secondary provider within 500ms on sudden primary failure", async () => {
    const urls = ["https://primary.test", "https://secondary.test"];
    const pool = createPool({
      urls,
      latencies: { [urls[0]]: 10, [urls[1]]: 15 },
    });

    try {
      // First call reaches primary
      const first = await pool.run(async (s) => (s as unknown as { url: string }).url);
      assert.equal(first, urls[0]);

      // Measure sudden failure shift time
      const startTime = Date.now();
      const failoverResult = await pool.run(async (server) => {
        const url = (server as unknown as { url: string }).url;
        if (url === urls[0]) {
          throw Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" });
        }
        return url;
      });
      const durationMs = Date.now() - startTime;

      assert.equal(failoverResult, urls[1]);
      assert.ok(durationMs < 500, `Failover took ${durationMs}ms, which should be under 500ms`);
    } finally {
      pool.stop();
    }
  });

  it("trips circuit breaker to OPEN after consecutive errors and reinstates when health checks succeed", async () => {
    const urls = ["https://primary.test", "https://backup.test"];
    const warnings: string[] = [];
    const infoMessages: string[] = [];
    const latencies: Record<string, number> = {
      [urls[0]]: 5,
      [urls[1]]: 20,
    };

    const pool = createPool({
      urls,
      latencies,
      warnings,
      infoMessages,
      failureThreshold: 2,
      successThreshold: 2,
      cooldownMs: 50,
    });

    try {
      // Cause 2 consecutive failures on primary to trip circuit
      latencies[urls[0]] = -1; // primary fails
      await pool.checkHealth();
      await pool.checkHealth();

      const snapshotAfterErrors = pool.getHealthSnapshot();
      assert.equal(snapshotAfterErrors[0].circuitState, "OPEN");
      assert.equal(snapshotAfterErrors[0].healthy, false);

      // Subsequent call immediately uses secondary without touching primary
      let primaryQueried = false;
      const resultWhileOpen = await pool.run(async (server) => {
        const url = (server as unknown as { url: string }).url;
        if (url === urls[0]) primaryQueried = true;
        return url;
      });
      assert.equal(resultWhileOpen, urls[1]);
      assert.equal(primaryQueried, false);

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 60));

      // Trigger health check: node transitions to HALF_OPEN, then CLOSED after 2 successes
      latencies[urls[0]] = 4; // primary restored
      await pool.checkHealth(); // 1st success
      await pool.checkHealth(); // 2nd success -> reaches successThreshold

      const snapshotReinstated = pool.getHealthSnapshot();
      assert.equal(snapshotReinstated[0].circuitState, "CLOSED");
      assert.equal(snapshotReinstated[0].healthy, true);

      // Primary is chosen again as lowest-latency healthy endpoint
      const afterReinstated = await pool.run(async (s) => (s as unknown as { url: string }).url);
      assert.equal(afterReinstated, urls[0]);
    } finally {
      pool.stop();
    }
  });

  it("tracks ledger sync height in health snapshot", async () => {
    const urls = ["https://primary.test", "https://secondary.test"];
    const pool = createPool({
      urls,
      latencies: { [urls[0]]: 15, [urls[1]]: 25 },
      ledgers: { [urls[0]]: 5_432_100, [urls[1]]: 5_432_098 },
    });

    try {
      await pool.checkHealth();
      const snapshot = pool.getHealthSnapshot();
      assert.equal(snapshot[0].latestLedger, 5_432_100);
      assert.equal(snapshot[1].latestLedger, 5_432_098);
    } finally {
      pool.stop();
    }
  });
});

describe("SorobanRpcConnectionPool", () => {
  it("routes Soroban RPC queries to lowest latency node and fails over on error", async () => {
    const urls = ["https://soroban-node1.test", "https://soroban-node2.test"];
    const latencies: Record<string, number> = {
      [urls[0]]: 50,
      [urls[1]]: 12,
    };

    const pool = new SorobanRpcConnectionPool({
      urls,
      healthCheckIntervalMs: 60_000,
      createServer: (url) => ({ url }) as unknown as rpc.Server,
      probe: async (url) => ({
        latencyMs: latencies[url],
        latestLedger: 888_888,
      }),
    });

    try {
      // Selects fastest healthy node (node2 with 12ms)
      const selected = await pool.run(async (s) => (s as unknown as { url: string }).url);
      assert.equal(selected, urls[1]);

      // Node2 fails, fails over to node1
      const failover = await pool.run(async (s) => {
        const url = (s as unknown as { url: string }).url;
        if (url === urls[1]) {
          throw new Error("RPC socket hangup");
        }
        return url;
      });
      assert.equal(failover, urls[0]);
    } finally {
      pool.stop();
    }
  });
});
