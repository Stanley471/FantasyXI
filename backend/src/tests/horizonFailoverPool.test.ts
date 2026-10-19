import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HorizonConnectionPool } from "../config/stellar.js";

describe("HorizonConnectionPool (Issue #234)", () => {
  it("routes requests to the healthy node with the lowest latency after health checks", async () => {
    const urls = [
      "https://horizon-primary.example.org",
      "https://horizon-fast-backup.example.org",
      "https://horizon-slow-backup.example.org",
    ];

    const simulatedLatencies: Record<string, number> = {
      "https://horizon-primary.example.org/fee_stats": 85,
      "https://horizon-fast-backup.example.org/fee_stats": 12,
      "https://horizon-slow-backup.example.org/fee_stats": 180,
    };

    const pool = new HorizonConnectionPool({
      urls,
      timeoutMs: 2000,
      fetchFn: async (probeUrl) => {
        const delay = simulatedLatencies[probeUrl] ?? 50;
        await new Promise((r) => setTimeout(r, delay));
        return { ok: true, status: 200 };
      },
      serverFactory: (url) => ({ serverUrl: url } as any),
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });

    await pool.runHealthChecks();

    const optimalUrl = pool.getOptimalNodeUrl();
    assert.equal(optimalUrl, "https://horizon-fast-backup.example.org");
  });

  it("automatically fails over to the secondary node when the primary node returns 500 and logs a warning with URL and latency", async () => {
    const warnings: string[] = [];
    const urls = [
      "https://horizon-primary.example.org",
      "https://horizon-secondary.example.org",
    ];

    const pool = new HorizonConnectionPool({
      urls,
      timeoutMs: 2000,
      serverFactory: (url) => ({ serverUrl: url } as any),
      logger: {
        warn: (msg: string) => warnings.push(msg),
        info: () => {},
        error: () => {},
      },
    });

    const attemptedNodes: string[] = [];
    const response = await pool.executeWithFailover(async (_server, nodeUrl) => {
      attemptedNodes.push(nodeUrl);
      if (nodeUrl === "https://horizon-primary.example.org") {
        const err: any = new Error("Internal Server Error");
        err.response = { status: 500 };
        throw err;
      }
      return { ledger: 54321, servedBy: nodeUrl };
    });

    assert.deepEqual(attemptedNodes, [
      "https://horizon-primary.example.org",
      "https://horizon-secondary.example.org",
    ]);
    assert.equal(response.servedBy, "https://horizon-secondary.example.org");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /https:\/\/horizon-primary\.example\.org/);
    assert.match(warnings[0], /latency \d+ms/);

    const status = pool.getNodesStatus();
    const primaryStatus = status.find((s) => s.url === "https://horizon-primary.example.org");
    const secondaryStatus = status.find((s) => s.url === "https://horizon-secondary.example.org");
    assert.equal(primaryStatus?.healthy, false);
    assert.equal(secondaryStatus?.healthy, true);
  });

  it("automatically fails over when the primary node times out", async () => {
    const warnings: string[] = [];
    const urls = [
      "https://horizon-timeout.example.org",
      "https://horizon-healthy.example.org",
    ];

    const pool = new HorizonConnectionPool({
      urls,
      timeoutMs: 60, // Short timeout for fast unit test
      serverFactory: (url) => ({ serverUrl: url } as any),
      logger: {
        warn: (msg: string) => warnings.push(msg),
        info: () => {},
        error: () => {},
      },
    });

    const result = await pool.executeWithFailover(async (_server, nodeUrl) => {
      if (nodeUrl === "https://horizon-timeout.example.org") {
        await new Promise((r) => setTimeout(r, 200));
      }
      return { ok: true, from: nodeUrl };
    });

    assert.equal(result.from, "https://horizon-healthy.example.org");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /https:\/\/horizon-timeout\.example\.org/);
    assert.match(warnings[0], /timed out/i);
  });
});
