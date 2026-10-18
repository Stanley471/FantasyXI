/**
 * Transaction Coordinator — asynchronous finality tracking for Stellar / Soroban
 * transactions (Freighter-signed deposits and backend-signed settlements).
 *
 * Under network load a submitted transaction can take several ledgers to land,
 * and the synchronous poll in SorobanContractClient.sendAndPoll (or the user's
 * browser tab) may give up before it does. The coordinator keeps watching:
 *
 * - Every tracked hash is a row in `coordinated_transactions`, so polling
 *   resumes where it left off after a backend restart.
 * - Due rows are polled against Soroban RPC `getTransaction` with exponential
 *   backoff (NOT_FOUND and transient RPC errors both mean "still pending").
 * - SUCCESS / FAILED are final. A hash still NOT_FOUND after `maxPendingMs`
 *   is marked DROPPED and an administrator is alerted.
 * - Finalization is a compare-and-set on status = PENDING, so when several
 *   instances poll the same row only one of them emits the status change.
 * - Status changes are pushed to the user's notification socket, to matching
 *   webhook endpoints, to the in-process event bus and to per-kind hooks.
 *
 * The coordinator never marks ledger rows as paid on its own: a successful
 * hash only proves the transaction landed, not that it paid the right amount
 * to the right escrow. Kind hooks (see server.ts) route deposits back through
 * FinancialService.verifyAndConfirmPayment for full verification.
 */

import { rpc } from "@stellar/stellar-sdk";
import { prisma } from "../../config/db.js";
import { getSorobanRpcServer } from "../../config/stellar.js";
import { CoordinatedTransactionStatus } from "@prisma/client";
import { calculateBackoffDelay, webhookDispatcher, WebhookEndpoint } from "../webhooks/webhookDispatcher.js";
import { webhookRetryEngine } from "../webhooks/webhookRetryEngine.js";
import { eventBus as defaultEventBus, EventBus } from "../events/eventBus.js";
import { userNotificationHub, UserNotificationHub } from "../notifications/userNotificationHub.js";
import { adminAlertNotifier, AdminAlertSink } from "../notifications/adminAlertNotifier.js";

export { CoordinatedTransactionStatus };

/** Event name used on the event bus, for webhooks and for user notifications. */
export const TRANSACTION_STATUS_EVENT = "transaction.status_changed";

const TX_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface TrackTransactionInput {
  txHash: string;
  /** What the transaction does, e.g. DEPOSIT, SETTLEMENT, REFUND */
  kind: string;
  userId?: string | null;
  leagueId?: string | null;
  transactionId?: string | null;
  metadata?: Record<string, unknown>;
  /** When the transaction was submitted; defaults to now */
  submittedAt?: Date;
}

export interface CoordinatedTransactionRecord {
  id: string;
  txHash: string;
  kind: string;
  status: CoordinatedTransactionStatus;
  userId: string | null;
  leagueId: string | null;
  transactionId: string | null;
  attempts: number;
  ledgerSeq: number | null;
  lastError: string | null;
  metadata: unknown;
  submittedAt: Date;
  nextPollAt: Date;
  lastPolledAt: Date | null;
  finalizedAt: Date | null;
}

export interface TransactionStatusChange {
  txHash: string;
  kind: string;
  status: CoordinatedTransactionStatus;
  previousStatus: CoordinatedTransactionStatus;
  userId: string | null;
  leagueId: string | null;
  transactionId: string | null;
  ledgerSeq: number | null;
  attempts: number;
  error: string | null;
  finalizedAt: string;
}

/** Subset of rpc.Server used by the coordinator (injectable for tests). */
export interface TransactionStatusRpc {
  getTransaction(hash: string): Promise<{
    status: string;
    ledger?: number;
    resultXdr?: { toXDR(format: "base64"): string };
  }>;
}

/** Webhook surface: registered endpoints plus a signed dispatcher. */
export interface TransactionWebhookPort {
  listEndpoints(): WebhookEndpoint[];
  dispatch(endpoint: WebhookEndpoint, event: string, payload: Record<string, unknown>): Promise<unknown>;
}

export type FinalizedTransactionHandler = (change: TransactionStatusChange) => Promise<void> | void;

export interface PollSummary {
  checked: number;
  succeeded: number;
  failed: number;
  dropped: number;
  stillPending: number;
}

export interface TransactionCoordinatorOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  rpc?: TransactionStatusRpc;
  hub?: UserNotificationHub;
  webhooks?: TransactionWebhookPort;
  alerts?: AdminAlertSink;
  eventBus?: EventBus;
  /** First retry delay; doubles on every NOT_FOUND poll */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** A hash still unknown to the network after this long is considered dropped */
  maxPendingMs?: number;
  /** Rows polled per tick */
  batchSize?: number;
  now?: () => Date;
}

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionValidationError";
  }
}

const defaultWebhooks: TransactionWebhookPort = {
  listEndpoints: () => webhookRetryEngine.getAllEndpoints(),
  dispatch: (endpoint, event, payload) => webhookDispatcher.dispatch(endpoint, event, payload),
};

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class TransactionCoordinatorService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly rpcOverride?: TransactionStatusRpc;
  private readonly hub: UserNotificationHub;
  private readonly webhooks: TransactionWebhookPort;
  private readonly alerts: AdminAlertSink;
  private readonly bus: EventBus;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxPendingMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly handlers = new Map<string, FinalizedTransactionHandler[]>();
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<PollSummary> | null = null;

  constructor(options: TransactionCoordinatorOptions = {}) {
    this.db = options.db ?? prisma;
    this.rpcOverride = options.rpc;
    this.hub = options.hub ?? userNotificationHub;
    this.webhooks = options.webhooks ?? defaultWebhooks;
    this.alerts = options.alerts ?? adminAlertNotifier;
    this.bus = options.eventBus ?? defaultEventBus;
    this.initialDelayMs = options.initialDelayMs ?? envInt("TX_COORDINATOR_INITIAL_DELAY_MS", 2_000);
    this.maxDelayMs = options.maxDelayMs ?? envInt("TX_COORDINATOR_MAX_DELAY_MS", 60_000);
    this.maxPendingMs = options.maxPendingMs ?? envInt("TX_COORDINATOR_MAX_PENDING_MS", 15 * 60_000);
    this.batchSize = options.batchSize ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  // Created lazily so importing the coordinator never opens an RPC connection
  private get rpc(): TransactionStatusRpc {
    return this.rpcOverride ?? (getSorobanRpcServer() as unknown as TransactionStatusRpc);
  }

  /**
   * Registers a hook run once a transaction of `kind` reaches a final status
   * (SUCCESS, FAILED or DROPPED). Returns an unsubscribe function.
   */
  public onFinalized(kind: string, handler: FinalizedTransactionHandler): () => void {
    const list = this.handlers.get(kind) ?? [];
    list.push(handler);
    this.handlers.set(kind, list);
    return () => {
      const current = this.handlers.get(kind) ?? [];
      this.handlers.set(kind, current.filter((h) => h !== handler));
    };
  }

  /**
   * Starts tracking a submitted transaction. Idempotent per hash: tracking the
   * same hash again returns the existing record unchanged.
   */
  public async track(input: TrackTransactionInput): Promise<CoordinatedTransactionRecord> {
    const txHash = typeof input.txHash === "string" ? input.txHash.trim().toLowerCase() : "";
    if (!TX_HASH_PATTERN.test(txHash)) {
      throw new TransactionValidationError("Invalid transaction hash. Expected a 64-character hex string.");
    }
    if (!input.kind || typeof input.kind !== "string") {
      throw new TransactionValidationError("Transaction kind is required");
    }

    const submittedAt = input.submittedAt ?? this.now();
    return this.db.coordinatedTransaction.upsert({
      where: { txHash },
      create: {
        txHash,
        kind: input.kind,
        status: CoordinatedTransactionStatus.PENDING,
        userId: input.userId ?? null,
        leagueId: input.leagueId ?? null,
        transactionId: input.transactionId ?? null,
        metadata: input.metadata ?? undefined,
        submittedAt,
        nextPollAt: submittedAt,
      },
      update: {},
    });
  }

  public async getByHash(txHash: string): Promise<CoordinatedTransactionRecord | null> {
    return this.db.coordinatedTransaction.findUnique({ where: { txHash: txHash.toLowerCase() } });
  }

  /**
   * Polls every pending transaction whose next poll time has passed.
   * Concurrent callers share the in-flight run.
   */
  public async pollDue(): Promise<PollSummary> {
    if (this.polling) return this.polling;
    this.polling = this.runPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** Starts the background poller (state is in the database, so restarts resume). */
  public start(intervalMs: number = envInt("TX_COORDINATOR_POLL_INTERVAL_MS", 2_000)): void {
    if (this.timer) return;
    const tick = () => {
      this.pollDue().catch((error) => {
        console.error("[tx-coordinator] Poll failed:", (error as Error).message);
      });
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    tick();
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.polling) await this.polling.catch(() => undefined);
  }

  private async runPoll(): Promise<PollSummary> {
    const summary: PollSummary = { checked: 0, succeeded: 0, failed: 0, dropped: 0, stillPending: 0 };
    const due: CoordinatedTransactionRecord[] = await this.db.coordinatedTransaction.findMany({
      where: { status: CoordinatedTransactionStatus.PENDING, nextPollAt: { lte: this.now() } },
      orderBy: { nextPollAt: "asc" },
      take: this.batchSize,
    });

    for (const record of due) {
      summary.checked++;
      const status = await this.pollOne(record);
      if (status === CoordinatedTransactionStatus.SUCCESS) summary.succeeded++;
      else if (status === CoordinatedTransactionStatus.FAILED) summary.failed++;
      else if (status === CoordinatedTransactionStatus.DROPPED) summary.dropped++;
      else summary.stillPending++;
    }
    return summary;
  }

  /**
   * Checks one transaction and applies the resulting state transition.
   * Returns the record's status after the poll.
   */
  public async pollOne(record: CoordinatedTransactionRecord): Promise<CoordinatedTransactionStatus> {
    const now = this.now();
    let response: Awaited<ReturnType<TransactionStatusRpc["getTransaction"]>>;
    try {
      response = await this.rpc.getTransaction(record.txHash);
    } catch (error) {
      // RPC sync delays / outages are transient: keep the transaction pending
      return this.handleStillPending(record, now, `RPC error: ${(error as Error).message}`);
    }

    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return this.finalize(record, now, CoordinatedTransactionStatus.SUCCESS, response.ledger ?? null, null);
    }
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      let detail = "Transaction failed on-chain";
      try {
        const xdr = response.resultXdr?.toXDR("base64");
        if (xdr) detail += ` (result ${xdr})`;
      } catch {
        // result XDR is informational only
      }
      return this.finalize(record, now, CoordinatedTransactionStatus.FAILED, response.ledger ?? null, detail);
    }

    return this.handleStillPending(record, now, null);
  }

  private async handleStillPending(
    record: CoordinatedTransactionRecord,
    now: Date,
    error: string | null
  ): Promise<CoordinatedTransactionStatus> {
    const pendingForMs = now.getTime() - new Date(record.submittedAt).getTime();
    if (pendingForMs >= this.maxPendingMs) {
      const reason =
        `Transaction not found on the network ${Math.round(pendingForMs / 1000)}s after submission` +
        (error ? `; last error: ${error}` : "");
      return this.finalize(record, now, CoordinatedTransactionStatus.DROPPED, null, reason);
    }

    const attempts = record.attempts + 1;
    const delay = calculateBackoffDelay(attempts, this.initialDelayMs, this.maxDelayMs);
    await this.db.coordinatedTransaction.updateMany({
      where: { id: record.id, status: CoordinatedTransactionStatus.PENDING },
      data: {
        attempts,
        lastPolledAt: now,
        lastError: error,
        nextPollAt: new Date(now.getTime() + delay),
      },
    });
    return CoordinatedTransactionStatus.PENDING;
  }

  private async finalize(
    record: CoordinatedTransactionRecord,
    now: Date,
    status: CoordinatedTransactionStatus,
    ledgerSeq: number | null,
    error: string | null
  ): Promise<CoordinatedTransactionStatus> {
    const attempts = record.attempts + 1;
    const { count } = await this.db.coordinatedTransaction.updateMany({
      where: { id: record.id, status: CoordinatedTransactionStatus.PENDING },
      data: { status, ledgerSeq, lastError: error, attempts, lastPolledAt: now, finalizedAt: now },
    });
    // Another instance finalized it first and already emitted the change
    if (count === 0) {
      const current = await this.db.coordinatedTransaction.findUnique({ where: { id: record.id } });
      return current?.status ?? status;
    }

    const change: TransactionStatusChange = {
      txHash: record.txHash,
      kind: record.kind,
      status,
      previousStatus: record.status,
      userId: record.userId,
      leagueId: record.leagueId,
      transactionId: record.transactionId,
      ledgerSeq,
      attempts,
      error,
      finalizedAt: now.toISOString(),
    };
    await this.emit(change);
    return status;
  }

  private async emit(change: TransactionStatusChange): Promise<void> {
    const payload = change as unknown as Record<string, unknown>;

    if (change.userId) {
      this.hub.publish(change.userId, TRANSACTION_STATUS_EVENT, payload);
    }

    for (const endpoint of this.matchingEndpoints(change)) {
      try {
        await this.webhooks.dispatch(endpoint, TRANSACTION_STATUS_EVENT, payload);
      } catch (error) {
        console.error(`[tx-coordinator] Webhook ${endpoint.id} failed:`, (error as Error).message);
      }
    }

    try {
      await this.bus.publish(TRANSACTION_STATUS_EVENT, change);
    } catch (error) {
      console.error("[tx-coordinator] Event bus publish failed:", (error as Error).message);
    }

    for (const handler of this.handlers.get(change.kind) ?? []) {
      try {
        await handler(change);
      } catch (error) {
        console.error(`[tx-coordinator] ${change.kind} handler failed for ${change.txHash}:`, (error as Error).message);
      }
    }

    if (change.status === CoordinatedTransactionStatus.DROPPED) {
      await this.alerts.notify({
        title: `Transaction dropped: ${change.kind} ${change.txHash.slice(0, 12)}…`,
        severity: "critical",
        text: [
          `A ${change.kind} transaction never reached a ledger and was marked DROPPED.`,
          `Hash: ${change.txHash}`,
          change.leagueId ? `League: ${change.leagueId}` : null,
          change.userId ? `User: ${change.userId}` : null,
          change.transactionId ? `Ledger transaction: ${change.transactionId}` : null,
          `Polls: ${change.attempts}`,
          `Reason: ${change.error}`,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }

  /** Endpoints subscribed to the event and scoped to the transaction's league or owner. */
  private matchingEndpoints(change: TransactionStatusChange): WebhookEndpoint[] {
    let endpoints: WebhookEndpoint[];
    try {
      endpoints = this.webhooks.listEndpoints();
    } catch {
      return [];
    }
    return endpoints.filter((endpoint) => {
      if (!endpoint.isActive) return false;
      if (!endpoint.events.includes(TRANSACTION_STATUS_EVENT) && !endpoint.events.includes("*")) return false;
      if (endpoint.leagueId) return endpoint.leagueId === change.leagueId;
      return change.userId !== null && endpoint.userId === change.userId;
    });
  }
}

export const transactionCoordinator = new TransactionCoordinatorService();
