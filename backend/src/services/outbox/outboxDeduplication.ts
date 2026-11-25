/**
 * Issue #438 — Outbox Event Deduplication Store
 *
 * Since the relay delivers at-least-once, downstream consumers must guard
 * against processing the same event twice.  This module provides a simple
 * two-tier deduplication guard:
 *
 *  1. In-memory LRU set for the most-recently-seen deduplication IDs
 *     (sub-microsecond check for the hot path).
 *  2. Redis SET with per-entry TTL as the durable, cross-node seen-set.
 *
 * Usage
 * ─────
 *   if (await deduplicationStore.alreadySeen(deduplicationId)) return; // skip
 *   await deduplicationStore.markSeen(deduplicationId);
 *   // … process event …
 *
 * The TTL for the Redis entry matches the outbox cleanup window so a
 * deduplication ID is "forgotten" only after PUBLISHED rows have also been
 * removed.  This prevents re-processing if a row is somehow re-enqueued.
 */

import { LRUCache } from "lru-cache";
import { getRedisClient } from "../../config/redis.js";

const LOCAL_MAX = Number(process.env.OUTBOX_DEDUP_LOCAL_MAX ?? 50_000);
const REDIS_TTL_S = Number(process.env.OUTBOX_DEDUP_REDIS_TTL_S ?? 2 * 24 * 3600); // 48 h

const localSeen = new LRUCache<string, true>({
  max: LOCAL_MAX,
  ttl: REDIS_TTL_S * 1000,
  ttlAutopurge: false,
  allowStale: false,
});

const REDIS_KEY_PREFIX = "outbox:dedup:";

export const deduplicationStore = {
  /**
   * Returns true if `deduplicationId` was already processed.
   * Checks local LRU first; falls back to Redis on a miss.
   */
  async alreadySeen(deduplicationId: string): Promise<boolean> {
    if (localSeen.get(deduplicationId)) return true;

    const redis = getRedisClient();
    if (!redis) return false;

    try {
      const val = await redis.get(`${REDIS_KEY_PREFIX}${deduplicationId}`);
      if (val !== null) {
        localSeen.set(deduplicationId, true); // warm the local cache
        return true;
      }
    } catch {
      // If Redis is unreachable, allow the event through (prefer reprocessing
      // over silent drops); consumers should be idempotent anyway.
    }
    return false;
  },

  /**
   * Records `deduplicationId` as processed in both the local LRU and Redis.
   */
  async markSeen(deduplicationId: string): Promise<void> {
    localSeen.set(deduplicationId, true);

    const redis = getRedisClient();
    if (!redis) return;

    try {
      await redis.set(
        `${REDIS_KEY_PREFIX}${deduplicationId}`,
        "1",
        "EX",
        REDIS_TTL_S,
      );
    } catch {
      // Best-effort; the local LRU still guards the current process
    }
  },

  /** Clears local state (used by tests). */
  clearLocal(): void {
    localSeen.clear();
  },
};
