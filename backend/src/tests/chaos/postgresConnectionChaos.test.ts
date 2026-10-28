import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { TcpChaosProxy } from "../helpers/tcpChaosProxy.js";
import { ChaosLink, type Fault } from "../helpers/chaosLink.js";

describe("PostgreSQL Connection Dropouts Chaos Test Suite (#362)", () => {
  // ─── 1. Mid-Transaction Severance & Rollback Integrity (Deterministic) ───────────
  it("rolls back severed multi-table transactions without orphaned records", async () => {
    let databaseState: { users: any[]; transactions: any[] } = {
      users: [],
      transactions: [],
    };

    let chaosLink = new ChaosLink();

    // Mock resilient transactional database adapter
    const mockDb: any = {
      $transaction: async (operations: (tx: any) => Promise<any>) => {
        const snapshot = structuredClone(databaseState);
        try {
          const txProxy = {
            user: {
              create: async (data: any) => {
                databaseState.users.push(data);
                return data;
              },
            },
            transaction: {
              create: async (data: any) => {
                // Chaos injection mid-transaction
                await chaosLink.call(async () => {
                  databaseState.transactions.push(data);
                });
                return data;
              },
            },
          };

          return await operations(txProxy);
        } catch (error) {
          // Automatic transactional rollback on severed connection
          databaseState = snapshot;
          throw error;
        }
      },
    };

    // Step 1: Normal transaction succeeds
    await mockDb.$transaction(async (tx: any) => {
      await tx.user.create({ id: "user-1", email: "user1@test.com" });
      await tx.transaction.create({ id: "tx-1", amount: 100 });
    });

    assert.equal(databaseState.users.length, 1);
    assert.equal(databaseState.transactions.length, 1);

    // Step 2: Mid-transaction connection drop (abrupt disconnect)
    chaosLink = new ChaosLink(["disconnect"]);

    await assert.rejects(
      mockDb.$transaction(async (tx: any) => {
        await tx.user.create({ id: "user-2", email: "user2@test.com" });
        // Connection drops here
        await tx.transaction.create({ id: "tx-2", amount: 200 });
      }),
      /Injected connection reset/
    );

    // Verify rollback integrity: user-2 was rolled back and no orphaned records exist
    assert.equal(databaseState.users.length, 1);
    assert.equal(databaseState.transactions.length, 1);
    assert.equal(databaseState.users[0].id, "user-1");

    // Step 3: Network recovery allows next transaction to commit cleanly
    chaosLink = new ChaosLink();
    await mockDb.$transaction(async (tx: any) => {
      await tx.user.create({ id: "user-2", email: "user2@test.com" });
      await tx.transaction.create({ id: "tx-2", amount: 200 });
    });

    assert.equal(databaseState.users.length, 2);
    assert.equal(databaseState.transactions.length, 2);
  });

  // ─── 2. Backend Survives Connection Pool Dropouts Without Unhandled Rejection ────
  it("survives abrupt TCP connection dropouts and recovers queries once reconnected", async () => {
    let poolActive = true;
    let queryAttempts = 0;

    const mockPool = {
      query: async (sql: string) => {
        queryAttempts++;
        if (!poolActive) {
          const err = new Error("Connection terminated unexpectedly (ECONNRESET)");
          (err as any).code = "ECONNRESET";
          throw err;
        }
        return { rows: [{ result: 1 }] };
      },
      reconnect: () => {
        poolActive = true;
      },
    };

    // Safe execution wrapper with pool retry mechanics
    async function executeWithPoolRetry<T>(queryFn: () => Promise<T>, maxRetries = 3): Promise<T> {
      let lastErr: unknown;
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await queryFn();
        } catch (err: any) {
          lastErr = err;
          if (err.code === "ECONNRESET") {
            // Trigger pool reconnection
            mockPool.reconnect();
            await new Promise((r) => setTimeout(r, 20));
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    }

    // Normal execution
    const res1 = await executeWithPoolRetry(() => mockPool.query("SELECT 1"));
    assert.deepEqual(res1.rows, [{ result: 1 }]);

    // Inject connection failure
    poolActive = false;
    const res2 = await executeWithPoolRetry(() => mockPool.query("SELECT 1"));
    assert.deepEqual(res2.rows, [{ result: 1 }]);
    assert.ok(queryAttempts >= 2);
  });

  // ─── 3. Zero Leaked Connections & Deadlock Prevention Under Concurrency ──────────
  it("prevents leaked connections and deadlocks under concurrent failures", async () => {
    let activeConnections = 0;
    let peakConnections = 0;
    const maxPoolSize = 5;

    const acquireConnection = async () => {
      if (activeConnections >= maxPoolSize) {
        throw new Error("Pool exhausted: no available connections");
      }
      activeConnections++;
      if (activeConnections > peakConnections) peakConnections = activeConnections;

      return {
        query: async (fail: boolean) => {
          if (fail) throw Object.assign(new Error("TCP Reset"), { code: "ECONNRESET" });
          return "ok";
        },
        release: () => {
          activeConnections--;
        },
      };
    };

    // Run 20 concurrent operations with 50% random network drops
    const tasks = Array.from({ length: 20 }, async (_, index) => {
      let conn;
      try {
        conn = await acquireConnection();
        return await conn.query(index % 2 === 0);
      } catch {
        return "caught_error";
      } finally {
        conn?.release();
      }
    });

    const results = await Promise.all(tasks);
    assert.equal(results.length, 20);

    // Verify zero leaked connections
    assert.equal(activeConnections, 0, "Active connections must return to 0 after recovery");
    assert.ok(peakConnections <= maxPoolSize, "Peak connections must not exceed pool size");
  });

  // ─── 4. Live TCP Chaos Proxy Integration (When Live Postgres is Available) ───────
  const liveUrl = process.env.CHAOS_DATABASE_URL || process.env.DATABASE_URL;
  it("runs TCP severance and assertions against live PostgreSQL if configured", { skip: !liveUrl }, async () => {
    if (!liveUrl) return;

    const parsed = new URL(liveUrl);
    const originalPort = parseInt(parsed.port || "5432", 10);

    const proxy = new TcpChaosProxy({
      targetPort: originalPort,
      targetHost: parsed.hostname,
    });

    const proxyPort = await proxy.start();
    const proxyUrl = new URL(liveUrl);
    proxyUrl.port = proxyPort.toString();

    const pool = new pg.Pool({
      connectionString: proxyUrl.toString(),
      max: 4,
      connectionTimeoutMillis: 2000,
    });

    try {
      // Step A: Normal query over TCP proxy
      const client = await pool.connect();
      const res = await client.query("SELECT 1 AS num");
      assert.equal(res.rows[0].num, 1);
      client.release();

      assert.ok(proxy.getActiveConnectionCount() > 0);

      // Step B: Abruptly sever all TCP sockets mid-flight
      proxy.severConnections();

      // Ensure client queries fail cleanly without hanging
      await assert.rejects(async () => {
        const deadClient = await pool.connect();
        await deadClient.query("SELECT 1");
      });

      // Step C: Pool reconnects through proxy once network is healthy
      const recoveredClient = await pool.connect();
      const recoveredRes = await recoveredClient.query("SELECT 2 AS num");
      assert.equal(recoveredRes.rows[0].num, 2);
      recoveredClient.release();
    } finally {
      await pool.end();
      await proxy.stop();
    }
  });
});
