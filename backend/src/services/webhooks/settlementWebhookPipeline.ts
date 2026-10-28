/**
 * Idempotent Webhook Dispatch Pipeline for League Settlement Confirmations
 *
 * Implements:
 * 1. Idempotency key generation & deduplication window ensuring duplicate settlement events
 *    generate exactly one webhook delivery per endpoint.
 * 2. Exponential backoff retry engine with jitter to eliminate thundering herd problems.
 * 3. Dead-letter queue (DLQ) isolation for exhausted retries with complete attempt history.
 * 4. Cryptographic HMAC SHA-256 signatures (`X-FantasyXI-Signature`) on all dispatched requests.
 * 5. Coordination with on-chain settlement records (`settlementKey`).
 *
 * Closes #338
 */

import crypto from "node:crypto";
import { generateWebhookSignature } from "./webhookSigner.js";
import { WebhookEndpoint } from "./webhookDispatcher.js";

export interface SettlementConfirmationPayload {
  leagueId: string;
  gameweekId: number;
  settlementKey?: string;
  payoutTxHash?: string;
  standingsHash?: string;
  totalPrizeDistributed?: string | number;
  timestamp: string;
  idempotencyKey?: string;
  [key: string]: unknown;
}

export interface DeliveryAttempt {
  attemptNumber: number;
  status: "SUCCESS" | "FAILED";
  statusCode?: number | null;
  latencyMs: number;
  error?: string | null;
  responseBody?: string | null;
  timestamp: Date;
}

export interface SettlementWebhookDelivery {
  id: string;
  endpointId: string;
  idempotencyKey: string;
  event: string;
  payload: SettlementConfirmationPayload;
  status: "PENDING" | "DELIVERED" | "FAILED" | "DEAD_LETTER";
  attemptCount: number;
  maxAttempts: number;
  attempts: DeliveryAttempt[];
  nextRetryAt: Date | null;
  createdAt: Date;
  deliveredAt?: Date | null;
  lastError?: string | null;
}

export interface SettlementPipelineOptions {
  dedupWindowMs?: number; // default 15 minutes (900_000ms)
  maxAttempts?: number; // default 5
  initialDelayMs?: number; // default 1000ms
  maxDelayMs?: number; // default 60_000ms
  jitter?: boolean; // default true
  timeoutMs?: number; // default 10_000ms
  httpFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Calculates exponential backoff with jitter to protect downstream receivers.
 */
export function calculateBackoffWithJitter(
  attempt: number,
  initialDelayMs = 1000,
  maxDelayMs = 60_000,
  jitter = true
): number {
  if (attempt <= 1) return 0;
  const base = initialDelayMs * Math.pow(2, attempt - 2);
  const capped = Math.min(base, maxDelayMs);
  if (!jitter) return capped;
  // Full jitter: uniformly distributed random delay between 0 and capped
  return Math.floor(Math.random() * capped);
}

/**
 * Generates a deterministic idempotency key for off-chain league settlement confirmations.
 */
export function generateSettlementIdempotencyKey(
  leagueId: string,
  gameweekId: number,
  settlementKey?: string
): string {
  const raw = `settlement:${leagueId}:${gameweekId}:${settlementKey || "final"}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export class SettlementWebhookPipeline {
  private readonly dedupWindowMs: number;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: boolean;
  private readonly timeoutMs: number;
  private readonly httpFetch: (url: string, init: RequestInit) => Promise<Response>;

  // Idempotency registry: Map<compositeKey, deliveryId>
  // compositeKey = `${endpointId}:${idempotencyKey}`
  private idempotencyRegistry: Map<string, { deliveryId: string; expiresAt: number }> = new Map();
  // Persistent in-memory delivery store
  private deliveries: Map<string, SettlementWebhookDelivery> = new Map();
  // Endpoints registry
  private endpoints: Map<string, WebhookEndpoint> = new Map();

  constructor(options: SettlementPipelineOptions = {}) {
    this.dedupWindowMs = options.dedupWindowMs ?? 15 * 60 * 1000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.jitter = options.jitter ?? true;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.httpFetch = options.httpFetch ?? (globalThis.fetch as any);
  }

  public registerEndpoint(endpoint: WebhookEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint);
  }

  public getEndpoint(id: string): WebhookEndpoint | undefined {
    return this.endpoints.get(id);
  }

  /**
   * Dispatches a settlement confirmation webhook with strict idempotency and deduplication.
   * If a duplicate event arrives within the deduplication window, returns existing delivery without resending.
   */
  public async dispatchSettlement(
    endpoint: WebhookEndpoint,
    payload: SettlementConfirmationPayload,
    event = "league.settled"
  ): Promise<SettlementWebhookDelivery> {
    this.registerEndpoint(endpoint);

    const idempotencyKey =
      payload.idempotencyKey ||
      generateSettlementIdempotencyKey(payload.leagueId, payload.gameweekId, payload.settlementKey);

    const compositeKey = `${endpoint.id}:${idempotencyKey}`;
    const now = Date.now();

    // Check deduplication window
    const existingEntry = this.idempotencyRegistry.get(compositeKey);
    if (existingEntry && existingEntry.expiresAt > now) {
      const existingDelivery = this.deliveries.get(existingEntry.deliveryId);
      if (existingDelivery) {
        return existingDelivery;
      }
    }

    const deliveryId = `del_settle_${now}_${crypto.randomBytes(4).toString("hex")}`;
    const fullPayload: SettlementConfirmationPayload = {
      ...payload,
      idempotencyKey,
    };

    const deliveryRecord: SettlementWebhookDelivery = {
      id: deliveryId,
      endpointId: endpoint.id,
      idempotencyKey,
      event,
      payload: fullPayload,
      status: "PENDING",
      attemptCount: 0,
      maxAttempts: this.maxAttempts,
      attempts: [],
      nextRetryAt: null,
      createdAt: new Date(),
    };

    this.deliveries.set(deliveryId, deliveryRecord);
    this.idempotencyRegistry.set(compositeKey, {
      deliveryId,
      expiresAt: now + this.dedupWindowMs,
    });

    return await this.executeAttempt(deliveryRecord, endpoint);
  }

  /**
   * Executes a single delivery attempt with HMAC signature and timeout protection.
   */
  public async executeAttempt(
    record: SettlementWebhookDelivery,
    endpoint: WebhookEndpoint
  ): Promise<SettlementWebhookDelivery> {
    record.attemptCount++;
    const attemptNumber = record.attemptCount;
    const payloadStr = JSON.stringify(record.payload);
    const { header: signatureHeader } = generateWebhookSignature(payloadStr, endpoint.secret);

    const startedAt = performance.now();
    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMsg: string | null = null;
    let isSuccess = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await this.httpFetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FantasyXI-Signature": signatureHeader,
          "X-FantasyXI-Event": record.event,
          "X-FantasyXI-Delivery": record.id,
          "X-FantasyXI-Attempt": String(attemptNumber),
          "X-FantasyXI-Idempotency-Key": record.idempotencyKey,
          "User-Agent": "FantasyXI-Settlement-Pipeline/1.0",
        },
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timer);
      responseStatus = response.status;
      const text = await response.text().catch(() => "");
      responseBody = text.slice(0, 500);

      if (response.ok) {
        isSuccess = true;
      } else {
        errorMsg = `HTTP Error: ${response.status} ${response.statusText}`;
      }
    } catch (err: any) {
      errorMsg = err.message || "Network / Dispatch error";
    }

    const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const attempt: DeliveryAttempt = {
      attemptNumber,
      status: isSuccess ? "SUCCESS" : "FAILED",
      statusCode: responseStatus,
      latencyMs,
      error: errorMsg,
      responseBody,
      timestamp: new Date(),
    };

    record.attempts.push(attempt);
    record.lastError = errorMsg;

    if (isSuccess) {
      record.status = "DELIVERED";
      record.deliveredAt = new Date();
      record.nextRetryAt = null;
    } else {
      if (attemptNumber >= record.maxAttempts) {
        record.status = "DEAD_LETTER";
        record.nextRetryAt = null;
      } else {
        record.status = "FAILED";
        const delayMs = calculateBackoffWithJitter(
          attemptNumber + 1,
          this.initialDelayMs,
          this.maxDelayMs,
          this.jitter
        );
        record.nextRetryAt = new Date(Date.now() + delayMs);
      }
    }

    this.deliveries.set(record.id, record);
    return record;
  }

  public getDelivery(id: string): SettlementWebhookDelivery | undefined {
    return this.deliveries.get(id);
  }

  public getDeadLetterQueue(endpointId?: string): SettlementWebhookDelivery[] {
    const dlq = Array.from(this.deliveries.values()).filter(
      (d) => d.status === "DEAD_LETTER"
    );
    if (endpointId) {
      return dlq.filter((d) => d.endpointId === endpointId);
    }
    return dlq;
  }

  /**
   * Replays a dead-lettered or failed delivery with fresh cryptographic signature while preserving
   * original settlement confirmation payload and idempotency key.
   */
  public async retryDelivery(deliveryId: string): Promise<SettlementWebhookDelivery> {
    const record = this.deliveries.get(deliveryId);
    if (!record) {
      throw new Error(`Settlement delivery record not found: ${deliveryId}`);
    }

    const endpoint = this.endpoints.get(record.endpointId);
    if (!endpoint) {
      throw new Error(`Endpoint not found: ${record.endpointId}`);
    }

    return await this.executeAttempt(record, endpoint);
  }

  public clearRegistry(): void {
    this.idempotencyRegistry.clear();
    this.deliveries.clear();
  }
}

export const settlementWebhookPipeline = new SettlementWebhookPipeline();
