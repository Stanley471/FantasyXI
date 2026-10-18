import { randomUUID } from "node:crypto";
import { getRedisClient } from "../../config/redis.js";

/**
 * Storage for Idempotency-Key records (see middleware/idempotency.ts).
 *
 * A record is both the request's state machine and its distributed lock:
 *
 *   PENDING      claimed by one request (created atomically with SET NX)
 *   IN_PROGRESS  the handler is executing; the lock is extended while it runs
 *   COMPLETED    finished with a non-error response, cached for replay
 *   FAILED       finished with a deterministic client error, cached for replay
 *
 * Every write after the claim is a compare-and-set on the claim's random
 * fencing token (the same pattern as lockManager.ts's safe release), so a
 * request whose lock expired can never overwrite a newer owner's record.
 */

export type IdempotencyState = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface StoredResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface IdempotencyRecord {
  state: IdempotencyState;
  /** SHA-256 of method, path and body: a key may only be reused for an identical request */
  fingerprint: string;
  /** Fencing token of the request that owns the record */
  token: string;
  createdAt: number;
  updatedAt: number;
  response?: StoredResponse;
}

export type BeginResult =
  | { acquired: true; token: string }
  | { acquired: false; record: IdempotencyRecord };

export interface IdempotencyStore {
  /** Atomically claims `key` in PENDING state, or returns the existing record. */
  begin(key: string, fingerprint: string, lockTtlMs: number): Promise<BeginResult>;
  /** Moves an owned record to IN_PROGRESS and (re)sets its lock TTL; also used to extend the lock. */
  markInProgress(key: string, token: string, lockTtlMs: number): Promise<boolean>;
  /** Stores the final response for replay. */
  complete(
    key: string,
    token: string,
    state: "COMPLETED" | "FAILED",
    response: StoredResponse,
    ttlSeconds: number
  ): Promise<boolean>;
  /** Deletes an owned record so the request can be retried (transient failure). */
  release(key: string, token: string): Promise<boolean>;
}

function newRecord(fingerprint: string): IdempotencyRecord {
  const now = Date.now();
  return { state: "PENDING", fingerprint, token: randomUUID(), createdAt: now, updatedAt: now };
}

// ------------------------------------------------------------
// Redis
// ------------------------------------------------------------

/**
 * Compare-and-set on the record's token.
 * KEYS[1] = record key; ARGV[1] = expected token;
 * ARGV[2] = replacement JSON ("" deletes); ARGV[3] = TTL in milliseconds.
 */
export const IDEMPOTENCY_CAS_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or decoded["token"] ~= ARGV[1] then return 0 end
if ARGV[2] == "" then
  redis.call("DEL", KEYS[1])
else
  redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
end
return 1
`;

/** The subset of ioredis used by the store (injectable for tests). */
export interface IdempotencyRedisClient {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  status?: string;
  connect?(): Promise<unknown>;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private connecting: Promise<unknown> | null = null;

  constructor(private readonly client: IdempotencyRedisClient) {}

  /** The shared client is created with lazyConnect and no offline queue. */
  private async ensureConnected(): Promise<void> {
    if (this.client.status !== "wait" || !this.client.connect) return;
    this.connecting ??= this.client.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  public async begin(key: string, fingerprint: string, lockTtlMs: number): Promise<BeginResult> {
    await this.ensureConnected();
    // The existing record can expire between SET NX and GET; retry the claim
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = newRecord(fingerprint);
      const claimed = await this.client.set(key, JSON.stringify(record), "PX", lockTtlMs, "NX");
      if (claimed === "OK") return { acquired: true, token: record.token };

      const existing = await this.client.get(key);
      if (existing) return { acquired: false, record: JSON.parse(existing) as IdempotencyRecord };
    }
    throw new Error(`Could not claim idempotency key ${key}`);
  }

  public async markInProgress(key: string, token: string, lockTtlMs: number): Promise<boolean> {
    const existing = await this.client.get(key);
    if (!existing) return false;
    const record = JSON.parse(existing) as IdempotencyRecord;
    if (record.token !== token) return false;
    return this.cas(key, token, { ...record, state: "IN_PROGRESS", updatedAt: Date.now() }, lockTtlMs);
  }

  public async complete(
    key: string,
    token: string,
    state: "COMPLETED" | "FAILED",
    response: StoredResponse,
    ttlSeconds: number
  ): Promise<boolean> {
    const existing = await this.client.get(key);
    if (!existing) return false;
    const record = JSON.parse(existing) as IdempotencyRecord;
    if (record.token !== token) return false;
    return this.cas(key, token, { ...record, state, response, updatedAt: Date.now() }, ttlSeconds * 1000);
  }

  public async release(key: string, token: string): Promise<boolean> {
    const result = await this.client.eval(IDEMPOTENCY_CAS_SCRIPT, 1, key, token, "", 0);
    return Number(result) === 1;
  }

  private async cas(key: string, token: string, record: IdempotencyRecord, ttlMs: number): Promise<boolean> {
    const result = await this.client.eval(IDEMPOTENCY_CAS_SCRIPT, 1, key, token, JSON.stringify(record), ttlMs);
    return Number(result) === 1;
  }
}

// ------------------------------------------------------------
// In-memory (single instance; used when Redis is disabled and in tests)
// ------------------------------------------------------------

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  private read(key: string): IdempotencyRecord | null {
    const entry = this.records.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.records.delete(key);
      return null;
    }
    return entry.record;
  }

  private write(key: string, record: IdempotencyRecord, ttlMs: number): void {
    this.records.set(key, { record, expiresAt: Date.now() + ttlMs });
  }

  public async begin(key: string, fingerprint: string, lockTtlMs: number): Promise<BeginResult> {
    const existing = this.read(key);
    if (existing) return { acquired: false, record: { ...existing } };
    const record = newRecord(fingerprint);
    this.write(key, record, lockTtlMs);
    return { acquired: true, token: record.token };
  }

  public async markInProgress(key: string, token: string, lockTtlMs: number): Promise<boolean> {
    const existing = this.read(key);
    if (!existing || existing.token !== token) return false;
    this.write(key, { ...existing, state: "IN_PROGRESS", updatedAt: Date.now() }, lockTtlMs);
    return true;
  }

  public async complete(
    key: string,
    token: string,
    state: "COMPLETED" | "FAILED",
    response: StoredResponse,
    ttlSeconds: number
  ): Promise<boolean> {
    const existing = this.read(key);
    if (!existing || existing.token !== token) return false;
    this.write(key, { ...existing, state, response, updatedAt: Date.now() }, ttlSeconds * 1000);
    return true;
  }

  public async release(key: string, token: string): Promise<boolean> {
    const existing = this.read(key);
    if (!existing || existing.token !== token) return false;
    this.records.delete(key);
    return true;
  }
}

let defaultStore: IdempotencyStore | null = null;

/** Redis-backed when Redis is enabled, otherwise a per-process memory store. */
export function getDefaultIdempotencyStore(): IdempotencyStore {
  if (!defaultStore) {
    const client = getRedisClient();
    if (client) {
      defaultStore = new RedisIdempotencyStore(client as unknown as IdempotencyRedisClient);
    } else {
      console.warn("[idempotency] Redis disabled; Idempotency-Key records are kept in process memory");
      defaultStore = new MemoryIdempotencyStore();
    }
  }
  return defaultStore;
}
