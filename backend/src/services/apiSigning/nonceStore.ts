import { createHash } from "node:crypto";
import { getRedisClient, type IRedisCacheClient } from "../../config/redis.js";
import { API_SIGNING_TOLERANCE_SECONDS } from "./requestSigner.js";

/**
 * Consumed-nonce store for API request signing (issue #455).
 *
 * A nonce must be accepted exactly once while its timestamp is still inside
 * the clock-skew window, so `consume` is atomic: Redis `SET NX EX` claims
 * the nonce in one command, and the in-memory store claims it under a single
 * synchronous check-and-set (Node runs it without interleaving).
 *
 * Which store is used:
 * - Redis (`RedisApiNonceStore`) when the shared Redis client from
 *   `config/redis.ts` is available. If a Redis command fails, the store falls
 *   back to process memory for that call rather than letting a replay
 *   through or failing the request — the failure is logged once.
 * - Process memory (`MemoryApiNonceStore`) when Redis is disabled
 *   (`REDIS_ENABLED=false`) or absent. This is documented as single-instance
 *   replay defense only: with several API instances behind a load balancer,
 *   a replay could land on a different instance and pass. Run Redis in
 *   production.
 *
 * Tests inject `MemoryApiNonceStore` (or a fake Redis client) directly, so
 * they never need a live Redis.
 */

export interface ApiNonceStore {
  /**
   * Atomically consumes `nonce` for `ttlSeconds`. Returns true when the nonce
   * is fresh (now consumed), false when it was already seen.
   */
  consume(nonce: string, ttlSeconds?: number): Promise<boolean>;
}

function nonceKey(nonce: string): string {
  // Hash the nonce so Redis keys stay bounded and never carry raw client input.
  const digest = createHash("sha256").update(nonce).digest("hex");
  return `fantasyxi:api-signing:nonce:${digest}`;
}

export class RedisApiNonceStore implements ApiNonceStore {
  private readonly fallback = new MemoryApiNonceStore();
  private fallbackLogged = false;

  constructor(private readonly redis: IRedisCacheClient) {}

  public async consume(nonce: string, ttlSeconds: number = API_SIGNING_TOLERANCE_SECONDS): Promise<boolean> {
    try {
      const result = await this.redis.set(nonceKey(nonce), "1", "EX", ttlSeconds, "NX");
      // ioredis returns "OK" when the key was set, null when it already existed.
      return result === "OK" || result === true || result === 1;
    } catch (error) {
      if (!this.fallbackLogged) {
        console.error(
          "[api-signing] Redis nonce store failed; falling back to process memory",
          error
        );
        this.fallbackLogged = true;
      }
      return this.fallback.consume(nonce, ttlSeconds);
    }
  }
}

interface MemoryNonceEntry {
  expiresAt: number;
}

export class MemoryApiNonceStore implements ApiNonceStore {
  private readonly nonces = new Map<string, MemoryNonceEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000
  ) {}

  public async consume(nonce: string, ttlSeconds: number = API_SIGNING_TOLERANCE_SECONDS): Promise<boolean> {
    const now = this.now();
    const existing = this.nonces.get(nonce);
    if (existing && existing.expiresAt > now) return false; // Replay detected
    if (existing) this.nonces.delete(nonce);
    this.nonces.set(nonce, { expiresAt: now + ttlSeconds * 1000 });
    this.evictIfNeeded(now);
    return true;
  }

  /** Test/support helper: how many unexpired nonces are currently held. */
  public size(): number {
    const now = this.now();
    for (const [nonce, entry] of this.nonces.entries()) {
      if (entry.expiresAt <= now) this.nonces.delete(nonce);
    }
    return this.nonces.size;
  }

  public clear(): void {
    this.nonces.clear();
  }

  private evictIfNeeded(now: number): void {
    if (this.nonces.size <= this.maxKeys) return;
    for (const [nonce, entry] of this.nonces.entries()) {
      if (entry.expiresAt <= now) this.nonces.delete(nonce);
      if (this.nonces.size <= this.maxKeys) return;
    }
    // No expired entries to drop: evict the oldest inserted keys.
    for (const nonce of this.nonces.keys()) {
      this.nonces.delete(nonce);
      if (this.nonces.size <= this.maxKeys) return;
    }
  }
}

let defaultStore: ApiNonceStore | null = null;
let redisDisabledLogged = false;

/**
 * Redis-backed when the shared Redis client exists, otherwise a per-process
 * memory store. Resolved lazily (never at import time) so importing routes
 * never opens a Redis connection.
 */
export function getDefaultApiNonceStore(): ApiNonceStore {
  if (!defaultStore) {
    const client = getRedisClient();
    if (client) {
      defaultStore = new RedisApiNonceStore(client as unknown as IRedisCacheClient);
    } else {
      if (!redisDisabledLogged) {
        console.warn(
          "[api-signing] Redis disabled; consumed nonces are kept in process memory (single-instance replay defense only)"
        );
        redisDisabledLogged = true;
      }
      defaultStore = new MemoryApiNonceStore();
    }
  }
  return defaultStore;
}
