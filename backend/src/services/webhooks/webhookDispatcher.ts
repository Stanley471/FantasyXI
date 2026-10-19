import { generateWebhookSignature } from "./webhookSigner.js";

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  leagueId?: string | null;
  userId: string;
  events: string[];
  isActive: boolean;
}

export type WebhookSubscription = WebhookEndpoint;

export class WebhookDuplicateSubscriptionError extends Error {
  public readonly statusCode = 409;
  constructor(message: string = "Webhook subscription already exists for this URL and event") {
    super(message);
    this.name = "WebhookDuplicateSubscriptionError";
  }
}

/**
 * Normalizes a webhook target URL:
 * - Trims whitespace
 * - Parses and validates URL format
 * - Lower-cases protocol and hostname
 * - Removes trailing slash(es)
 */
export function normalizeWebhookUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("Invalid URL provided");
  }
  const trimmed = rawUrl.trim();
  const parsed = new URL(trimmed);
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  let href = parsed.toString();
  return href.replace(/\/+(\?|#|$)/, "$1");
}

export interface WebhookSubscriptionCandidate {
  userId: string;
  url: string;
  events: string[];
  id?: string;
}

/**
 * Checks whether an active subscription already exists for the given user, URL, and event combination.
 * Excludes candidate id if specified (e.g. updating an existing subscription).
 */
export function findDuplicateWebhookSubscription(
  existingSubscriptions: Iterable<WebhookEndpoint>,
  candidateOrUserId: WebhookSubscriptionCandidate | string,
  url?: string,
  events?: string[],
  excludeEndpointId?: string
): { duplicate: boolean; conflictingEndpoint?: WebhookEndpoint; conflictingEvent?: string } {
  let candidate: WebhookSubscriptionCandidate;
  if (typeof candidateOrUserId === "string") {
    candidate = {
      userId: candidateOrUserId,
      url: url!,
      events: events || [],
      id: excludeEndpointId,
    };
  } else {
    candidate = candidateOrUserId;
  }

  let normalizedCandidateUrl: string;
  try {
    normalizedCandidateUrl = normalizeWebhookUrl(candidate.url);
  } catch {
    return { duplicate: false };
  }

  const candidateEvents = new Set(candidate.events);

  for (const existing of existingSubscriptions) {
    if (candidate.id && existing.id === candidate.id) {
      continue;
    }
    if (!existing.isActive) {
      continue;
    }
    if (existing.userId !== candidate.userId) {
      continue;
    }

    let normalizedExistingUrl: string;
    try {
      normalizedExistingUrl = normalizeWebhookUrl(existing.url);
    } catch {
      continue;
    }

    if (normalizedExistingUrl !== normalizedCandidateUrl) {
      continue;
    }

    for (const ev of existing.events) {
      if (candidateEvents.has(ev)) {
        return {
          duplicate: true,
          conflictingEndpoint: existing,
          conflictingEvent: ev,
        };
      }
    }
  }

  return { duplicate: false };
}

/**
 * Validates compound uniqueness for a webhook subscription (user + normalized URL + event).
 * Throws WebhookDuplicateSubscriptionError (409) if an active subscription already exists.
 */
export function validateWebhookUniqueness(
  existingSubscriptions: Iterable<WebhookEndpoint>,
  candidateOrUserId: WebhookSubscriptionCandidate | string,
  url?: string,
  events?: string[],
  excludeEndpointId?: string
): void {
  const result = findDuplicateWebhookSubscription(
    existingSubscriptions,
    candidateOrUserId,
    url,
    events,
    excludeEndpointId
  );
  if (result.duplicate) {
    throw new WebhookDuplicateSubscriptionError(
      "Webhook subscription already exists for this URL and event"
    );
  }
}

export const validateWebhookSubscriptionUniqueness = validateWebhookUniqueness;

export function isDuplicateWebhookSubscription(
  existingSubscriptions: Iterable<WebhookEndpoint>,
  candidateOrUserId: WebhookSubscriptionCandidate | string,
  url?: string,
  events?: string[],
  excludeEndpointId?: string
): boolean {
  return findDuplicateWebhookSubscription(
    existingSubscriptions,
    candidateOrUserId,
    url,
    events,
    excludeEndpointId
  ).duplicate;
}


export interface WebhookDeliveryRecord {
  id: string;
  endpointId: string;
  event: string;
  payload: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "DEAD_LETTER";
  attempts: number;
  maxAttempts: number;
  responseStatus?: number | null;
  responseBody?: string | null;
  error?: string | null;
  nextRetryAt?: Date | null;
  createdAt: Date;
  deliveredAt?: Date | null;
}

export interface DispatchOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  httpFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Calculates exponential backoff with full jitter to avoid thundering herd.
 */
export function calculateBackoffDelay(
  attempt: number,
  initialDelayMs: number = 1000,
  maxDelayMs: number = 60000,
  jitter: boolean = false
): number {
  const baseDelay = initialDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const cappedDelay = Math.min(baseDelay, maxDelayMs);
  if (!jitter) return cappedDelay;
  return Math.floor(Math.random() * cappedDelay);
}

export class WebhookDispatcher {
  private initialDelayMs: number;
  private maxDelayMs: number;
  private maxAttempts: number;
  private timeoutMs: number;
  private httpFetch: (url: string, init: RequestInit) => Promise<Response>;
  private inMemoryDeliveries: Map<string, WebhookDeliveryRecord> = new Map();

  constructor(options: DispatchOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.httpFetch = options.httpFetch ?? (globalThis.fetch as any);
  }

  /**
   * Attempts to dispatch an event to an endpoint with retry and backoff logic.
   */
  public async dispatch(
    endpoint: WebhookEndpoint,
    event: string,
    payload: Record<string, unknown>,
    deliveryId: string = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    currentAttempt: number = 1
  ): Promise<WebhookDeliveryRecord> {
    const payloadStr = JSON.stringify(payload);
    const { header } = generateWebhookSignature(payloadStr, endpoint.secret);

    const deliveryRecord: WebhookDeliveryRecord = {
      id: deliveryId,
      endpointId: endpoint.id,
      event,
      payload: payloadStr,
      status: "PENDING",
      attempts: currentAttempt,
      maxAttempts: this.maxAttempts,
      createdAt: new Date(),
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await this.httpFetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FantasyXI-Signature": header,
          "X-FantasyXI-Event": event,
          "X-FantasyXI-Delivery": deliveryId,
          "User-Agent": "FantasyXI-Webhook-Dispatcher/1.0",
        },
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timer);

      deliveryRecord.responseStatus = response.status;
      const text = await response.text().catch(() => "");
      deliveryRecord.responseBody = text.slice(0, 500);

      if (response.ok) {
        deliveryRecord.status = "SUCCESS";
        deliveryRecord.deliveredAt = new Date();
      } else {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }
    } catch (err: any) {
      deliveryRecord.error = err.message || "Dispatch error";

      if (currentAttempt >= this.maxAttempts) {
        deliveryRecord.status = "DEAD_LETTER";
        deliveryRecord.nextRetryAt = null;
      } else {
        deliveryRecord.status = "FAILED";
        const delay = calculateBackoffDelay(currentAttempt, this.initialDelayMs, this.maxDelayMs);
        deliveryRecord.nextRetryAt = new Date(Date.now() + delay);
      }
    }

    this.inMemoryDeliveries.set(deliveryId, deliveryRecord);
    return deliveryRecord;
  }

  public getDelivery(id: string): WebhookDeliveryRecord | undefined {
    return this.inMemoryDeliveries.get(id);
  }

  public listDeliveries(endpointId?: string): WebhookDeliveryRecord[] {
    const all = Array.from(this.inMemoryDeliveries.values());
    if (endpointId) {
      return all.filter((d) => d.endpointId === endpointId);
    }
    return all;
  }
}

export const webhookDispatcher = new WebhookDispatcher();
