import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CircuitState,
  StellarNodeFailoverPool,
  parseEndpointList,
  type FailoverTelemetryEvent,
  type LatencyTelemetryEvent,
} from "../services/financial/horizonFailoverPool.js";

interface MockHorizonClient {
  url: string;
  pingLedger: () => Promise<{ sequence: number; latencyMs: number }>;
  queryBalance: (accountId: string) => Promise<{
    providerUrl: string;
    balance: string;
  }>;
}

describe("StellarNodeFailoverPool — Horizon & Soroban RPC Failover & Health Checking (Issue #359)", () => {
  it("routes network queries dynamically to the lowest-latency healthy provider", async () => {
    const latencyEvents: LatencyTelemetryEvent[] = [];
    const simulatedMetrics: Record<string, { ledger: number; latencyMs: number }> = {
      "https://horizon-a.stellar.org": { ledger: 500_100, latencyMs: 180 },
      "https://horizon-b.stellar.org": { ledger: 500_100, latencyMs: 32 },
      "https://horizon-c.stellar.org": { ledger: 500_099, latencyMs: 95 },
    };

    const pool = new StellarNodeFailoverPool<MockHorizonClient>({
      nodes: [
        "https://horizon-a.stellar.org",
        "https://horizon-b.stellar.org",
        "https://horizon-c.stellar.org",
      ],
      createClient: (url) => ({
        url,
        pingLedger: async () => ({
          sequence: simulatedMetrics[url].ledger,
          latencyMs: simulatedMetrics[url].latencyMs,
        }),
        queryBalance: async () => ({
          providerUrl: url,
          balance: "250.0000000",
        }),
      }),
      probe: async (client) => {
        const res = await client.pingLedger();
        return { ledgerSequence: res.sequence, latencyMs: res.latencyMs };
      },
    });

    pool.events.on("telemetry:latency", (evt: LatencyTelemetryEvent) => {
      latencyEvents.push(evt);
    });

    await pool.checkAllNodes();

    const selected = pool.selectHealthyNode();
    assert.equal(selected.url, "https://horizon-b.stellar.org");

    const response = await pool.execute((client) => client.queryBalance("GABC"));
    assert.equal(response.providerUrl, "https://horizon-b.stellar.org");
    assert.ok(latencyEvents.length >= 3);

    // Inject latency spike on node B -> routing shifts to node C (95ms < 180ms)
    simulatedMetrics["https://horizon-b.stellar.org"].latencyMs = 420;
    await pool.checkAllNodes();

    const nextSelected = pool.selectHealthyNode();
    assert.equal(nextSelected.url, "https://horizon-c.stellar.org");
  });

  it("shifts traffic to secondary provider within 500ms upon abrupt socket closure or 5xx error", async () => {
    const failoverEvents: FailoverTelemetryEvent[] = [];
    let primaryBehavior: "SOCKET_DROP" | "HTTP_503" | "TIMEOUT" | "OK" = "SOCKET_DROP";

    const pool = new StellarNodeFailoverPool<MockHorizonClient>({
      nodes: [
        { id: "primary-horizon", url: "https://horizon-primary.stellar.org", priority: 0 },
        { id: "secondary-horizon", url: "https://horizon-secondary.stellar.org", priority: 1 },
      ],
      requestTimeoutMs: 120,
      failureThreshold: 1,
      createClient: (url) => ({
        url,
        pingLedger: async () => ({ sequence: 600_000, latencyMs: url.includes("primary") ? 15 : 35 }),
        queryBalance: async () => {
          if (url.includes("primary")) {
            if (primaryBehavior === "SOCKET_DROP") {
              const err = new Error("read ECONNRESET: socket hang up") as Error & { code?: string };
              err.code = "ECONNRESET";
              throw err;
            }
            if (primaryBehavior === "HTTP_503") {
              const err = new Error("Service Unavailable") as Error & { status?: number };
              err.status = 503;
              throw err;
            }
            if (primaryBehavior === "TIMEOUT") {
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
          }
          return { providerUrl: url, balance: "1000.0000000" };
        },
      }),
      probe: async (client) => {
        const res = await client.pingLedger();
        return { ledgerSequence: res.sequence, latencyMs: res.latencyMs };
      },
    });

    await pool.checkAllNodes();
    assert.equal(pool.selectHealthyNode().id, "primary-horizon");

    pool.events.on("pool:failover", (evt: FailoverTelemetryEvent) => {
      failoverEvents.push(evt);
    });

    const startedAt = performance.now();
    const res1 = await pool.execute((client) => client.queryBalance("GUSER1"));
    const elapsedSocketDropMs = performance.now() - startedAt;

    assert.equal(res1.providerUrl, "https://horizon-secondary.stellar.org");
    assert.ok(
      elapsedSocketDropMs < 500,
      `Expected failover under 500ms, got ${elapsedSocketDropMs}ms`
    );
    assert.equal(failoverEvents.length, 1);
    assert.equal(failoverEvents[0].fromNodeId, "primary-horizon");
    assert.equal(failoverEvents[0].toNodeId, "secondary-horizon");

    const statusAfterDrop = pool.getPoolStatus();
    const primaryStatus = statusAfterDrop.find((n) => n.id === "primary-horizon")!;
    assert.equal(primaryStatus.circuitState, CircuitState.OPEN);
    assert.equal(primaryStatus.healthy, false);

    // Subsequent calls route directly to secondary without hitting OPEN primary
    const res2 = await pool.execute((client) => client.queryBalance("GUSER2"));
    assert.equal(res2.providerUrl, "https://horizon-secondary.stellar.org");
  });

  it("marks out-of-sync nodes lagging behind pool ledger height as degraded and reinstates recovered nodes", async () => {
    let nowMs = 1_700_000_000_000;
    const reinstatedNodeIds: string[] = [];
    const nodeState: Record<string, { ledger: number; latencyMs: number; fail: boolean }> = {
      "https://rpc-1.stellar.org": { ledger: 900_000, latencyMs: 25, fail: true },
      "https://rpc-2.stellar.org": { ledger: 900_000, latencyMs: 45, fail: false },
      "https://rpc-stale.stellar.org": { ledger: 899_950, latencyMs: 10, fail: false }, // 50 ledgers behind!
    };

    const pool = new StellarNodeFailoverPool<MockHorizonClient>({
      nodes: [
        { id: "rpc-1", url: "https://rpc-1.stellar.org" },
        { id: "rpc-2", url: "https://rpc-2.stellar.org" },
        { id: "rpc-stale", url: "https://rpc-stale.stellar.org" },
      ],
      now: () => nowMs,
      failureThreshold: 1,
      reinstatementSuccessThreshold: 2,
      cooldownPeriodMs: 5_000,
      maxLedgerLag: 5,
      createClient: (url) => ({
        url,
        pingLedger: async () => {
          const s = nodeState[url];
          if (s.fail) {
            const err = new Error("502 Bad Gateway") as Error & { status?: number };
            err.status = 502;
            throw err;
          }
          return { sequence: s.ledger, latencyMs: s.latencyMs };
        },
        queryBalance: async () => ({ providerUrl: url, balance: "50.0000000" }),
      }),
      probe: async (client) => {
        const res = await client.pingLedger();
        return { ledgerSequence: res.sequence, latencyMs: res.latencyMs };
      },
    });

    pool.events.on("node:reinstated", (evt: { nodeId: string }) => {
      reinstatedNodeIds.push(evt.nodeId);
    });

    const statuses = await pool.checkAllNodes();
    const rpc1 = statuses.find((s) => s.id === "rpc-1")!;
    const rpc2 = statuses.find((s) => s.id === "rpc-2")!;
    const rpcStale = statuses.find((s) => s.id === "rpc-stale")!;

    assert.equal(rpc1.circuitState, CircuitState.OPEN);
    assert.equal(rpc1.eligible, false);
    assert.equal(rpc2.eligible, true);
    // Even though rpc-stale has 10ms latency, its ledger lag (50 > 5) disqualifies it
    assert.equal(rpcStale.eligible, false);
    assert.equal(rpcStale.ledgerLag, 50);
    assert.equal(pool.selectHealthyNode().id, "rpc-2");

    // Advance clock past cooldownPeriodMs and recover rpc-1
    nowMs += 6_000;
    nodeState["https://rpc-1.stellar.org"].fail = false;

    // Probe 1 in HALF_OPEN -> 1st consecutive success (threshold is 2)
    await pool.checkAllNodes();
    assert.equal(
      pool.getPoolStatus().find((s) => s.id === "rpc-1")!.circuitState,
      CircuitState.HALF_OPEN
    );

    // Probe 2 in HALF_OPEN -> reaches reinstatementSuccessThreshold (2) -> CLOSED & reinstated!
    await pool.checkAllNodes();
    const reinstatedStatus = pool.getPoolStatus().find((s) => s.id === "rpc-1")!;
    assert.equal(reinstatedStatus.circuitState, CircuitState.CLOSED);
    assert.equal(reinstatedStatus.healthy, true);
    assert.equal(reinstatedStatus.eligible, true);
    assert.deepEqual(reinstatedNodeIds, ["rpc-1"]);

    // Traffic now routes back to rpc-1 because its latency (25ms) < rpc-2 (45ms)
    assert.equal(pool.selectHealthyNode().id, "rpc-1");
  });

  it("parses comma-separated endpoint lists with fallback", () => {
    assert.deepEqual(
      parseEndpointList(
        " https://horizon-1.stellar.org , https://horizon-2.stellar.org ",
        "https://fallback.stellar.org"
      ),
      ["https://horizon-1.stellar.org", "https://horizon-2.stellar.org"]
    );
    assert.deepEqual(
      parseEndpointList("", "https://fallback.stellar.org"),
      ["https://fallback.stellar.org"]
    );
  });
});
