import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  getDefaultIdempotencyStore,
  IdempotencyRecord,
  IdempotencyStore,
} from "../services/idempotency/idempotencyStore.js";

/**
 * Idempotency-Key middleware for financial and squad mutations.
 *
 * A client retrying a mutation (network retry, browser reload, double click)
 * sends the same `Idempotency-Key` header. For a given authenticated user and key:
 *
 * - The first request claims the key (PENDING -> IN_PROGRESS) and runs the handler.
 * - Concurrent duplicates are rejected with 409 while it runs, so the handler
 *   never executes twice.
 * - Once it finishes, duplicates receive the exact original status code and
 *   body (header `Idempotent-Replayed: true`) without re-executing anything.
 *   Responses are cached for `ttlSeconds` (24 hours by default).
 * - A transient failure (5xx, 408, 425, 429, or a dropped connection) releases
 *   the key so the client can safely retry.
 * - Reusing a key for a different request (method, path or body) returns 422.
 *
 * Requests without the header pass straight through unless `required` is set.
 * If the store is unreachable the request fails closed with 503: the client
 * asked for exactly-once semantics, and a retry with the same key is safe.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAY_HEADER = "Idempotent-Replayed";
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{1,255}$/;
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

export interface IdempotencyOptions {
  /** Store or a lazy factory (resolved on first use, so importing routes never opens Redis) */
  store?: IdempotencyStore | (() => IdempotencyStore);
  /** How long completed responses are replayed */
  ttlSeconds?: number;
  /** Lock lifetime while a request runs; refreshed every third of it */
  lockTtlMs?: number;
  /** Reject mutations without an Idempotency-Key header */
  required?: boolean;
  /** HTTP methods covered (read-only methods are never covered) */
  methods?: string[];
}

/** JSON with object keys sorted, so semantically identical bodies hash identically. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v ?? null)).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function requestFingerprint(req: Request): string {
  return createHash("sha256")
    .update(`${req.method} ${req.baseUrl}${req.path}\n${stableStringify(req.body)}`)
    .digest("hex");
}

export function isTransientStatus(statusCode: number): boolean {
  return statusCode >= 500 || TRANSIENT_STATUSES.has(statusCode);
}

function replay(res: Response, record: IdempotencyRecord): void {
  const stored = record.response!;
  for (const [name, value] of Object.entries(stored.headers)) {
    res.setHeader(name, value);
  }
  res.setHeader(IDEMPOTENT_REPLAY_HEADER, "true");
  res.status(stored.statusCode).send(stored.body);
}

export function createIdempotencyMiddleware(options: IdempotencyOptions = {}): RequestHandler {
  const ttlSeconds = options.ttlSeconds ?? 24 * 60 * 60;
  const lockTtlMs = options.lockTtlMs ?? 60_000;
  const methods = new Set((options.methods ?? ["POST", "PUT", "PATCH", "DELETE"]).map((m) => m.toUpperCase()));
  let resolved: IdempotencyStore | null = null;
  const getStore = (): IdempotencyStore => {
    if (!resolved) {
      const configured = options.store ?? getDefaultIdempotencyStore;
      resolved = typeof configured === "function" ? configured() : configured;
    }
    return resolved;
  };

  return async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!methods.has(req.method)) return next();

    const rawKey = req.get(IDEMPOTENCY_HEADER);
    if (rawKey === undefined) {
      if (options.required) {
        res.status(400).json({
          success: false,
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: `The ${IDEMPOTENCY_HEADER} header is required for this request`,
        });
        return;
      }
      return next();
    }
    if (!KEY_PATTERN.test(rawKey)) {
      res.status(400).json({
        success: false,
        code: "IDEMPOTENCY_KEY_INVALID",
        message: `${IDEMPOTENCY_HEADER} must be 1-255 characters of letters, digits, '-', '_', ':' or '.'`,
      });
      return;
    }

    // Keys are scoped per user: two users can never collide or read each other's responses
    const storageKey = `idempotency:${req.user?.id ?? "anonymous"}:${rawKey}`;
    const fingerprint = requestFingerprint(req);
    const store = getStore();

    const unavailable = (error: unknown) => {
      console.error("[idempotency] Store unavailable for %s: %s", storageKey, (error as Error).message);
      res.status(503).json({
        success: false,
        code: "IDEMPOTENCY_UNAVAILABLE",
        message: "Idempotency service unavailable; retry the request with the same key",
      });
    };

    let token: string;
    try {
      const begin = await store.begin(storageKey, fingerprint, lockTtlMs);
      if (!begin.acquired) {
        const { record } = begin;
        if (record.fingerprint !== fingerprint) {
          res.status(422).json({
            success: false,
            code: "IDEMPOTENCY_KEY_REUSED",
            message: `This ${IDEMPOTENCY_HEADER} was already used for a different request`,
          });
        } else if ((record.state === "COMPLETED" || record.state === "FAILED") && record.response) {
          replay(res, record);
        } else {
          res.setHeader("Retry-After", "1");
          res.status(409).json({
            success: false,
            code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            message: "A request with this Idempotency-Key is already being processed",
          });
        }
        return;
      }
      token = begin.token;

      if (!(await store.markInProgress(storageKey, token, lockTtlMs))) {
        throw new Error("Lost the idempotency lock before the request started");
      }
    } catch (error) {
      unavailable(error);
      return;
    }

    // Keep the lock alive while a slow handler runs (Redlock-style extension)
    const heartbeat = setInterval(() => {
      store.markInProgress(storageKey, token, lockTtlMs).catch((error) => {
        console.warn("[idempotency] Failed to extend lock %s: %s", storageKey, (error as Error).message);
      });
    }, Math.max(Math.floor(lockTtlMs / 3), 100));
    heartbeat.unref();

    // Capture the serialized body (res.json delegates to res.send with a string)
    let capturedBody = "";
    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (typeof body === "string") capturedBody = body;
      else if (Buffer.isBuffer(body)) capturedBody = body.toString("utf8");
      return originalSend(body as never);
    }) as Response["send"];

    let settled = false;
    const settle = async (finished: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      try {
        if (!finished || isTransientStatus(res.statusCode)) {
          await store.release(storageKey, token);
          return;
        }
        const contentType = res.getHeader("Content-Type");
        const saved = await store.complete(
          storageKey,
          token,
          res.statusCode < 400 ? "COMPLETED" : "FAILED",
          {
            statusCode: res.statusCode,
            headers: contentType ? { "Content-Type": String(contentType) } : {},
            body: capturedBody,
          },
          ttlSeconds
        );
        if (!saved) {
          console.warn("[idempotency] Lock for %s expired before the response was stored", storageKey);
        }
      } catch (error) {
        console.error("[idempotency] Failed to settle %s: %s", storageKey, (error as Error).message);
      }
    };

    res.once("finish", () => void settle(true));
    res.once("close", () => void settle(res.writableFinished));
    next();
  };
}

/** Shared middleware for financial and squad mutation routes. */
export const idempotency = createIdempotencyMiddleware();
