import { Address, rpc as SorobanRpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { prisma } from "../../config/db.js";
import { getSorobanServer, stellarConfig } from "../../config/stellar.js";

/**
 * Supported Soroban contract event topic names for the FantasyXI escrow contract.
 */
export const SUPPORTED_SOROBAN_EVENT_TOPICS = [
  "LeagueDeposit",
  "Settlement",
  "Refund",
  "FeeWithdrawal",
  "deposit",
  "settle",
  "refund",
  "claimed",
  "created",
] as const;

export type CanonicalSorobanEventType =
  | "LeagueDeposit"
  | "Settlement"
  | "Refund"
  | "FeeWithdrawal"
  | "LeagueClaimed"
  | "LeagueCreated";

const TOPIC_TO_CANONICAL_EVENT: Record<string, CanonicalSorobanEventType> = {
  LeagueDeposit: "LeagueDeposit",
  deposit: "LeagueDeposit",
  Settlement: "Settlement",
  settle: "Settlement",
  Refund: "Refund",
  refund: "Refund",
  FeeWithdrawal: "FeeWithdrawal",
  fee_withdrawal: "FeeWithdrawal",
  claimed: "LeagueClaimed",
  created: "LeagueCreated",
};

export interface RawSorobanRpcEvent {
  id: string;
  pagingToken?: string;
  type?: string;
  ledger: number | string;
  ledgerClosedAt?: string;
  contractId?: string | { contractId?: () => string; toString?: () => string };
  txHash?: string;
  transactionHash?: string;
  topic: Array<xdr.ScVal | string>;
  value: xdr.ScVal | string | { value?: () => xdr.ScVal };
}

export interface DecodedSorobanContractEvent {
  eventId: string;
  pagingToken: string;
  contractId: string | null;
  eventType: CanonicalSorobanEventType;
  topics: unknown[];
  leagueId: string | null;
  txHash: string;
  ledgerSeq: number;
  timestamp: Date;
  payload: Record<string, unknown>;
}

export interface SorobanIngestionPollResult {
  polled: number;
  ingested: number;
  duplicatesSkipped: number;
  lastLedgerSeq: number;
  cursor: string | null;
}

export interface SorobanEventIngestionOptions {
  contractId?: string;
  cursorId?: string;
  batchSize?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  pollIntervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_CURSOR_ID = "soroban_event_ingestion_daemon";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 6_000;

/**
 * Recursively converts any BigInt or nested value into a JSON-safe structure
 * suitable for PostgreSQL Json columns.
 */
export function toJsonSafeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafeValue(item));
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      out[String(toJsonSafeValue(k))] = toJsonSafeValue(v);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafeValue(v);
    }
    return out;
  }
  return String(value);
}

/**
 * Parses an ScVal instance or base64 XDR string into an xdr.ScVal object.
 */
export function parseScValInput(input: xdr.ScVal | string | { value?: () => xdr.ScVal }): xdr.ScVal {
  if (typeof input === "string") {
    return xdr.ScVal.fromXDR(input, "base64");
  }
  if (input && typeof (input as any).toXDR === "function") {
    return input as xdr.ScVal;
  }
  if (input && typeof (input as any).switch === "function") {
    return input as xdr.ScVal;
  }
  if (input && typeof (input as any).value === "function") {
    const inner = (input as any).value();
    if (inner && (typeof inner.toXDR === "function" || typeof inner.switch === "function")) {
      return inner as xdr.ScVal;
    }
  }
  throw new Error("Unsupported ScVal input format");
}

/**
 * Decodes an xdr.ScVal (or base64 XDR string) into a human-readable JSON-safe representation.
 * Uses scValToNative as primary decoder with fallback manual switch decoding for complex types.
 */
export function decodeScValToJson(input: xdr.ScVal | string | { value?: () => xdr.ScVal }): unknown {
  const scVal = parseScValInput(input);

  try {
    const native = scValToNative(scVal);
    return toJsonSafeValue(native);
  } catch {
    return decodeScValFallback(scVal);
  }
}

function decodeScValFallback(scValObj: xdr.ScVal): unknown {
  const scVal: any = scValObj;
  const arm = scVal.switch().name;
  switch (arm) {
    case "scvVoid":
      return null;
    case "scvBool":
      return scVal.b();
    case "scvU32":
      return scVal.u32();
    case "scvI32":
      return scVal.i32();
    case "scvU64":
      return BigInt(scVal.u64().toString()).toString();
    case "scvI64":
      return BigInt(scVal.i64().toString()).toString();
    case "scvTimepoint":
      return BigInt(scVal.timepoint().toString()).toString();
    case "scvDuration":
      return BigInt(scVal.duration().toString()).toString();
    case "scvU128": {
      const parts = scVal.u128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      return ((hi << 64n) | lo).toString();
    }
    case "scvI128": {
      const parts = scVal.i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      return ((hi << 64n) | (lo & ((1n << 64n) - 1n))).toString();
    }
    case "scvSymbol":
      return scVal.sym().toString();
    case "scvString":
      return scVal.str().toString();
    case "scvBytes":
      return Buffer.from(scVal.bytes()).toString("hex");
    case "scvAddress":
      try {
        return Address.fromScVal(scVal).toString();
      } catch {
        return scVal.toXDR("base64");
      }
    case "scvVec": {
      const vec = scVal.vec() ?? [];
      return vec.map((item: any) => decodeScValToJson(item));
    }
    case "scvMap": {
      const entries = scVal.map() ?? [];
      const result: Record<string, unknown> = {};
      for (const entry of entries) {
        const key = String(decodeScValToJson(entry.key()));
        result[key] = decodeScValToJson(entry.val());
      }
      return result;
    }
    default:
      return scVal.toXDR("base64");
  }
}

/**
 * Soroban Event Ingestion Daemon Service.
 *
 * Polls Soroban RPC `getEvents`, decodes XDR contract topics and `ScVal` data maps
 * into structured human-readable JSON payloads, persists them in PostgreSQL, and
 * maintains a durable ledger checkpoint cursor with exponential backoff on RPC rate limits.
 */
export class SorobanEventIngestionService {
  private readonly db: any;
  private readonly rpcServer: { getEvents(req: any): Promise<any>; getLatestLedger(): Promise<{ sequence: number }> };
  private readonly contractId: string;
  private readonly cursorId: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  constructor(
    db: any = prisma,
    rpcServer?: { getEvents(req: any): Promise<any>; getLatestLedger(): Promise<{ sequence: number }> },
    options: SorobanEventIngestionOptions = {}
  ) {
    this.db = db;
    this.rpcServer = rpcServer ?? getSorobanServer();
    this.contractId = (options.contractId ?? stellarConfig.contractId ?? "").trim();
    this.cursorId = options.cursorId ?? DEFAULT_CURSOR_ID;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleepFn =
      options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Decodes a raw Soroban RPC event into a structured record if it matches
   * a supported FantasyXI contract event topic.
   */
  public decodeEvent(rawEvent: RawSorobanRpcEvent): DecodedSorobanContractEvent | null {
    if (!rawEvent || !Array.isArray(rawEvent.topic) || rawEvent.topic.length === 0) {
      return null;
    }

    const decodedTopics = rawEvent.topic.map((t) => decodeScValToJson(t));
    const primaryTopic = String(decodedTopics[0] ?? "").trim();
    const canonicalType = TOPIC_TO_CANONICAL_EVENT[primaryTopic];
    if (!canonicalType) {
      return null;
    }

    const decodedValue = decodeScValToJson(rawEvent.value);
    const leagueIdFromTopic =
      decodedTopics.length > 1 && decodedTopics[1] !== null && decodedTopics[1] !== undefined
        ? String(decodedTopics[1])
        : null;

    let payloadObj: Record<string, unknown>;
    if (decodedValue && typeof decodedValue === "object" && !Array.isArray(decodedValue)) {
      payloadObj = { ...(decodedValue as Record<string, unknown>) };
    } else {
      payloadObj = { value: decodedValue };
    }

    const leagueId =
      leagueIdFromTopic ??
      (payloadObj.leagueId !== undefined && payloadObj.leagueId !== null
        ? String(payloadObj.leagueId)
        : payloadObj.league_id !== undefined && payloadObj.league_id !== null
        ? String(payloadObj.league_id)
        : null);

    let contractId: string | null = null;
    if (typeof rawEvent.contractId === "string") {
      contractId = rawEvent.contractId;
    } else if (rawEvent.contractId && typeof rawEvent.contractId === "object") {
      if (typeof rawEvent.contractId.contractId === "function") {
        contractId = rawEvent.contractId.contractId();
      } else if (typeof rawEvent.contractId.toString === "function") {
        contractId = rawEvent.contractId.toString();
      }
    }
    if (!contractId && this.contractId) {
      contractId = this.contractId;
    }

    const ledgerSeq =
      typeof rawEvent.ledger === "number"
        ? rawEvent.ledger
        : parseInt(String(rawEvent.ledger), 10) || 0;

    const txHash = String(rawEvent.txHash ?? rawEvent.transactionHash ?? "").trim();
    const timestamp = rawEvent.ledgerClosedAt ? new Date(rawEvent.ledgerClosedAt) : new Date();
    const pagingToken = String(rawEvent.pagingToken ?? rawEvent.id ?? `${ledgerSeq}-${txHash}`);

    return {
      eventId: String(rawEvent.id ?? pagingToken),
      pagingToken,
      contractId,
      eventType: canonicalType,
      topics: decodedTopics,
      leagueId,
      txHash,
      ledgerSeq,
      timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
      payload: {
        topic: primaryTopic,
        topics: decodedTopics,
        data: decodedValue,
        ...payloadObj,
      },
    };
  }

  /**
   * Determines whether an error returned by Soroban RPC is a rate-limit or transient error.
   */
  public static isRateLimitOrTransientError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const anyErr = err as Record<string, any>;
    const status = anyErr.status ?? anyErr.statusCode ?? anyErr.response?.status ?? anyErr.code;
    if (status === 429 || status === 503 || status === 502 || status === 504) {
      return true;
    }
    const msg = String(anyErr.message ?? "").toLowerCase();
    return (
      msg.includes("rate limit") ||
      msg.includes("ratelimit") ||
      msg.includes("429") ||
      msg.includes("too many requests") ||
      msg.includes("temporarily unavailable")
    );
  }

  /**
   * Executes an RPC request with exponential backoff on rate limits (HTTP 429).
   */
  public async callWithBackoff<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (err) {
        if (attempt >= this.maxRetries || !SorobanEventIngestionService.isRateLimitOrTransientError(err)) {
          throw err;
        }
        const delayMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, attempt));
        attempt += 1;
        await this.sleepFn(delayMs);
      }
    }
  }

  /**
   * Loads the saved checkpoint from PostgreSQL (`IndexerCursor` or latest `SorobanContractEvent`),
   * ensuring seamless daemon restarts without missing ledger sequence gaps.
   */
  public async loadCheckpoint(): Promise<{ lastLedger: number; cursor: string | null }> {
    if (this.db.indexerCursor?.findUnique) {
      const saved = await this.db.indexerCursor.findUnique({
        where: { id: this.cursorId },
      });
      if (saved && typeof saved.lastLedger === "number" && saved.lastLedger > 0) {
        return {
          lastLedger: saved.lastLedger,
          cursor: saved.cursor ?? null,
        };
      }
    }

    if (this.db.sorobanContractEvent?.findFirst) {
      const latestEvent = await this.db.sorobanContractEvent.findFirst({
        orderBy: { ledgerSeq: "desc" },
      });
      if (latestEvent && typeof latestEvent.ledgerSeq === "number") {
        return {
          lastLedger: latestEvent.ledgerSeq,
          cursor: latestEvent.pagingToken ?? null,
        };
      }
    }

    if (this.db.contractEvent?.findFirst) {
      const latestContractEvent = await this.db.contractEvent.findFirst({
        orderBy: { ledgerSeq: "desc" },
      });
      if (latestContractEvent && typeof latestContractEvent.ledgerSeq === "number") {
        return {
          lastLedger: latestContractEvent.ledgerSeq,
          cursor: null,
        };
      }
    }

    const latestLedgerResp = await this.callWithBackoff(() => this.rpcServer.getLatestLedger());
    const startLedger = Math.max(1, (latestLedgerResp?.sequence ?? 1) - 10);
    return { lastLedger: startLedger - 1, cursor: null };
  }

  /**
   * Saves the updated ledger checkpoint and paging cursor in PostgreSQL.
   */
  public async saveCheckpoint(lastLedger: number, cursor: string | null): Promise<void> {
    if (!this.db.indexerCursor?.upsert) {
      return;
    }
    await this.db.indexerCursor.upsert({
      where: { id: this.cursorId },
      create: {
        id: this.cursorId,
        lastLedger,
        cursor,
      },
      update: {
        lastLedger,
        cursor,
      },
    });
  }

  /**
   * Polls `getEvents` from the latest saved cursor/ledger checkpoint, decodes matching
   * contract events, persists them to PostgreSQL, and updates the checkpoint atomically.
   */
  public async pollOnce(): Promise<SorobanIngestionPollResult> {
    if (this.isPolling) {
      return {
        polled: 0,
        ingested: 0,
        duplicatesSkipped: 0,
        lastLedgerSeq: 0,
        cursor: null,
      };
    }

    this.isPolling = true;
    try {
      const checkpoint = await this.loadCheckpoint();
      const filters: SorobanRpc.Api.EventFilter[] = [
        {
          type: "contract",
          ...(this.contractId ? { contractIds: [this.contractId] } : {}),
        },
      ];

      const requestParams: SorobanRpc.Api.GetEventsRequest = checkpoint.cursor
        ? {
            cursor: checkpoint.cursor,
            filters,
            limit: this.batchSize,
          }
        : {
            startLedger: Math.max(1, checkpoint.lastLedger + 1),
            filters,
            limit: this.batchSize,
          };

      let response: any;
      try {
        response = await this.callWithBackoff(() => this.rpcServer.getEvents(requestParams));
      } catch (err: any) {
        const msg = String(err?.message ?? "").toLowerCase();
        // If cursor expired on the RPC node, fall back seamlessly to startLedger = checkpoint.lastLedger + 1
        if (checkpoint.cursor && (msg.includes("cursor") || msg.includes("startledger") || msg.includes("range"))) {
          response = await this.callWithBackoff(() =>
            this.rpcServer.getEvents({
              startLedger: Math.max(1, checkpoint.lastLedger + 1),
              filters,
              limit: this.batchSize,
            })
          );
        } else {
          throw err;
        }
      }

      const rawEvents: RawSorobanRpcEvent[] = Array.isArray(response?.events)
        ? response.events
        : [];
      const latestLedgerFromRpc =
        typeof response?.latestLedger === "number" ? response.latestLedger : checkpoint.lastLedger;

      let ingested = 0;
      let duplicatesSkipped = 0;
      let highestLedgerSeq = checkpoint.lastLedger;
      let latestCursor = checkpoint.cursor;

      // Sort by ledger sequence ascending to prevent any sequence ordering gaps
      const orderedEvents = [...rawEvents].sort((a, b) => {
        const ledgerA = typeof a.ledger === "number" ? a.ledger : parseInt(String(a.ledger), 10) || 0;
        const ledgerB = typeof b.ledger === "number" ? b.ledger : parseInt(String(b.ledger), 10) || 0;
        return ledgerA - ledgerB;
      });

      for (const rawEvent of orderedEvents) {
        const eventLedger =
          typeof rawEvent.ledger === "number"
            ? rawEvent.ledger
            : parseInt(String(rawEvent.ledger), 10) || highestLedgerSeq;
        const pagingToken = String(rawEvent.pagingToken ?? rawEvent.id ?? "");

        const decoded = this.decodeEvent(rawEvent);
        if (decoded) {
          const wasInserted = await this.persistDecodedEvent(decoded);
          if (wasInserted) {
            ingested += 1;
          } else {
            duplicatesSkipped += 1;
          }
        }

        if (eventLedger > highestLedgerSeq) {
          highestLedgerSeq = eventLedger;
        }
        if (pagingToken) {
          latestCursor = pagingToken;
        }
      }

      if (orderedEvents.length === 0 && latestLedgerFromRpc > highestLedgerSeq) {
        highestLedgerSeq = latestLedgerFromRpc;
        latestCursor = null;
      }

      await this.saveCheckpoint(highestLedgerSeq, latestCursor);

      return {
        polled: orderedEvents.length,
        ingested,
        duplicatesSkipped,
        lastLedgerSeq: highestLedgerSeq,
        cursor: latestCursor,
      };
    } finally {
      this.isPolling = false;
    }
  }

  private async persistDecodedEvent(event: DecodedSorobanContractEvent): Promise<boolean> {
    if (this.db.sorobanContractEvent) {
      if (this.db.sorobanContractEvent.findFirst) {
        const existing = await this.db.sorobanContractEvent.findFirst({
          where: {
            pagingToken: event.pagingToken,
            txHash: event.txHash,
            eventType: event.eventType,
            ledgerSeq: event.ledgerSeq,
          },
        });
        if (existing) {
          return false;
        }
      }

      await this.db.sorobanContractEvent.create({
        data: {
          contractId: event.contractId,
          eventType: event.eventType,
          topics: event.topics as any,
          leagueId: event.leagueId,
          txHash: event.txHash,
          ledgerSeq: event.ledgerSeq,
          timestamp: event.timestamp,
          pagingToken: event.pagingToken,
          payload: event.payload as any,
        },
      });
    }

    if (this.db.contractEvent?.create) {
      if (this.db.contractEvent.findFirst) {
        const existingLegacy = await this.db.contractEvent.findFirst({
          where: {
            txHash: event.txHash,
            eventType: event.eventType,
            ledgerSeq: event.ledgerSeq,
          },
        });
        if (!existingLegacy) {
          await this.db.contractEvent.create({
            data: {
              contractId: event.contractId,
              eventType: event.eventType,
              leagueId: event.leagueId,
              txHash: event.txHash,
              ledgerSeq: event.ledgerSeq,
              payload: {
                ...event.payload,
                timestamp: event.timestamp.toISOString(),
                pagingToken: event.pagingToken,
              } as any,
            },
          });
        } else if (!this.db.sorobanContractEvent) {
          return false;
        }
      } else {
        await this.db.contractEvent.create({
          data: {
            contractId: event.contractId,
            eventType: event.eventType,
            leagueId: event.leagueId,
            txHash: event.txHash,
            ledgerSeq: event.ledgerSeq,
            payload: {
              ...event.payload,
              timestamp: event.timestamp.toISOString(),
              pagingToken: event.pagingToken,
            } as any,
          },
        });
      }
    }

    return true;
  }

  /**
   * Starts continuous background polling.
   */
  public startDaemon(intervalMs: number = this.pollIntervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        console.error("[SorobanEventIngestionService] Poll cycle failed:", err);
      });
    }, intervalMs);
    if (typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
  }

  /**
   * Stops continuous background polling.
   */
  public stopDaemon(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const sorobanEventIngestionService = new SorobanEventIngestionService();
