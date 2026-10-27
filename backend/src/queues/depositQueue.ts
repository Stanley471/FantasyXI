/**
 * Soroban Contract Event Decoder & Deposit Confirmation Queue (Issue #403)
 *
 * Decodes Soroban XDR contract events (supporting both `xdr.ScVal` instances and
 * base64-encoded XDR strings) across FantasyXI escrow topics (`deposit`, `claimed`,
 * `m_claimed`, `refund`, `DepositRefunded`, `EmergencyRefund`, `LeagueRefundClaimed`,
 * `settle`, `m_settle`, `created`) and dispatches confirmed events to the
 * `depositQueue` with idempotency deduplication.
 */

import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { getRedisClient, type IRedisCacheClient } from "../config/redis.js";

export type EscrowNormalizedEventCategory =
  | "DEPOSIT"
  | "CLAIM"
  | "REFUND"
  | "SETTLE"
  | "CREATED"
  | "UNKNOWN";

export interface DecodedSorobanEscrowEvent {
  eventId: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId?: string;
  rawTopicName: string;
  category: EscrowNormalizedEventCategory;
  contractLeagueId: bigint;
  participant?: string;
  amountStroops?: bigint;
  amountUsdc?: number;
  totalPayoutStroops?: bigint;
  platformFeeStroops?: bigint;
  refundCount?: number;
  rawValue: unknown;
}

export interface DepositQueueJobPayload {
  idempotencyKey: string;
  eventId: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  rawTopicName: string;
  category: EscrowNormalizedEventCategory;
  contractLeagueId: string;
  participant?: string;
  amountStroops?: string;
  amountUsdc?: number;
  totalPayoutStroops?: string;
  platformFeeStroops?: string;
  refundCount?: number;
  enqueuedAt: string;
}

export type DepositQueueProcessor = (job: DepositQueueJobPayload) => Promise<void> | void;

/**
 * Converts either an `xdr.ScVal` object or a base64 XDR string into a native JS value.
 */
export function parseScValInput(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") {
    try {
      const scVal = xdr.ScVal.fromXDR(input, "base64");
      return scValToNative(scVal);
    } catch {
      return input;
    }
  }
  if (input instanceof xdr.ScVal || (typeof input === "object" && "switch" in (input as object))) {
    return scValToNative(input as xdr.ScVal);
  }
  return input;
}

/**
 * Maps a raw Soroban topic name to a normalized category.
 */
export function classifyEscrowTopic(topicName: string): EscrowNormalizedEventCategory {
  switch (topicName) {
    case "deposit":
    case "Deposit":
      return "DEPOSIT";
    case "claimed":
    case "m_claimed":
    case "claim":
    case "PrizeClaimed":
      return "CLAIM";
    case "refund":
    case "DepositRefunded":
    case "EmergencyRefund":
    case "LeagueRefundClaimed":
      return "REFUND";
    case "settle":
    case "m_settle":
      return "SETTLE";
    case "created":
      return "CREATED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Decodes a Soroban RPC event into a strongly-typed `DecodedSorobanEscrowEvent`.
 * Returns `null` if the event did not occur in a successful contract call or has
 * malformed topics.
 */
export function decodeSorobanEscrowEvent(event: {
  id?: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  inSuccessfulContractCall?: boolean;
  contractId?: string;
  topic: unknown[];
  value: unknown;
}): DecodedSorobanEscrowEvent | null {
  if (event.inSuccessfulContractCall === false) {
    return null;
  }
  if (!Array.isArray(event.topic) || event.topic.length < 2) {
    return null;
  }

  let rawTopicName: string;
  let contractLeagueId: bigint;
  let nativeValue: unknown;

  try {
    rawTopicName = String(parseScValInput(event.topic[0]));
    const parsedLeague = parseScValInput(event.topic[1]);
    contractLeagueId = BigInt(parsedLeague as string | number | bigint);
    nativeValue = parseScValInput(event.value);
  } catch {
    return null;
  }

  const category = classifyEscrowTopic(rawTopicName);
  const eventId = event.id ?? `${event.ledger}-${event.txHash}-${rawTopicName}`;

  const decoded: DecodedSorobanEscrowEvent = {
    eventId,
    txHash: event.txHash,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    rawTopicName,
    category,
    contractLeagueId,
    rawValue: nativeValue,
  };

  if (category === "DEPOSIT" || category === "CLAIM") {
    if (Array.isArray(nativeValue) && nativeValue.length >= 2) {
      decoded.participant = String(nativeValue[0]);
      const stroops = BigInt(nativeValue[1] as string | number | bigint);
      decoded.amountStroops = stroops;
      decoded.amountUsdc = Number(stroops) / 10_000_000;
    } else if (nativeValue && typeof nativeValue === "object") {
      const record = nativeValue as Record<string, unknown>;
      if (record.participant || record.winner) {
        decoded.participant = String(record.participant ?? record.winner);
      }
      if (record.amount !== undefined) {
        const stroops = BigInt(record.amount as string | number | bigint);
        decoded.amountStroops = stroops;
        decoded.amountUsdc = Number(stroops) / 10_000_000;
      }
    }
  } else if (category === "REFUND") {
    if (Array.isArray(nativeValue) && nativeValue.length >= 1) {
      if (typeof nativeValue[0] === "string") {
        decoded.participant = nativeValue[0];
        if (nativeValue.length >= 2) {
          const stroops = BigInt(nativeValue[1] as string | number | bigint);
          decoded.amountStroops = stroops;
          decoded.amountUsdc = Number(stroops) / 10_000_000;
        }
      } else {
        decoded.refundCount = Number(nativeValue[0]);
      }
    } else if (typeof nativeValue === "number" || typeof nativeValue === "bigint") {
      decoded.refundCount = Number(nativeValue);
    }
  } else if (category === "SETTLE") {
    if (Array.isArray(nativeValue) && nativeValue.length >= 2) {
      decoded.totalPayoutStroops = BigInt(nativeValue[0] as string | number | bigint);
      decoded.platformFeeStroops = BigInt(nativeValue[1] as string | number | bigint);
    }
  }

  return decoded;
}

export class DepositQueue {
  private readonly processedKeys = new Set<string>();
  private readonly jobs: DepositQueueJobPayload[] = [];
  private readonly processors: DepositQueueProcessor[] = [];
  private redis: IRedisCacheClient | null;
  private readonly idempotencyTtlMs: number;

  constructor(options: { redis?: IRedisCacheClient | null; idempotencyTtlMs?: number } = {}) {
    this.redis = options.redis !== undefined ? options.redis : getRedisClient();
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  public static buildIdempotencyKey(decoded: DecodedSorobanEscrowEvent): string {
    const participantPart = decoded.participant ? `:${decoded.participant}` : "";
    return `soroban:deposit-queue:${decoded.txHash}:${decoded.rawTopicName}:${decoded.contractLeagueId.toString()}${participantPart}`;
  }

  public registerProcessor(processor: DepositQueueProcessor): void {
    this.processors.push(processor);
  }

  public getJobs(): DepositQueueJobPayload[] {
    return [...this.jobs];
  }

  public clear(): void {
    this.processedKeys.clear();
    this.jobs.length = 0;
  }

  /**
   * Enqueues a decoded Soroban escrow event with idempotency deduplication.
   * Returns `{ enqueued: true, job }` on first sight or `{ enqueued: false, job: null }`
   * if the event has already been enqueued.
   */
  public async enqueue(
    decoded: DecodedSorobanEscrowEvent
  ): Promise<{ enqueued: boolean; job: DepositQueueJobPayload | null }> {
    const idempotencyKey = DepositQueue.buildIdempotencyKey(decoded);

    if (this.processedKeys.has(idempotencyKey)) {
      return { enqueued: false, job: null };
    }

    if (this.redis) {
      try {
        const existing = await this.redis.get(idempotencyKey);
        if (existing) {
          this.processedKeys.add(idempotencyKey);
          return { enqueued: false, job: null };
        }
        await this.redis.set(idempotencyKey, "1", "PX", this.idempotencyTtlMs);
      } catch {
        // Fallback to in-memory idempotency set if Redis is unreachable
      }
    }

    this.processedKeys.add(idempotencyKey);

    const job: DepositQueueJobPayload = {
      idempotencyKey,
      eventId: decoded.eventId,
      txHash: decoded.txHash,
      ledger: decoded.ledger,
      ledgerClosedAt: decoded.ledgerClosedAt,
      rawTopicName: decoded.rawTopicName,
      category: decoded.category,
      contractLeagueId: decoded.contractLeagueId.toString(),
      participant: decoded.participant,
      amountStroops: decoded.amountStroops?.toString(),
      amountUsdc: decoded.amountUsdc,
      totalPayoutStroops: decoded.totalPayoutStroops?.toString(),
      platformFeeStroops: decoded.platformFeeStroops?.toString(),
      refundCount: decoded.refundCount,
      enqueuedAt: new Date().toISOString(),
    };

    this.jobs.push(job);

    for (const processor of this.processors) {
      await processor(job);
    }

    return { enqueued: true, job };
  }
}

export const depositQueue = new DepositQueue();
