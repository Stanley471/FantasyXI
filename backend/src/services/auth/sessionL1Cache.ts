/**
 * Issue #439 — L1 In-Memory Session Cache
 *
 * Node-local LRU cache for active session validation.  Sits in front of the
 * full Redis / DB lookup and answers the overwhelming majority of auth-
 * middleware calls without any network round trip.
 *
 * Design decisions
 * ─────────────────
 * • LRU eviction — bounded by SESSION_L1_MAX_SIZE (default 10 000 entries).
 *   Entries are evicted least-recently-used when the ceiling is hit, so hot
 *   sessions stay warm even if many idle sessions exist.
 * • Per-entry TTL — each entry stores its own absolute expiry timestamp so
 *   the cache never serves a structurally expired session even if the LRU
 *   clock hasn't evicted it yet.
 * • Revocation tombstones — a revoked session is *replaced* with a negative
 *   entry (valid: false) rather than deleted, so the cache can answer
 *   "is this revoked?" without falling through to Redis/DB.  Tombstones use
 *   a shorter TTL (SESSION_L1_TOMBSTONE_TTL_MS, default 90 s) to bound
 *   memory usage from rapidly recycled session IDs.
 * • No external dependency — the cache implementation depends only on
 *   lru-cache (already a transitive dep of @apollo/server).
 */

import { LRUCache } from "lru-cache";

export interface L1CacheEntry {
  userId: string;
  expiresAt: number; // Unix-ms absolute expiry of the *session* (not the cache entry)
  valid: boolean; // false = revocation tombstone
}

const MAX_SIZE = Number(process.env.SESSION_L1_MAX_SIZE ?? 10_000);
const TOMBSTONE_TTL_MS = Number(process.env.SESSION_L1_TOMBSTONE_TTL_MS ?? 90_000); // 90 s

// lru-cache v10+ uses `ttl` per-entry (ms) and auto-evicts stale entries.
const cache = new LRUCache<string, L1CacheEntry>({
  max: MAX_SIZE,
  // Allow per-entry TTLs and purge on get/peek
  ttl: 1,
  ttlAutopurge: false,
  allowStale: false,
});

/**
 * Returns the cached entry for `sessionId`, or `undefined` on a miss
 * (including transparent expiry eviction).
 */
export function l1Get(sessionId: string): L1CacheEntry | undefined {
  const entry = cache.get(sessionId);
  if (!entry) return undefined;
  // Double-check wall-clock expiry of the session itself (not just the LRU TTL).
  if (entry.valid && entry.expiresAt <= Date.now()) {
    cache.delete(sessionId);
    return undefined;
  }
  return entry;
}

/**
 * Stores a *valid* session entry.  `sessionExpiresAt` is the session's own
 * expiry (the cache TTL is computed from it, capped at 5 minutes so the
 * entry can be refreshed by heartbeats).
 */
export function l1Set(sessionId: string, userId: string, sessionExpiresAt: Date): void {
  const expiresAt = sessionExpiresAt.getTime();
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return; // already expired — don't cache

  const ttl = Math.min(remainingMs, 5 * 60 * 1000); // cap at 5 min

  cache.set(sessionId, { userId, expiresAt, valid: true }, { ttl });
}

/**
 * Writes a revocation tombstone so subsequent lookups for `sessionId`
 * immediately return "invalid" without network I/O for up to TOMBSTONE_TTL_MS.
 */
export function l1Revoke(sessionId: string): void {
  cache.set(
    sessionId,
    { userId: "", expiresAt: 0, valid: false },
    { ttl: TOMBSTONE_TTL_MS },
  );
}

/** Removes a single entry (used by tests or explicit cache busting). */
export function l1Delete(sessionId: string): void {
  cache.delete(sessionId);
}

/** Clears the entire cache (used by tests). */
export function l1Clear(): void {
  cache.clear();
}

/** Current number of live cache entries (includes tombstones). */
export function l1Size(): number {
  return cache.size;
}
