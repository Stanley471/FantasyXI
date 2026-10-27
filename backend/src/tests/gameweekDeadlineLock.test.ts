import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RedisLockManager,
  SquadLockConflictError,
  SquadLockedError,
  assertMonotonicDeadline,
} from "../services/lockManager.js";
import { IRedisCacheClient } from "../config/redis.js";

/**
 * Creates an in-memory Redis mock supporting atomic SET NX EX, GET, DEL, and Lua EVAL.
 */
function createMockRedisClient(): IRedisCacheClient & { store: Map<string, { val: string; exp: number }> } {
  const store = new Map<string, { val: string; exp: number }>();

  const isExpired = (key: string) => {
    const item = store.get(key);
    if (!item) return true;
    if (Date.now() > item.exp) {
      store.delete(key);
      return true;
    }
    return false;
  };

  return {
    store,
    get: async (key: string) => {
      if (isExpired(key)) return null;
      return store.get(key)!.val;
    },
    set: async (key: string, value: string, mode?: string, duration?: number, nx?: string) => {
      const exists = !isExpired(key);
      if (nx === "NX" && exists) {
        return null;
      }
      const exp = duration ? Date.now() + duration * 1000 : Infinity;
      store.set(key, { val: value, exp });
      return "OK";
    },
    del: async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
    keys: async (_pattern: string) => Array.from(store.keys()),
    eval: async (_script: string, _numkeys: number, key: string, value: string) => {
      const current = store.get(key);
      if (current && current.val === value) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };
}

describe("Distributed Redis Lock Manager for Gameweek Deadline Squad Lockouts (#339)", () => {
  describe("Monotonic Server Clock Deadline Verification", () => {
    it("permits mutations submitted strictly before deadline (e.g. 1ms before)", () => {
      const deadline = new Date(1700000000000);
      let simulatedTime = 1700000000000 - 1; // 1ms before

      // Should not throw
      assert.doesNotThrow(() => {
        assertMonotonicDeadline(deadline, () => simulatedTime);
      });
    });

    it("rejects mutations submitted exactly at or 1ms post-deadline with SquadLockedError (HTTP 403)", () => {
      const deadline = new Date(1700000000000);

      // Exactly at deadline
      assert.throws(
        () => assertMonotonicDeadline(deadline, () => 1700000000000),
        (err: any) => {
          assert.ok(err instanceof SquadLockedError);
          assert.equal(err.name, "SquadLockedError");
          return true;
        }
      );

      // 1ms after deadline
      assert.throws(
        () => assertMonotonicDeadline(deadline, () => 1700000000001),
        (err: any) => {
          assert.ok(err instanceof SquadLockedError);
          return true;
        }
      );
    });
  });

  describe("Serialization of Concurrent Squad Mutations", () => {
    it("serializes concurrent updates for the same squad", async () => {
      const mockRedis = createMockRedisClient();
      const lockManager = new RedisLockManager(mockRedis);

      const executionOrder: string[] = [];
      const squadId = "squad-alpha-123";

      // Launch 3 asynchronous tasks competing for the same squad lock
      const task1 = lockManager.withLock(`squad:${squadId}`, async () => {
        executionOrder.push("task1-start");
        await new Promise((r) => setTimeout(r, 60));
        executionOrder.push("task1-end");
        return "result1";
      }, { retryCount: 10, retryDelayMs: 20 });

      const task2 = lockManager.withLock(`squad:${squadId}`, async () => {
        executionOrder.push("task2-start");
        await new Promise((r) => setTimeout(r, 40));
        executionOrder.push("task2-end");
        return "result2";
      }, { retryCount: 10, retryDelayMs: 20 });

      const [r1, r2] = await Promise.all([task1, task2]);

      assert.equal(r1, "result1");
      assert.equal(r2, "result2");

      // Verify that task1 and task2 executed serially, never interleaved
      assert.ok(
        (executionOrder[0] === "task1-start" && executionOrder[1] === "task1-end") ||
        (executionOrder[0] === "task2-start" && executionOrder[1] === "task2-end"),
        `Expected non-interleaved execution, got: ${executionOrder.join(" -> ")}`
      );

      // Verify lock is completely released after completion
      assert.equal(mockRedis.store.has(`lock:squad:${squadId}`), false);
    });

    it("guarantees automatic lock release via try/finally even when operation fails", async () => {
      const mockRedis = createMockRedisClient();
      const lockManager = new RedisLockManager(mockRedis);
      const squadId = "squad-error-test";

      await assert.rejects(
        lockManager.withLock(`squad:${squadId}`, async () => {
          throw new Error("Simulated database failure mid-mutation");
        }),
        /Simulated database failure mid-mutation/
      );

      // Lock MUST be released
      assert.equal(mockRedis.store.has(`lock:squad:${squadId}`), false);

      // Subsequent acquisition on same resource succeeds immediately
      let nextExecuted = false;
      await lockManager.withLock(`squad:${squadId}`, async () => {
        nextExecuted = true;
      });
      assert.equal(nextExecuted, true);
    });

    it("throws SquadLockConflictError (HTTP 409) when lock cannot be obtained within retry limit", async () => {
      const mockRedis = createMockRedisClient();
      const lockManager = new RedisLockManager(mockRedis);
      const squadId = "squad-contested";

      // Manually acquire lock and hold it
      const release = await lockManager.acquireLock(`squad:${squadId}`, { ttlMs: 5000 });
      assert.ok(release);

      // Attempting to acquire with fast retry exhaustion must throw SquadLockConflictError
      await assert.rejects(
        lockManager.withLock(`squad:${squadId}`, async () => "never", {
          retryCount: 2,
          retryDelayMs: 10,
        }),
        (err: any) => {
          assert.ok(err instanceof SquadLockConflictError);
          assert.equal(err.statusCode, 409);
          return true;
        }
      );

      await release();
    });
  });

  describe("High-Concurrency Deadline Cutoff Simulation", () => {
    it("handles hundreds of parallel requests at the exact second of deadline cutoff", async () => {
      const mockRedis = createMockRedisClient();
      const lockManager = new RedisLockManager(mockRedis);

      const deadlineTimestamp = 1700000000000;
      const deadline = new Date(deadlineTimestamp);

      let successCount = 0;
      let deadlineRejectedCount = 0;
      let conflictCount = 0;

      // Simulate 100 concurrent requests arriving across a 20ms window around deadline:
      // - 50 requests arrive before deadline (e.g. deadline - 10ms to deadline - 1ms)
      // - 50 requests arrive at or after deadline (e.g. deadline to deadline + 10ms)
      const requestPromises: Promise<void>[] = [];

      for (let i = 0; i < 100; i++) {
        // Half before, half at/after
        const simulatedTime = i < 50
          ? deadlineTimestamp - (50 - i) // 50ms..1ms before
          : deadlineTimestamp + (i - 50); // 0ms..49ms after

        const promise = (async () => {
          try {
            await lockManager.withLock(
              `squad:shared-concurrency-${i % 10}`, // 10 distinct squads under heavy concurrency
              async () => {
                await new Promise((r) => setTimeout(r, 5));
                return "mutated";
              },
              {
                deadline,
                serverTimeProvider: () => simulatedTime,
                retryCount: 5,
                retryDelayMs: 10,
              }
            );
            successCount++;
          } catch (err: any) {
            if (err instanceof SquadLockedError) {
              deadlineRejectedCount++;
            } else if (err instanceof SquadLockConflictError) {
              conflictCount++;
            } else {
              throw err;
            }
          }
        })();

        requestPromises.push(promise);
      }

      await Promise.all(requestPromises);

      // All 50 requests after deadline MUST be rejected with SquadLockedError
      assert.equal(
        deadlineRejectedCount,
        50,
        `Expected exactly 50 requests rejected post-deadline, got ${deadlineRejectedCount}`
      );

      // The requests before deadline either succeeded or received 409 conflict under extreme contention
      assert.ok(successCount > 0, "Some pre-deadline requests must have succeeded");
      assert.equal(successCount + conflictCount, 50, "All 50 pre-deadline requests must either succeed or safely conflict");

      // Zero locks leaked in Redis
      assert.equal(mockRedis.store.size, 0, "All Redis locks must be released");
    });
  });
});
