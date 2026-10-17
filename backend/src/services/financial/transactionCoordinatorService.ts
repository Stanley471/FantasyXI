export type CoordinatedTxStatus =
  | "SUBMITTED"
  | "POLLING"
  | "CONFIRMED"
  | "FAILED"
  | "TIMED_OUT";

export type SorobanRpcTxStatus = "SUCCESS" | "NOT_FOUND" | "FAILED";

export interface SorobanRpcGetTransactionResponse {
  status: SorobanRpcTxStatus;
  ledger?: number;
  createdAt?: number;
  returnValueXdr?: string;
  diagnosticError?: string;
}

export interface TrackedFreighterTransaction {
  txHash: string;
  userId: string;
  leagueId: string;
  intent: "ENTRY_FEE_DEPOSIT" | "PRIZE_SETTLEMENT" | "EMERGENCY_REFUND";
  amountUsdc: number;
  status: CoordinatedTxStatus;
  pollAttempts: number;
  submittedAtMs: number;
  lastPolledAtMs: number | null;
  nextPollAtMs: number;
  confirmedAtMs: number | null;
  ledgerSeq: number | null;
  failureReason: string | null;
  terminalDispatched: boolean;
}

export interface TransactionStatusNotification {
  eventType:
    | "freighter.tx.submitted"
    | "freighter.tx.confirmed"
    | "freighter.tx.failed"
    | "freighter.tx.timed_out";
  txHash: string;
  userId: string;
  leagueId: string;
  intent: TrackedFreighterTransaction["intent"];
  amountUsdc: number;
  status: CoordinatedTxStatus;
  ledgerSeq: number | null;
  failureReason: string | null;
  timestampMs: number;
}

export interface TransactionCoordinatorOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxPollAttempts?: number;
  maxPollDurationMs?: number;
  rpcGetTransaction: (txHash: string) => Promise<SorobanRpcGetTransactionResponse>;
  onWebSocketNotify?: (notification: TransactionStatusNotification) => void | Promise<void>;
  onWebhookDispatch?: (notification: TransactionStatusNotification) => void | Promise<void>;
}

export class TransactionCoordinatorService {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxPollAttempts: number;
  private readonly maxPollDurationMs: number;
  private readonly rpcGetTransaction: (
    txHash: string
  ) => Promise<SorobanRpcGetTransactionResponse>;
  private readonly onWebSocketNotify?: (
    notification: TransactionStatusNotification
  ) => void | Promise<void>;
  private readonly onWebhookDispatch?: (
    notification: TransactionStatusNotification
  ) => void | Promise<void>;

  private readonly transactions = new Map<string, TrackedFreighterTransaction>();

  constructor(options: TransactionCoordinatorOptions) {
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 16_000;
    this.maxPollAttempts = options.maxPollAttempts ?? 12;
    this.maxPollDurationMs = options.maxPollDurationMs ?? 90_000;
    this.rpcGetTransaction = options.rpcGetTransaction;
    this.onWebSocketNotify = options.onWebSocketNotify;
    this.onWebhookDispatch = options.onWebhookDispatch;
  }

  /**
   * Computes exponential backoff delay: `min(maxDelayMs, initialDelayMs * 2^attempt)`.
   */
  public computeNextBackoffDelayMs(attempt: number): number {
    const exp = Math.max(0, attempt);
    return Math.min(this.maxDelayMs, this.initialDelayMs * Math.pow(2, exp));
  }

  /**
   * Registers a newly signed & submitted Freighter transaction hash for asynchronous
   * Soroban RPC status polling.
   */
  public async enqueueTransaction(params: {
    txHash: string;
    userId: string;
    leagueId: string;
    intent: TrackedFreighterTransaction["intent"];
    amountUsdc: number;
    nowMs?: number;
  }): Promise<TrackedFreighterTransaction> {
    const nowMs = params.nowMs ?? Date.now();
    const existing = this.transactions.get(params.txHash);
    if (existing) {
      return structuredClone(existing);
    }

    const record: TrackedFreighterTransaction = {
      txHash: params.txHash,
      userId: params.userId,
      leagueId: params.leagueId,
      intent: params.intent,
      amountUsdc: params.amountUsdc,
      status: "SUBMITTED",
      pollAttempts: 0,
      submittedAtMs: nowMs,
      lastPolledAtMs: null,
      nextPollAtMs: nowMs + this.initialDelayMs,
      confirmedAtMs: null,
      ledgerSeq: null,
      failureReason: null,
      terminalDispatched: false,
    };

    this.transactions.set(params.txHash, record);

    if (this.onWebSocketNotify) {
      await this.onWebSocketNotify({
        eventType: "freighter.tx.submitted",
        txHash: record.txHash,
        userId: record.userId,
        leagueId: record.leagueId,
        intent: record.intent,
        amountUsdc: record.amountUsdc,
        status: record.status,
        ledgerSeq: null,
        failureReason: null,
        timestampMs: nowMs,
      });
    }

    return structuredClone(record);
  }

  /**
   * Executes a single polling step for a specific transaction hash against Soroban RPC,
   * updating its state and firing WebSocket + Webhook notifications on terminal transitions.
   */
  public async pollTransactionOnce(
    txHash: string,
    nowMs: number = Date.now()
  ): Promise<TrackedFreighterTransaction> {
    const record = this.transactions.get(txHash);
    if (!record) {
      throw new Error(`Tracked Freighter transaction ${txHash} not found`);
    }

    if (
      record.status === "CONFIRMED" ||
      record.status === "FAILED" ||
      record.status === "TIMED_OUT"
    ) {
      return structuredClone(record);
    }

    record.status = "POLLING";
    record.pollAttempts += 1;
    record.lastPolledAtMs = nowMs;

    const rpcResult = await this.rpcGetTransaction(txHash);

    if (rpcResult.status === "SUCCESS") {
      record.status = "CONFIRMED";
      record.confirmedAtMs = nowMs;
      record.ledgerSeq = rpcResult.ledger ?? null;
      await this.dispatchTerminalNotification(
        record,
        "freighter.tx.confirmed",
        nowMs
      );
      return structuredClone(record);
    }

    if (rpcResult.status === "FAILED") {
      record.status = "FAILED";
      record.failureReason =
        rpcResult.diagnosticError ?? "Soroban transaction execution failed on-chain";
      await this.dispatchTerminalNotification(
        record,
        "freighter.tx.failed",
        nowMs
      );
      return structuredClone(record);
    }

    // Status is NOT_FOUND -> check timeout bounds
    const elapsedMs = nowMs - record.submittedAtMs;
    if (
      record.pollAttempts >= this.maxPollAttempts ||
      elapsedMs >= this.maxPollDurationMs
    ) {
      record.status = "TIMED_OUT";
      record.failureReason = `Transaction ${txHash} was not included in a ledger after ${record.pollAttempts} attempts (${elapsedMs}ms)`;
      await this.dispatchTerminalNotification(
        record,
        "freighter.tx.timed_out",
        nowMs
      );
      return structuredClone(record);
    }

    const backoffDelay = this.computeNextBackoffDelayMs(record.pollAttempts);
    record.nextPollAtMs = nowMs + backoffDelay;
    return structuredClone(record);
  }

  /**
   * Polls all due pending transactions whose `nextPollAtMs <= nowMs`.
   */
  public async pollDueTransactions(
    nowMs: number = Date.now()
  ): Promise<TrackedFreighterTransaction[]> {
    const updated: TrackedFreighterTransaction[] = [];
    for (const [txHash, rec] of this.transactions.entries()) {
      if (
        (rec.status === "SUBMITTED" || rec.status === "POLLING") &&
        nowMs >= rec.nextPollAtMs
      ) {
        const res = await this.pollTransactionOnce(txHash, nowMs);
        updated.push(res);
      }
    }
    return updated;
  }

  public getTransactionState(
    txHash: string
  ): TrackedFreighterTransaction | undefined {
    const rec = this.transactions.get(txHash);
    return rec ? structuredClone(rec) : undefined;
  }

  private async dispatchTerminalNotification(
    record: TrackedFreighterTransaction,
    eventType:
      | "freighter.tx.confirmed"
      | "freighter.tx.failed"
      | "freighter.tx.timed_out",
    nowMs: number
  ): Promise<void> {
    if (record.terminalDispatched) {
      return;
    }
    record.terminalDispatched = true;

    const payload: TransactionStatusNotification = {
      eventType,
      txHash: record.txHash,
      userId: record.userId,
      leagueId: record.leagueId,
      intent: record.intent,
      amountUsdc: record.amountUsdc,
      status: record.status,
      ledgerSeq: record.ledgerSeq,
      failureReason: record.failureReason,
      timestampMs: nowMs,
    };

    if (this.onWebSocketNotify) {
      await this.onWebSocketNotify(payload);
    }
    if (this.onWebhookDispatch) {
      await this.onWebhookDispatch(payload);
    }
  }
}
