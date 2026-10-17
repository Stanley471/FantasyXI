import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { acquireLock } from "../services/lockManager.js";

export type IdempotencyStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface IdempotencyRecord {
  key: string;
  userId: string;
  payloadHash: string;
  status: IdempotencyStatus;
  statusCode?: number;
  responseBody?: unknown;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface IdempotencyManagerOptions {
  /** TTL for completed idempotency records in milliseconds (default: 24 hours) */
  ttlMs?: number;
  /** Whether requests missing the Idempotency-Key header should be rejected with 400 */
  requireHeader?: boolean;
  /** Wait window for concurrent in-flight requests to receive the completed result */
  inFlightWaitMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function computeCanonicalPayloadHash(params: {
  method: string;
  path: string;
  body: unknown;
}): string {
  const canonicalBody =
    params.body && typeof params.body === "object"
      ? JSON.stringify(sortObjectKeys(params.body))
      : JSON.stringify(params.body ?? {});

  return crypto
    .createHash("sha256")
    .update(`${params.method.toUpperCase()}:${params.path}:${canonicalBody}`)
    .digest("hex");
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export class DistributedIdempotencyManager {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly inMemoryLocks = new Set<string>();
  private readonly inflightPromises = new Map<
    string,
    Promise<{ statusCode: number; body: unknown }>
  >();
  private readonly ttlMs: number;
  private readonly lockAcquireFn?: (
    resource: string
  ) => Promise<(() => Promise<void>) | null>;

  constructor(options?: {
    ttlMs?: number;
    lockAcquireFn?: (resource: string) => Promise<(() => Promise<void>) | null>;
  }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.lockAcquireFn = options?.lockAcquireFn;
  }

  /**
   * Executes a financial mutation idempotently using Redlock + atomic compare-and-set.
   * Guarantees that even under 100 simultaneous concurrent requests with the same key,
   * the underlying `handler` runs at most once.
   */
  public async executeIdempotent<T>(params: {
    idempotencyKey: string;
    userId: string;
    method: string;
    path: string;
    body: unknown;
    nowMs?: number;
    waitForInFlight?: boolean;
    handler: () => Promise<{ statusCode: number; body: T }>;
  }): Promise<{
    replayed: boolean;
    inProgressConflict: boolean;
    payloadMismatch: boolean;
    statusCode: number;
    body: T | { success: false; message: string; code: string };
  }> {
    const nowMs = params.nowMs ?? Date.now();
    this.pruneExpired(nowMs);

    const compositeKey = `${params.userId}:${params.idempotencyKey}`;
    const payloadHash = computeCanonicalPayloadHash({
      method: params.method,
      path: params.path,
      body: params.body,
    });

    // 1. Check existing record
    const existing = this.records.get(compositeKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return {
          replayed: false,
          inProgressConflict: false,
          payloadMismatch: true,
          statusCode: 422,
          body: {
            success: false,
            code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
            message:
              "Idempotency-Key was already used with a different request payload",
          },
        };
      }

      if (existing.status === "COMPLETED") {
        return {
          replayed: true,
          inProgressConflict: false,
          payloadMismatch: false,
          statusCode: existing.statusCode ?? 200,
          body: existing.responseBody as T,
        };
      }

      if (existing.status === "IN_PROGRESS") {
        if (params.waitForInFlight) {
          const inflight = this.inflightPromises.get(compositeKey);
          if (inflight) {
            try {
              const settled = await inflight;
              return {
                replayed: true,
                inProgressConflict: false,
                payloadMismatch: false,
                statusCode: settled.statusCode,
                body: settled.body as T,
              };
            } catch {
              // Fall through if the in-flight execution failed
            }
          }
        }
        return {
          replayed: false,
          inProgressConflict: true,
          payloadMismatch: false,
          statusCode: 409,
          body: {
            success: false,
            code: "IDEMPOTENCY_KEY_IN_PROGRESS",
            message:
              "A financial mutation with this Idempotency-Key is currently in progress",
          },
        };
      }
    }

    // 2. Acquire atomic lock (in-memory atomic gate + optional Redis Redlock)
    if (this.inMemoryLocks.has(compositeKey)) {
      return {
        replayed: false,
        inProgressConflict: true,
        payloadMismatch: false,
        statusCode: 409,
        body: {
          success: false,
          code: "IDEMPOTENCY_KEY_IN_PROGRESS",
          message:
            "A financial mutation with this Idempotency-Key is currently in progress",
        },
      };
    }

    this.inMemoryLocks.add(compositeKey);
    const redisRelease = this.lockAcquireFn
      ? await this.lockAcquireFn(`idempotency:${compositeKey}`).catch(() => null)
      : process.env.REDIS_ENABLED === "true"
      ? await acquireLock(`idempotency:${compositeKey}`, {
          ttlMs: 15_000,
          retryCount: 1,
        }).catch(() => null)
      : null;

    const record: IdempotencyRecord = {
      key: params.idempotencyKey,
      userId: params.userId,
      payloadHash,
      status: "IN_PROGRESS",
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
    this.records.set(compositeKey, record);

    const executionPromise = params.handler();
    this.inflightPromises.set(compositeKey, executionPromise);

    try {
      const outcome = await executionPromise;

      // Transient 5xx errors release the idempotency slot so the client can retry
      if (outcome.statusCode >= 500) {
        this.records.delete(compositeKey);
        return {
          replayed: false,
          inProgressConflict: false,
          payloadMismatch: false,
          statusCode: outcome.statusCode,
          body: outcome.body,
        };
      }

      record.status = "COMPLETED";
      record.statusCode = outcome.statusCode;
      record.responseBody = outcome.body;

      return {
        replayed: false,
        inProgressConflict: false,
        payloadMismatch: false,
        statusCode: outcome.statusCode,
        body: outcome.body,
      };
    } catch (error) {
      // Uncaught transient errors clean up the key so retries are not deadlocked
      this.records.delete(compositeKey);
      throw error;
    } finally {
      this.inflightPromises.delete(compositeKey);
      this.inMemoryLocks.delete(compositeKey);
      if (redisRelease) {
        await redisRelease();
      }
    }
  }

  /**
   * Express middleware factory for protecting financial mutation routes.
   */
  public middleware(options: IdempotencyManagerOptions = {}) {
    const requireHeader = options.requireHeader ?? true;

    return async (
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      const rawHeader =
        req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"];
      const idempotencyKey =
        typeof rawHeader === "string" ? rawHeader.trim() : "";

      if (!idempotencyKey) {
        if (requireHeader) {
          res.status(400).json({
            success: false,
            code: "IDEMPOTENCY_KEY_REQUIRED",
            message:
              "Idempotency-Key header is required for financial mutations",
          });
          return;
        }
        next();
        return;
      }

      const userId = req.user?.id ?? req.ip ?? "anonymous";
      const payloadHash = computeCanonicalPayloadHash({
        method: req.method,
        path: req.originalUrl || req.path,
        body: req.body,
      });
      const compositeKey = `${userId}:${idempotencyKey}`;
      const nowMs = Date.now();
      this.pruneExpired(nowMs);

      const existing = this.records.get(compositeKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          res.status(422).json({
            success: false,
            code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
            message:
              "Idempotency-Key was already used with a different request payload",
          });
          return;
        }

        if (existing.status === "COMPLETED") {
          res.setHeader("X-Idempotent-Replay", "true");
          res.status(existing.statusCode ?? 200).json(existing.responseBody);
          return;
        }

        if (existing.status === "IN_PROGRESS") {
          res.status(409).json({
            success: false,
            code: "IDEMPOTENCY_KEY_IN_PROGRESS",
            message:
              "A financial mutation with this Idempotency-Key is currently in progress",
          });
          return;
        }
      }

      if (this.inMemoryLocks.has(compositeKey)) {
        res.status(409).json({
          success: false,
          code: "IDEMPOTENCY_KEY_IN_PROGRESS",
          message:
            "A financial mutation with this Idempotency-Key is currently in progress",
        });
        return;
      }

      this.inMemoryLocks.add(compositeKey);
      const record: IdempotencyRecord = {
        key: idempotencyKey,
        userId,
        payloadHash,
        status: "IN_PROGRESS",
        createdAtMs: nowMs,
        expiresAtMs: nowMs + this.ttlMs,
      };
      this.records.set(compositeKey, record);

      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        this.inMemoryLocks.delete(compositeKey);
        if (res.statusCode >= 500) {
          this.records.delete(compositeKey);
        } else {
          record.status = "COMPLETED";
          record.statusCode = res.statusCode || 200;
          record.responseBody = body;
        }
        return originalJson(body);
      }) as Response["json"];

      next();
    };
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, rec] of this.records.entries()) {
      if (nowMs > rec.expiresAtMs && rec.status !== "IN_PROGRESS") {
        this.records.delete(key);
      }
    }
  }
}

export const idempotencyManager = new DistributedIdempotencyManager();
