/**
 * Issue #439 — Redis Streams Session Sync (L2 backbone)
 *
 * Every node in the cluster publishes three event types onto the
 * `session:events` stream:
 *
 *   SESSION_CREATED  – a new session was registered (triggers L1 warm-up on
 *                      other nodes that happen to receive the event early).
 *   SESSION_HEARTBEAT – sliding-expiry update; extends the L1 TTL without a
 *                       DB write.
 *   SESSION_REVOKED  – instant cross-node revocation broadcast; consuming
 *                      nodes write an L1 tombstone within the target ≤50 ms.
 *
 * Each node runs a consumer-group reader (`XREADGROUP`) in a tight loop so
 * that only one node processes each message (useful when the fan-out is wired
 * to a singleton worker), or a plain `XREAD` fan-out if `consumerGroup` is
 * left undefined.  For cross-node revocation we use plain XREAD so *every*
 * node applies the tombstone.
 *
 * Stream trimming
 * ───────────────
 * We use `MAXLEN ~ 50000` on every XADD so the stream never grows unbounded.
 * A background job or Redis `EXPIRE` is not needed.
 *
 * Fault tolerance
 * ───────────────
 * • If Redis is unavailable the publish methods fail silently — the session
 *   registry still works, just without cross-node sync.
 * • The subscriber loop retries with a 2-second back-off on Redis errors.
 * • `start()` / `stop()` are idempotent.
 */

import type { Redis as RedisClient } from "ioredis";
import { getRedisClient } from "../../config/redis.js";
import { l1Revoke, l1Set } from "./sessionL1Cache.js";

// ─── Stream constants ────────────────────────────────────────────────────────

export const STREAM_KEY = "session:events";
const STREAM_MAXLEN = 50_000;
const BLOCK_MS = 2_000; // how long XREAD blocks before returning empty
const RETRY_DELAY_MS = 2_000;

// ─── Event types ─────────────────────────────────────────────────────────────

export type SessionEventType =
  | "SESSION_CREATED"
  | "SESSION_HEARTBEAT"
  | "SESSION_REVOKED";

export interface SessionStreamEvent {
  type: SessionEventType;
  sessionId: string;
  userId: string;
  /** Unix-ms expiry of the session */
  expiresAt: number;
  /** Wall-clock time the event was published */
  publishedAt: number;
}

// ─── Publisher ───────────────────────────────────────────────────────────────

/**
 * Publishes a session event to the Redis stream.  Never throws — a failed
 * publish is logged and silently swallowed so the caller's critical path
 * (login, auth check) is not affected.
 */
export async function publishSessionEvent(
  event: SessionStreamEvent,
  redis?: RedisClient | null,
): Promise<void> {
  const client = redis ?? getRedisClient();
  if (!client) return;

  try {
    await client.xadd(
      STREAM_KEY,
      "MAXLEN",
      "~",
      STREAM_MAXLEN,
      "*", // auto-ID
      "type",
      event.type,
      "sessionId",
      event.sessionId,
      "userId",
      event.userId,
      "expiresAt",
      String(event.expiresAt),
      "publishedAt",
      String(event.publishedAt),
    );
  } catch (err) {
    // Best-effort — cross-node sync failure must never break auth
    console.warn("[sessionStreamSync] Failed to publish event:", (err as Error).message);
  }
}

// ─── Subscriber / consumer loop ──────────────────────────────────────────────

interface SubscriberState {
  running: boolean;
  lastId: string;
  subscriber: RedisClient | null;
}

const state: SubscriberState = {
  running: false,
  lastId: "$", // only consume new messages after the subscriber starts
  subscriber: null,
};

/** Processes a single stream message field-array into a SessionStreamEvent. */
function parseStreamMessage(fields: string[]): SessionStreamEvent | null {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  if (!map.type || !map.sessionId || !map.userId || !map.expiresAt) return null;
  return {
    type: map.type as SessionEventType,
    sessionId: map.sessionId,
    userId: map.userId,
    expiresAt: Number(map.expiresAt),
    publishedAt: Number(map.publishedAt ?? 0),
  };
}

/**
 * Applies an inbound stream event to the local L1 cache.
 * This is the core of the ≤50 ms cross-node revocation guarantee: a
 * SESSION_REVOKED message writes an L1 tombstone synchronously.
 */
export function applySessionEvent(event: SessionStreamEvent): void {
  switch (event.type) {
    case "SESSION_REVOKED":
      l1Revoke(event.sessionId);
      break;

    case "SESSION_CREATED":
    case "SESSION_HEARTBEAT":
      l1Set(event.sessionId, event.userId, new Date(event.expiresAt));
      break;
  }
}

/**
 * Starts the background XREAD loop on a *dedicated* Redis connection.
 * Using a separate connection is important because XREAD with BLOCK holds the
 * connection open and would starve other callers on the shared singleton.
 *
 * Safe to call multiple times — only the first call starts the loop.
 */
export function startSessionStreamSubscriber(
  overrideRedis?: RedisClient | null,
): void {
  if (state.running) return;

  const primary = overrideRedis ?? getRedisClient();
  if (!primary) {
    console.warn("[sessionStreamSync] Redis unavailable — stream subscriber not started");
    return;
  }

  // Duplicate the connection so we don't block the shared client
  state.subscriber = primary.duplicate();
  state.running = true;

  void streamLoop();
}

/** Stops the background loop and closes the dedicated connection. */
export async function stopSessionStreamSubscriber(): Promise<void> {
  state.running = false;
  if (state.subscriber) {
    try {
      await state.subscriber.quit();
    } catch {
      state.subscriber.disconnect();
    }
    state.subscriber = null;
  }
  // Reset lastId so the next start() begins from "current"
  state.lastId = "$";
}

async function streamLoop(): Promise<void> {
  while (state.running) {
    const client = state.subscriber;
    if (!client) break;

    try {
      // XREAD COUNT 100 BLOCK 2000 STREAMS session:events <lastId>
      const results = (await client.xread(
        "COUNT",
        100,
        "BLOCK",
        BLOCK_MS,
        "STREAMS",
        STREAM_KEY,
        state.lastId,
      )) as Array<[string, Array<[string, string[]]>]> | null;

      if (!results) continue; // BLOCK timeout — no messages

      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          state.lastId = id;
          const event = parseStreamMessage(fields);
          if (event) applySessionEvent(event);
        }
      }
    } catch (err) {
      if (!state.running) break;
      console.warn(
        "[sessionStreamSync] Stream read error — retrying in",
        RETRY_DELAY_MS,
        "ms:",
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

/** Exposed for tests: returns a snapshot of the current subscriber state. */
export function getSubscriberState(): Readonly<SubscriberState> {
  return { ...state };
}
