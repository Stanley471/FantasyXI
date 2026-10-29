/**
 * Soroban contract event ingestion daemon (issue #230).
 *
 * Streams `getEvents` for the escrow contract, decodes the XDR topics and data
 * into readable JSON, and stores each event in `soroban_contract_events`.
 *
 * - No gaps: paging uses the RPC cursor, and the events of a page plus the new
 *   checkpoint are written in one DB transaction. A crash before commit replays
 *   the same page; event IDs are unique, so replays are no-ops.
 * - Restarts: the checkpoint lives in `indexer_cursors` under its own ID, so the
 *   daemon resumes from the last committed ledger.
 * - RPC limits: failures back off exponentially. Rate-limit responses honour
 *   `Retry-After` when the RPC sends one.
 */

import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

export const SOROBAN_INGESTION_CHECKPOINT_ID = "soroban-event-ingestion";

export type SorobanEventCategory =
  | "LeagueDeposit"
  | "Settlement"
  | "Refund"
  | "FeeWithdrawal"
  | "Affiliate"
  | "Governance"
  | "Other";

/** JSON-safe value: bigints become decimal strings, bytes become hex. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DecodedSorobanEvent {
  id: string;
  contractId: string;
  eventName: string;
  category: SorobanEventCategory;
  /** Contract league ID (as a decimal string) for league-scoped events. */
  leagueId: string | null;
  ledgerSeq: number;
  ledgerClosedAt: Date;
  txHash: string;
  inSuccessfulContractCall: boolean;
  topics: JsonValue[];
  payload: { [key: string]: JsonValue };
}

export interface IngestionCheckpoint {
  lastLedger: number;
  cursor: string | null;
}

/** Persistence used by the daemon. Kept small so tests can use an in-memory copy. */
export interface SorobanEventStore {
  loadCheckpoint(id: string): Promise<IngestionCheckpoint | null>;
  /** Saves the events and the checkpoint atomically. Must ignore duplicate event IDs. */
  commitBatch(id: string, events: DecodedSorobanEvent[], checkpoint: IngestionCheckpoint): Promise<void>;
}

/** The subset of the Soroban RPC client the daemon needs. */
export interface SorobanEventSource {
  getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
  getLatestLedger(): Promise<{ sequence: number }>;
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>;
}

// ------------------------------------------------------------
// Decoding
// ------------------------------------------------------------

function toScVal(value: unknown): xdr.ScVal {
  if (value instanceof xdr.ScVal) return value as xdr.ScVal;
  if (typeof value === "string") return xdr.ScVal.fromXDR(value, "base64");
  // Instances from a different copy of the SDK still expose toXDR().
  if (value && typeof (value as { toXDR?: unknown }).toXDR === "function") {
    return xdr.ScVal.fromXDR((value as { toXDR(f: "base64"): string }).toXDR("base64"), "base64");
  }
  throw new Error("Unsupported ScVal input");
}

/** Converts native values from scValToNative into JSON-safe values. */
export function toJsonSafe(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), toJsonSafe(v)]));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)])
    );
  }
  return String(value);
}

export function decodeScVal(value: unknown): JsonValue {
  return toJsonSafe(scValToNative(toScVal(value)));
}

interface EventSchema {
  category: SorobanEventCategory;
  /** Name of the second topic (most events carry the league ID there). */
  subject: "leagueId" | "proposalId";
  /** Field names for the tuple in the event data, or one name for a scalar. */
  fields: string[];
  /** Extra topics after the subject. */
  extraTopics?: string[];
}

/** Event layouts published by contracts/src/lib.rs. */
export const SOROBAN_EVENT_SCHEMAS: Record<string, EventSchema> = {
  deposit: { category: "LeagueDeposit", subject: "leagueId", fields: ["participant", "amount"] },
  settle: { category: "Settlement", subject: "leagueId", fields: ["totalPayout", "platformFee"] },
  m_settle: { category: "Settlement", subject: "leagueId", fields: ["merkleRoot", "totalPrizePool"] },
  m_claimed: { category: "Settlement", subject: "leagueId", fields: ["winner", "amount"] },
  claimed: { category: "Settlement", subject: "leagueId", fields: ["winner", "amount"] },
  EmergencyRefund: { category: "Refund", subject: "leagueId", fields: ["participant", "amount"] },
  DepositRefunded: { category: "Refund", subject: "leagueId", fields: ["participant", "amount"] },
  LeagueRefundClaimed: { category: "Refund", subject: "leagueId", fields: ["participant", "amount"] },
  refund: { category: "Refund", subject: "leagueId", fields: ["participant", "amount"] },
  TimelockProposed: { category: "FeeWithdrawal", subject: "proposalId", fields: ["destination", "amount"] },
  TimelockExecuted: { category: "FeeWithdrawal", subject: "proposalId", fields: ["destination", "amount"] },
  affiliate: { category: "Affiliate", subject: "leagueId", fields: ["affiliate", "amount"] },
  AffiliatePayoutTransferred: { category: "Affiliate", subject: "leagueId", fields: ["affiliate", "amount"] },
  LeagueFrozen: { category: "Governance", subject: "leagueId", fields: ["reasonHash"] },
  PauseActionProposed: {
    category: "Governance",
    subject: "proposalId",
    fields: ["caller", "reasonHash"],
    extraTopics: ["action"],
  },
  PauseActionApproved: { category: "Governance", subject: "proposalId", fields: ["caller"] },
  PauseActionExecuted: { category: "Governance", subject: "proposalId", fields: ["action"] },
};

function contractIdOf(event: rpc.Api.EventResponse | { contractId?: unknown }): string {
  const contract = event.contractId as { contractId?: () => string } | string | undefined;
  if (!contract) return "";
  if (typeof contract === "string") return contract;
  return typeof contract.contractId === "function" ? contract.contractId() : String(contract);
}

/**
 * Decodes one RPC event into a structured record. Unknown event names are
 * kept with category "Other" and their raw decoded topics and data.
 */
export function decodeSorobanContractEvent(event: rpc.Api.EventResponse): DecodedSorobanEvent {
  const topics = (event.topic ?? []).map(decodeScVal);
  const data = event.value === undefined ? null : decodeScVal(event.value);
  const eventName = typeof topics[0] === "string" ? topics[0] : "unknown";
  const schema = SOROBAN_EVENT_SCHEMAS[eventName];

  const payload: { [key: string]: JsonValue } = {};
  let leagueId: string | null = null;

  if (schema) {
    const subject = topics[1] ?? null;
    payload[schema.subject] = subject;
    if (schema.subject === "leagueId" && subject !== null) leagueId = String(subject);
    schema.extraTopics?.forEach((name, i) => {
      payload[name] = topics[2 + i] ?? null;
    });
    if (schema.fields.length === 1) {
      payload[schema.fields[0]] = data;
    } else if (Array.isArray(data)) {
      schema.fields.forEach((name, i) => {
        payload[name] = data[i] ?? null;
      });
    } else {
      payload.data = data;
    }
  } else {
    payload.topics = topics.slice(1);
    payload.data = data;
  }

  return {
    id: event.id,
    contractId: contractIdOf(event),
    eventName,
    category: schema?.category ?? "Other",
    leagueId,
    ledgerSeq: event.ledger,
    ledgerClosedAt: new Date(event.ledgerClosedAt),
    txHash: event.txHash,
    inSuccessfulContractCall: event.inSuccessfulContractCall,
    topics,
    payload,
  };
}

// ------------------------------------------------------------
// Persistence
// ------------------------------------------------------------

/** Prisma-backed store: `soroban_contract_events` plus a row in `indexer_cursors`. */
export class PrismaSorobanEventStore implements SorobanEventStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any) {}

  public async loadCheckpoint(id: string): Promise<IngestionCheckpoint | null> {
    const row = await this.db.indexerCursor.findUnique({ where: { id } });
    return row ? { lastLedger: row.lastLedger, cursor: row.cursor ?? null } : null;
  }

  public async commitBatch(
    id: string,
    events: DecodedSorobanEvent[],
    checkpoint: IngestionCheckpoint
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.db.$transaction(async (tx: any) => {
      if (events.length > 0) {
        await tx.sorobanContractEvent.createMany({ data: events, skipDuplicates: true });
      }
      await tx.indexerCursor.upsert({
        where: { id },
        create: { id, ...checkpoint },
        update: checkpoint,
      });
    });
  }
}

/** In-memory store for tests and local tooling. */
export class MemorySorobanEventStore implements SorobanEventStore {
  public readonly events = new Map<string, DecodedSorobanEvent>();
  public readonly checkpoints = new Map<string, IngestionCheckpoint>();

  public async loadCheckpoint(id: string): Promise<IngestionCheckpoint | null> {
    return this.checkpoints.get(id) ?? null;
  }

  public async commitBatch(
    id: string,
    events: DecodedSorobanEvent[],
    checkpoint: IngestionCheckpoint
  ): Promise<void> {
    for (const event of events) {
      if (!this.events.has(event.id)) this.events.set(event.id, event);
    }
    this.checkpoints.set(id, { ...checkpoint });
  }
}

// ------------------------------------------------------------
// Daemon
// ------------------------------------------------------------

export interface SorobanEventIngestionOptions {
  source: SorobanEventSource;
  store: SorobanEventStore;
  contractId: string;
  checkpointId?: string;
  /** Ledger to start at when there is no checkpoint. Defaults to the latest ledger. */
  startLedger?: number;
  batchSize?: number;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export class SorobanRpcRateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super("Soroban RPC rate limit reached");
  }
}

export function isRateLimitError(error: unknown): boolean {
  const e = error as { response?: { status?: number }; status?: number; message?: string };
  return (
    error instanceof SorobanRpcRateLimitError ||
    e?.response?.status === 429 ||
    e?.status === 429 ||
    /rate.?limit|too many requests/i.test(e?.message ?? "")
  );
}

function retryAfterMsOf(error: unknown): number | undefined {
  if (error instanceof SorobanRpcRateLimitError) return error.retryAfterMs;
  const headers = (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function isOutOfRetention(error: unknown): boolean {
  return /ledger range|startLedger must be|cursor/i.test((error as Error)?.message ?? "");
}

export class SorobanEventIngestionService {
  private readonly source: SorobanEventSource;
  private readonly store: SorobanEventStore;
  private readonly contractId: string;
  private readonly checkpointId: string;
  private readonly startLedger?: number;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(options: SorobanEventIngestionOptions) {
    this.source = options.source;
    this.store = options.store;
    this.contractId = options.contractId;
    this.checkpointId = options.checkpointId ?? SOROBAN_INGESTION_CHECKPOINT_ID;
    this.startLedger = options.startLedger;
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.logger = options.logger ?? console;
  }

  private filters(): rpc.Api.EventFilter[] {
    return [{ type: "contract", contractIds: [this.contractId] }];
  }

  private async fetchPage(checkpoint: IngestionCheckpoint | null): Promise<rpc.Api.GetEventsResponse> {
    if (checkpoint?.cursor) {
      return this.source.getEvents({ filters: this.filters(), cursor: checkpoint.cursor, limit: this.batchSize });
    }
    const startLedger =
      checkpoint !== null
        ? checkpoint.lastLedger + 1
        : this.startLedger ?? (await this.source.getLatestLedger()).sequence;
    return this.source.getEvents({ filters: this.filters(), startLedger, limit: this.batchSize });
  }

  /**
   * Fetches, decodes and commits one page. Returns how many events it stored.
   */
  public async pollOnce(): Promise<number> {
    const checkpoint = await this.store.loadCheckpoint(this.checkpointId);

    let response: rpc.Api.GetEventsResponse;
    try {
      response = await this.fetchPage(checkpoint);
    } catch (error) {
      if (isRateLimitError(error) || !isOutOfRetention(error)) throw error;
      // The saved position fell out of the node's retention window. Resume at
      // the oldest ledger still available and report the gap loudly.
      const range = await this.source.getHealth();
      const resumeAt = Math.max(range.oldestLedger, (checkpoint?.lastLedger ?? 0) + 1);
      this.logger.error(
        `[soroban-ingest] Checkpoint ledger ${checkpoint?.lastLedger} is outside RPC retention; ` +
          `resuming at ${resumeAt}. Ledgers in between must be backfilled from an archive node.`
      );
      response = await this.source.getEvents({
        filters: this.filters(),
        startLedger: resumeAt,
        limit: this.batchSize,
      });
    }

    const decoded: DecodedSorobanEvent[] = [];
    for (const event of response.events) {
      try {
        decoded.push(decodeSorobanContractEvent(event));
      } catch (error) {
        // Keep the event so the ledger stays complete; flag that decoding failed.
        this.logger.warn(`[soroban-ingest] Could not decode event ${event.id}: ${(error as Error).message}`);
        decoded.push({
          id: event.id,
          contractId: contractIdOf(event),
          eventName: "undecodable",
          category: "Other",
          leagueId: null,
          ledgerSeq: event.ledger,
          ledgerClosedAt: new Date(event.ledgerClosedAt),
          txHash: event.txHash,
          inSuccessfulContractCall: event.inSuccessfulContractCall,
          topics: [],
          payload: { error: (error as Error).message },
        });
      }
    }

    // The cursor is what keeps paging gap-free. lastLedger is the fallback used
    // only if the cursor is lost: a full page may stop part-way through a
    // ledger, so it points one ledger back and the replay is deduplicated.
    const lastEventLedger = decoded.at(-1)?.ledgerSeq;
    const lastLedger =
      lastEventLedger === undefined
        ? Math.max(checkpoint?.lastLedger ?? 0, response.latestLedger)
        : decoded.length >= this.batchSize
          ? lastEventLedger - 1
          : lastEventLedger;

    await this.store.commitBatch(this.checkpointId, decoded, {
      lastLedger,
      cursor: response.cursor || checkpoint?.cursor || null,
    });
    return decoded.length;
  }

  public static backoffDelay(failures: number, baseMs: number, maxMs: number): number {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
  }

  /** Delay before the next attempt after an error. */
  public nextDelayAfterError(error: unknown, failures: number): number {
    const backoff = SorobanEventIngestionService.backoffDelay(failures, this.baseBackoffMs, this.maxBackoffMs);
    if (isRateLimitError(error)) {
      const retryAfter = retryAfterMsOf(error);
      return Math.min(this.maxBackoffMs, Math.max(backoff, retryAfter ?? 0));
    }
    return backoff;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    this.logger.info(`[soroban-ingest] Ingesting events for contract ${this.contractId}`);
  }

  public stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  public isRunning(): boolean {
    return this.running;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const stored = await this.pollOnce();
      this.failures = 0;
      // A full page means more events are waiting.
      this.schedule(stored >= this.batchSize ? 0 : this.pollIntervalMs);
    } catch (error) {
      this.failures++;
      const delay = this.nextDelayAfterError(error, this.failures);
      this.logger.warn(
        `[soroban-ingest] Poll failed (attempt ${this.failures}), retrying in ${delay}ms: ${(error as Error).message}`
      );
      this.schedule(delay);
    }
  }
}

/**
 * Builds the daemon from environment config. Returns null when no escrow
 * contract is configured.
 */
export async function createSorobanEventIngestionService(): Promise<SorobanEventIngestionService | null> {
  const contractId = process.env.STELLAR_ESCROW_CONTRACT_ID;
  if (!contractId) return null;
  const [{ prisma }, { getSorobanRpcServer }] = await Promise.all([
    import("../../config/db.js"),
    import("../../config/stellar.js"),
  ]);
  const startLedger = Number.parseInt(process.env.SOROBAN_INGEST_START_LEDGER || "", 10);
  return new SorobanEventIngestionService({
    source: getSorobanRpcServer(),
    store: new PrismaSorobanEventStore(prisma),
    contractId,
    startLedger: Number.isFinite(startLedger) ? startLedger : undefined,
  });
}
