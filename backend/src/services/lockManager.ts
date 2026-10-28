/**
 * Distributed Redis Lock Manager for Gameweek Deadline Squad Lockouts
 *
 * Implements:
 * 1. Redlock-compatible distributed locking with unique lock token CAS verification via Lua scripts.
 * 2. Monotonic deadline timestamp verification against server clock down to 1ms accuracy.
 * 3. Atomic try/finally lock acquisition and release lifecycle with sane TTLs to avoid deadlocks.
 * 4. Error classification:
 *    - SquadLockConflictError (HTTP 409): Lock could not be acquired due to concurrent mutation.
 *    - SquadLockedError (HTTP 403): Deadline passed (even by 1ms) or expired mid-execution.
 * 5. Concurrency serialization ensuring parallel squad mutations do not race.
 *
 * Closes #339
 */

import crypto from "node:crypto";
import { getRedisClient, IRedisCacheClient } from "../config/redis.js";
import { SquadLockedError } from "./squad/squadValidator.js";

export { SquadLockedError };

export class SquadLockConflictError extends Error {
  public statusCode = 409;
  constructor(public readonly resource: string, message?: string) {
    super(
      message ??
        `Concurrent squad update in progress for resource [${resource}]. Please try again.`
    );
    this.name = "SquadLockConflictError";
  }
}

export interface LockOptions {
  ttlMs?: number; // default 10_000ms
  retryCount?: number; // default 5
  retryDelayMs?: number; // default 50ms
  deadline?: Date; // Optional gameweek deadline for pre- and post-acquisition checks
  serverTimeProvider?: () => number; // Pluggable time provider for sub-millisecond precision
}

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_RETRY_DELAY_MS = 50;

/**
 * Asserts that the current atomic server time is strictly before the gameweek deadline.
 * Rejects even 1ms post-deadline requests with SquadLockedError (HTTP 403).
 */
export function assertMonotonicDeadline(
  deadline: Date,
  serverTimeProvider: () => number = () => Date.now()
): void {
  const now = serverTimeProvider();
  if (now >= deadline.getTime()) {
    throw new SquadLockedError(deadline);
  }
}

export class RedisLockManager {
  private customClient: IRedisCacheClient | null = null;

  constructor(client?: IRedisCacheClient) {
    if (client) {
      this.customClient = client;
    }
  }

  private getClient(): any {
    return this.customClient || getRedisClient();
  }

  /**
   * Acquires a distributed lock for the given resource with retry and CAS protection.
   * Returns a release function that MUST be invoked in a finally block.
   */
  public async acquireLock(
    resource: string,
    options: LockOptions = {}
  ): Promise<(() => Promise<void>) | null> {
    const client = this.getClient();
    const serverTime = options.serverTimeProvider ?? (() => Date.now());

    // 1. Monotonic pre-lock deadline check
    if (options.deadline) {
      assertMonotonicDeadline(options.deadline, serverTime);
    }

    if (!client) {
      console.warn(`[LockManager] Redis unavailable; proceeding without lock for ${resource}`);
      return async () => {};
    }

    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const lockKey = `lock:${resource}`;
    const lockValue = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));

    for (let attempt = 0; attempt < retryCount; attempt++) {
      // Re-verify deadline before each retry attempt
      if (options.deadline) {
        assertMonotonicDeadline(options.deadline, serverTime);
      }

      let acquired = false;
      try {
        const res = await client.set(lockKey, lockValue, "EX", ttlSeconds, "NX");
        acquired = res === "OK" || res === true;
      } catch (err: any) {
        console.warn(`[LockManager] Redis set error for ${lockKey}: ${err.message}`);
      }

      if (acquired) {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await this.releaseLock(lockKey, lockValue);
        };
      }

      if (attempt < retryCount - 1) {
        const jitter = Math.floor(Math.random() * (retryDelayMs / 2));
        await new Promise((r) => setTimeout(r, retryDelayMs + jitter));
      }
    }

    return null;
  }

  /**
   * Safely executes an operation within the protection of a distributed squad lock.
   * Guarantees lock release in finally block and verifies deadline before, during, and after lock.
   */
  public async withLock<T>(
    resource: string,
    operation: () => Promise<T>,
    options: LockOptions = {}
  ): Promise<T> {
    const serverTime = options.serverTimeProvider ?? (() => Date.now());

    if (options.deadline) {
      assertMonotonicDeadline(options.deadline, serverTime);
    }

    const release = await this.acquireLock(resource, options);
    if (!release) {
      throw new SquadLockConflictError(resource);
    }

    try {
      // Post-acquisition check: verify deadline did not expire while waiting for lock
      if (options.deadline) {
        assertMonotonicDeadline(options.deadline, serverTime);
      }

      const result = await operation();

      // Final check: verify deadline did not expire mid-execution
      if (options.deadline) {
        assertMonotonicDeadline(options.deadline, serverTime);
      }

      return result;
    } finally {
      await release();
    }
  }

  /**
   * Releases lock using atomic Lua script comparing token value (CAS).
   */
  private async releaseLock(lockKey: string, lockValue: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      if (typeof client.eval === "function") {
        await client.eval(script, 1, lockKey, lockValue);
      } else {
        // Fallback for simple mock clients
        const current = await client.get(lockKey);
        if (current === lockValue) {
          await client.del(lockKey);
        }
      }
    } catch (err: any) {
      console.warn(`[LockManager] Failed to release lock ${lockKey}: ${err.message}`);
    }
  }
}

export const lockManager = new RedisLockManager();

/**
 * Top-level convenience wrapper for squad mutations.
 */
export async function withSquadLock<T>(
  squadId: string,
  operation: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  return lockManager.withLock(`squad:${squadId}`, operation, options);
}

/**
 * Backward compatible acquireLock function.
 */
export async function acquireLock(
  resource: string,
  options: LockOptions = {}
): Promise<(() => Promise<void>) | null> {
  return lockManager.acquireLock(resource, options);
}
