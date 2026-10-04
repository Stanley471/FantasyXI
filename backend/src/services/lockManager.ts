import { getRedisClient } from "../../config/redis.js";

/**
 * Distributed lock manager using Redis.
 *
 * Implements a Redlock-like algorithm for safe concurrent access to critical
 * squad mutation paths during Gameweek deadlines.
 *
 * Laravel equivalent: Like a Redis lock wrapper around critical job dispatching.
 */

export interface LockOptions {
  ttlMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
}

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY_MS = 200;

/**
 * Acquires a distributed lock for the given resource.
 * Returns a release function that must be called in a finally block.
 */
export async function acquireLock(
  resource: string,
  options: LockOptions = {}
): Promise<(() => Promise<void>) | null> {
  const client = getRedisClient();
  if (!client) {
    console.warn(`[LockManager] Redis unavailable; proceeding without lock for ${resource}`);
    return null;
  }

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const lockKey = `lock:${resource}`;
  const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ttlSeconds = Math.ceil(ttlMs / 1000);

  for (let attempt = 0; attempt < retryCount; attempt++) {
    const acquired = await client.set(lockKey, lockValue, "NX", "EX", ttlSeconds);
    if (acquired === "OK") {
      return async () => {
        await releaseLock(lockKey, lockValue);
      };
    }

    if (attempt < retryCount - 1) {
      await sleep(retryDelayMs);
    }
  }

  console.error(`[LockManager] Failed to acquire lock for ${resource} after ${retryCount} attempts`);
  return null;
}

/**
 * Releases a distributed lock safely using the lock value.
 */
async function releaseLock(lockKey: string, lockValue: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  try {
    await client.eval(script, 1, lockKey, lockValue);
  } catch {
    console.warn(`[LockManager] Failed to release lock ${lockKey}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
