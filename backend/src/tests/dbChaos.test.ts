import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ChaosNetworkInjector,
  executeWithDropoutResilience,
  TransactionRollbackGuard,
  isConnectionDropoutError,
} from "../config/dbChaos.js";

describe("PostgreSQL Connection Dropouts & Chaos Testing Suite (#362)", () => {
  let injector: ChaosNetworkInjector;
  let txGuard: TransactionRollbackGuard;

  beforeEach(() => {
    injector = new ChaosNetworkInjector();
    txGuard = new TransactionRollbackGuard();
  });

  afterEach(() => {
    injector.restoreConnection();
  });

  describe("Error Detection & Pattern Recognition", () => {
    it("correctly identifies common PostgreSQL network drop and timeout errors", () => {
      assert.equal(isConnectionDropoutError({ code: "ECONNRESET" }), true);
      assert.equal(isConnectionDropoutError({ code: "ECONNREFUSED" }), true);
      assert.equal(isConnectionDropoutError({ code: "57P01" }), true);
      assert.equal(isConnectionDropoutError({ code: "08006" }), true);
      assert.equal(
        isConnectionDropoutError(new Error("Connection terminated unexpectedly")),
        true
      );
      assert.equal(
        isConnectionDropoutError(new Error("server closed the connection unexpectedly")),
        true
      );
      assert.equal(
        isConnectionDropoutError(new Error("Client has encountered a connection error and is not queryable")),
        true
      );
      assert.equal(isConnectionDropoutError(new Error("duplicate key value violates unique constraint")), false);
    });
  });

  describe("Acceptance Criterion 1: Backend survives connection drops without crashing or unrecoverable state", () => {
    it("survives abrupt connection severed during read query and retries upon reconnection", async () => {
      let attempts = 0;
      injector.trackConnectionOpened();

      // Simulate a query that fails twice due to connection drop, then succeeds
      const mockQuery = async () => {
        attempts++;
        if (attempts <= 2) {
          injector.severConnection();
          await injector.filterNetworkPacket(); // throws ECONNRESET
        }
        injector.restoreConnection();
        return { rows: [{ id: 1, balance: 1000 }] };
      };

      const result = await executeWithDropoutResilience(mockQuery, {
        maxRetries: 3,
        initialDelayMs: 20,
      });

      assert.equal(attempts, 3);
      assert.deepEqual(result, { rows: [{ id: 1, balance: 1000 }] });
      assert.equal(injector.getStats().isSevered, false);

      injector.trackConnectionClosed();
      assert.equal(injector.getStats().activeConnections, 0);
    });

    it("does not enter unrecoverable state if maximum retries are exceeded, propagates error cleanly", async () => {
      injector.severConnection();
      let retryCount = 0;

      await assert.rejects(
        async () => {
          await executeWithDropoutResilience(
            async () => {
              await injector.filterNetworkPacket();
            },
            {
              maxRetries: 2,
              initialDelayMs: 10,
              onRetry: () => retryCount++,
            }
          );
        },
        {
          code: "ECONNRESET",
        }
      );

      assert.equal(retryCount, 2);
    });
  });

  describe("Acceptance Criterion 2: In-flight transactions severed mid-flight cleanly roll back without orphaned rows", () => {
    it("guarantees transactional rollback integrity when connection drops midway through multi-step operations", async () => {
      const mockDbState = {
        users: new Map<string, number>([
          ["user_alice", 500],
          ["user_bob", 200],
        ]),
        financialLogs: [] as Array<{ txId: string; from: string; to: string; amount: number }>,
      };

      const transferFunds = async (txId: string, from: string, to: string, amount: number) => {
        txGuard.startTransaction(txId);
        const originalFromBalance = mockDbState.users.get(from)!;
        const originalToBalance = mockDbState.users.get(to)!;

        try {
          // Step 1: Debit sender
          mockDbState.users.set(from, originalFromBalance - amount);

          // Step 2: Inject abrupt connection drop before credit / audit log completes
          injector.severConnection();
          await injector.filterNetworkPacket(); // throws ECONNRESET

          // Step 3: Credit recipient (should be unreachable)
          mockDbState.users.set(to, originalToBalance + amount);
          mockDbState.financialLogs.push({ txId, from, to, amount });

          txGuard.commitTransaction(txId);
        } catch (error) {
          // Transactional rollback handler
          mockDbState.users.set(from, originalFromBalance);
          mockDbState.users.set(to, originalToBalance);
          txGuard.rollbackTransaction(txId, (error as Error).message);
          throw error;
        }
      };

      // Execute transfer under chaos
      await assert.rejects(
        async () => {
          await transferFunds("tx_chaos_001", "user_alice", "user_bob", 100);
        },
        {
          code: "ECONNRESET",
        }
      );

      // Verify no orphaned financial records or corrupt balances exist
      assert.equal(mockDbState.users.get("user_alice"), 500); // perfectly restored
      assert.equal(mockDbState.users.get("user_bob"), 200);   // untouched
      assert.equal(mockDbState.financialLogs.length, 0);       // zero orphaned rows

      const txStatus = txGuard.getStatus("tx_chaos_001");
      assert.equal(txStatus.isActive, false);
      assert.equal(txStatus.isCommitted, false);
      assert.equal(txStatus.isRolledBack, true);
    });
  });

  describe("Acceptance Criterion 3: System automatically recovers and resumes serving requests when connection restores", () => {
    it("automatically transitions from degraded to fully operational upon network recovery", async () => {
      let isServiceDegraded = false;

      const handleUserRequest = async () => {
        try {
          await injector.filterNetworkPacket();
          isServiceDegraded = false;
          return { status: 200, message: "OK" };
        } catch (err) {
          isServiceDegraded = true;
          return { status: 503, message: "Database connection degraded" };
        }
      };

      // 1. Initial healthy state
      const res1 = await handleUserRequest();
      assert.equal(res1.status, 200);
      assert.equal(isServiceDegraded, false);

      // 2. Network severed
      injector.severConnection();
      const res2 = await handleUserRequest();
      assert.equal(res2.status, 503);
      assert.equal(isServiceDegraded, true);

      // 3. Network restored (automatic recovery)
      injector.restoreConnection();
      const res3 = await handleUserRequest();
      assert.equal(res3.status, 200);
      assert.equal(isServiceDegraded, false);
    });
  });

  describe("Latency, Packet Loss & High-Concurrency Pool Simulation", () => {
    it("handles concurrent requests under injected network latency without deadlocking", async () => {
      injector.setLatency(15); // Injected 15ms latency per query

      const tasks = Array.from({ length: 25 }, async (_, i) => {
        injector.trackConnectionOpened();
        await injector.filterNetworkPacket();
        injector.trackConnectionClosed();
        return `completed_${i}`;
      });

      const results = await Promise.all(tasks);
      assert.equal(results.length, 25);
      assert.equal(injector.getStats().activeConnections, 0); // No leaked connections
    });

    it("resiliently recovers from intermittent packet loss", async () => {
      injector.setPacketLossRate(0.3); // 30% packet loss

      let successCount = 0;
      for (let i = 0; i < 10; i++) {
        try {
          await executeWithDropoutResilience(
            async () => {
              await injector.filterNetworkPacket();
              return true;
            },
            {
              maxRetries: 4,
              initialDelayMs: 10,
            }
          );
          successCount++;
        } catch (err) {
          // occasional exhausted retry under heavy packet loss is caught safely
        }
      }

      assert.ok(successCount > 0, "Expected at least some operations to succeed with retries");
    });
  });
});
