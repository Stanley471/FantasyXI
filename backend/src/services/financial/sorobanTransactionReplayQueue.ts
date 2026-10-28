import {
  SorobanSubmissionStatus,
  TransactionStatus,
} from "@prisma/client";
import {
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  type Transaction,
} from "@stellar/stellar-sdk";
import { prisma } from "../../config/db.js";
import { getSorobanRpcServer } from "../../config/stellar.js";

export interface SorobanSubmissionRecord {
  id: string;
  txHash: string;
  sourceAccount: string;
  sequence: bigint;
  signedEnvelope: string;
  status: SorobanSubmissionStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date;
  lastPolledAt: Date | null;
  ledgerSeq: number | null;
  lastError: string | null;
  leaseExpiresAt: Date | null;
}

export interface SorobanReplayStore {
  enqueue(input: {
    txHash: string;
    sourceAccount: string;
    sequence: bigint;
    signedEnvelope: string;
  }): Promise<SorobanSubmissionRecord>;
  getById(id: string): Promise<SorobanSubmissionRecord | null>;
  getByHash(txHash: string): Promise<SorobanSubmissionRecord | null>;
  listDue(now: Date, limit: number): Promise<SorobanSubmissionRecord[]>;
  claim(record: SorobanSubmissionRecord, now: Date, leaseUntil: Date): Promise<boolean>;
  release(id: string): Promise<void>;
  update(
    id: string,
    status: SorobanSubmissionStatus,
    patch: Record<string, unknown>,
    reason: string
  ): Promise<SorobanSubmissionRecord | null>;
}

const terminalStatuses = new Set<SorobanSubmissionStatus>([
  SorobanSubmissionStatus.SUCCESS,
  SorobanSubmissionStatus.FAILED,
  SorobanSubmissionStatus.DROPPED,
]);

export class PrismaSorobanReplayStore implements SorobanReplayStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  public async enqueue(input: {
    txHash: string;
    sourceAccount: string;
    sequence: bigint;
    signedEnvelope: string;
  }): Promise<SorobanSubmissionRecord> {
    const existing = await this.getByHash(input.txHash);
    if (existing) {
      return existing;
    }

    try {
      return await this.db.sorobanTransactionSubmission.create({
        data: {
          ...input,
          status: SorobanSubmissionStatus.PENDING_VERIFICATION,
          transitions: {
            create: {
              toStatus: SorobanSubmissionStatus.PENDING_VERIFICATION,
              reason: "Persisted before transaction submission",
            },
          },
        },
      });
    } catch (error) {
      // A concurrent caller may have persisted this exact hash or sequence.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        const raced = await this.getByHash(input.txHash);
        if (raced) return raced;
      }
      throw error;
    }
  }

  public getById(id: string): Promise<SorobanSubmissionRecord | null> {
    return this.db.sorobanTransactionSubmission.findUnique({ where: { id } });
  }

  public getByHash(txHash: string): Promise<SorobanSubmissionRecord | null> {
    return this.db.sorobanTransactionSubmission.findUnique({ where: { txHash } });
  }

  public listDue(now: Date, limit: number): Promise<SorobanSubmissionRecord[]> {
    return this.db.sorobanTransactionSubmission.findMany({
      where: {
        status: {
          in: [
            SorobanSubmissionStatus.PENDING_VERIFICATION,
            SorobanSubmissionStatus.SUBMITTED,
          ],
        },
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: { nextAttemptAt: "asc" },
      take: limit,
    });
  }

  public async claim(
    record: SorobanSubmissionRecord,
    now: Date,
    leaseUntil: Date
  ): Promise<boolean> {
    const result = await this.db.sorobanTransactionSubmission.updateMany({
      where: {
        id: record.id,
        status: record.status,
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { leaseExpiresAt: leaseUntil },
    });
    return result.count === 1;
  }

  public async release(id: string): Promise<void> {
    await this.db.sorobanTransactionSubmission.updateMany({
      where: { id },
      data: { leaseExpiresAt: null },
    });
  }

  public update(
    id: string,
    status: SorobanSubmissionStatus,
    patch: Record<string, unknown>,
    reason: string
  ): Promise<SorobanSubmissionRecord | null> {
    return this.db.$transaction(async (tx: any) => {
      const current = await tx.sorobanTransactionSubmission.findUnique({
        where: { id },
      });
      if (!current || terminalStatuses.has(current.status)) {
        return current;
      }

      const updated = await tx.sorobanTransactionSubmission.update({
        where: { id },
        data: { ...patch, status },
      });
      if (
        current.status !== status ||
        (status === SorobanSubmissionStatus.PENDING_VERIFICATION &&
          typeof patch.lastError === "string" &&
          patch.lastError !== current.lastError)
      ) {
        await tx.sorobanTransactionTransition.create({
          data: {
            submissionId: id,
            fromStatus: current.status,
            toStatus: status,
            reason,
          },
        });
      }

      if (status === SorobanSubmissionStatus.SUCCESS) {
        await tx.transaction.updateMany({
          where: { stellarTxHash: current.txHash },
          data: {
            status: TransactionStatus.CONFIRMED,
            ledgerSeq: patch.ledgerSeq,
            confirmedAt: new Date(),
            errorMessage: null,
          },
        });
      } else if (status === SorobanSubmissionStatus.FAILED) {
        await tx.transaction.updateMany({
          where: { stellarTxHash: current.txHash },
          data: {
            status: TransactionStatus.FAILED,
            ledgerSeq: patch.ledgerSeq,
            errorMessage: typeof patch.lastError === "string" ? patch.lastError : reason,
          },
        });
      }

      return updated;
    });
  }
}

export interface SorobanReplayResult {
  success: boolean;
  txHash: string;
  status: SorobanSubmissionStatus;
  sequence: string;
  returnValue?: unknown;
  ledgerSeq?: number;
  error?: string;
  pendingVerification?: boolean;
  dropped?: boolean;
}

export interface SorobanReplayQueueOptions {
  server?: rpc.Server;
  store?: SorobanReplayStore;
  networkPassphrase?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  batchSize?: number;
  leaseMs?: number;
}

export class SorobanTransactionReplayQueue {
  private readonly server: rpc.Server;
  private readonly store: SorobanReplayStore;
  private readonly networkPassphrase: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly returnValues = new Map<string, unknown>();

  constructor(options: SorobanReplayQueueOptions = {}) {
    this.server = options.server ?? getSorobanRpcServer();
    this.store = options.store ?? new PrismaSorobanReplayStore();
    this.networkPassphrase =
      options.networkPassphrase ??
      process.env.STELLAR_NETWORK_PASSPHRASE ??
      Networks.TESTNET;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxPollAttempts = options.maxPollAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.batchSize = options.batchSize ?? 25;
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  public async submit(tx: Transaction): Promise<SorobanReplayResult> {
    const txHash = Buffer.from(tx.hash()).toString("hex");
    const record = await this.store.enqueue({
      txHash,
      sourceAccount: tx.source,
      sequence: BigInt(tx.sequence),
      signedEnvelope: tx.toXDR(),
    });

    if (terminalStatuses.has(record.status)) {
      return this.toResult(record);
    }

    const claimed = await this.store.claim(
      record,
      new Date(),
      new Date(Date.now() + this.leaseMs)
    );
    if (!claimed) {
      const current = await this.store.getById(record.id);
      if (!current) {
        throw new Error(`Soroban submission ${txHash} disappeared from the replay queue`);
      }
      return this.toResult(current);
    }

    try {
      await this.broadcastExactEnvelope(record);
      for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
        const result = await this.processSubmission(record.id, true);
        if (result && terminalStatuses.has(result.status)) {
          const response = this.toResult(result);
          this.returnValues.delete(record.id);
          return response;
        }
        if (attempt + 1 < this.maxPollAttempts) {
          await this.sleep(Math.min(this.pollIntervalMs * 2 ** attempt, 30_000));
        }
      }

      const pending = await this.store.getById(record.id);
      if (!pending) {
        throw new Error(`Soroban submission ${txHash} disappeared from the replay queue`);
      }
      return this.toResult(pending);
    } finally {
      await this.store.release(record.id);
    }
  }

  /**
   * Reconciles eligible durable submissions. Each record is leased atomically,
   * so multiple API instances cannot process the same envelope concurrently.
   */
  public async processDueSubmissions(): Promise<number> {
    const now = new Date();
    const due = await this.store.listDue(now, this.batchSize);
    let processed = 0;
    for (const record of due) {
      const claimed = await this.store.claim(
        record,
        new Date(),
        new Date(Date.now() + this.leaseMs)
      );
      if (!claimed) continue;
      try {
        await this.processSubmission(record.id);
      } finally {
        await this.store.release(record.id);
      }
      processed++;
    }
    return processed;
  }

  private async processSubmission(
    id: string,
    captureReturnValue = false
  ): Promise<SorobanSubmissionRecord | null> {
    const submission = await this.store.getById(id);
    if (!submission || terminalStatuses.has(submission.status)) {
      return submission;
    }

    let result: rpc.Api.GetTransactionResponse;
    try {
      result = await this.server.getTransaction(submission.txHash);
    } catch (error) {
      return this.defer(
        submission,
        error instanceof Error ? error.message : "Soroban getTransaction failed"
      );
    }

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const updated = await this.store.update(
        id,
        SorobanSubmissionStatus.SUCCESS,
        {
          ledgerSeq: result.ledger,
          lastPolledAt: new Date(),
          lastError: null,
          nextAttemptAt: new Date(),
          leaseExpiresAt: null,
        },
        `Confirmed in ledger ${result.ledger}`
      );
      if (captureReturnValue) {
        this.returnValues.set(
          id,
          result.returnValue ? scValToNative(result.returnValue) : undefined
        );
      }
      return updated;
    }

    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const errorMessage = `Transaction failed in ledger: ${result.resultXdr.toXDR("base64")}`;
      return this.store.update(
        id,
        SorobanSubmissionStatus.FAILED,
        {
          ledgerSeq: result.ledger,
          lastPolledAt: new Date(),
          lastError: errorMessage,
          leaseExpiresAt: null,
        },
        errorMessage
      );
    }

    const tx = TransactionBuilder.fromXDR(
      submission.signedEnvelope,
      this.networkPassphrase
    );
    if (!("sequence" in tx)) {
      return this.defer(submission, "Fee-bump envelopes are not supported by the replay queue");
    }

    let account;
    try {
      account = await this.server.getAccount(submission.sourceAccount);
    } catch (error) {
      return this.defer(
        submission,
        error instanceof Error ? error.message : "Could not verify source account sequence"
      );
    }

    const accountSequence = BigInt(account.sequenceNumber());
    const latestCloseTime = result.latestLedgerCloseTime;
    const maxTime = tx.timeBounds ? Number(tx.timeBounds.maxTime) : 0;
    if (
      maxTime > 0 &&
      latestCloseTime > maxTime &&
      accountSequence < submission.sequence
    ) {
      return this.store.update(
        id,
        SorobanSubmissionStatus.DROPPED,
        {
          lastPolledAt: new Date(),
          lastError: "Transaction expired and its sequence number remains unused",
          leaseExpiresAt: null,
        },
        "Verified expired after ledger close while source sequence remained unused"
      );
    }
    if (maxTime > 0 && latestCloseTime > maxTime) {
      return this.defer(
        submission,
        "Source sequence was consumed but this hash is not yet verifiable"
      );
    }

    let sent;
    try {
      sent = await this.server.sendTransaction(tx);
    } catch (error) {
      return this.defer(
        submission,
        error instanceof Error ? error.message : "Soroban replay attempt failed"
      );
    }
    if (sent.status === "ERROR") {
      return this.defer(
        submission,
        `RPC rejected submission: ${sent.errorResult?.toXDR("base64") ?? "unknown"}`
      );
    }
    if (sent.hash && sent.hash.toLowerCase() !== submission.txHash.toLowerCase()) {
      return this.defer(
        submission,
        "Soroban RPC returned a hash that does not match the signed envelope"
      );
    }
    return this.defer(submission, null, SorobanSubmissionStatus.SUBMITTED);
  }

  private async broadcastExactEnvelope(
    submission: SorobanSubmissionRecord
  ): Promise<void> {
    const tx = TransactionBuilder.fromXDR(
      submission.signedEnvelope,
      this.networkPassphrase
    );
    let sent;
    try {
      sent = await this.server.sendTransaction(tx);
    } catch (error) {
      await this.defer(
        submission,
        error instanceof Error ? error.message : "Soroban submission RPC failed"
      );
      return;
    }
    if (sent.status === "ERROR") {
      await this.defer(
        submission,
        `RPC rejected submission: ${sent.errorResult?.toXDR("base64") ?? "unknown"}`
      );
      return;
    }
    if (sent.hash && sent.hash.toLowerCase() !== submission.txHash.toLowerCase()) {
      await this.defer(
        submission,
        "Soroban RPC returned a hash that does not match the signed envelope"
      );
      return;
    }
    await this.defer(submission, null, SorobanSubmissionStatus.SUBMITTED);
  }

  private defer(
    submission: SorobanSubmissionRecord,
    error: string | null,
    status: SorobanSubmissionStatus = SorobanSubmissionStatus.PENDING_VERIFICATION
  ): Promise<SorobanSubmissionRecord | null> {
    const attemptCount = submission.attemptCount + 1;
    const delayMs = Math.min(
      this.baseBackoffMs * 2 ** Math.max(0, attemptCount - 1),
      this.maxBackoffMs
    );
    return this.store.update(
      submission.id,
      status,
      {
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        lastPolledAt: new Date(),
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: error,
      },
      error ?? (status === SorobanSubmissionStatus.SUBMITTED
        ? "Envelope broadcast for confirmation"
        : "Transaction remains unconfirmed; verification will retry")
    );
  }

  private toResult(submission: SorobanSubmissionRecord): SorobanReplayResult {
    if (submission.status === SorobanSubmissionStatus.SUCCESS) {
      return {
        success: true,
        txHash: submission.txHash,
        status: submission.status,
        sequence: submission.sequence.toString(),
        ledgerSeq: submission.ledgerSeq ?? undefined,
        returnValue: this.returnValues.get(submission.id),
      };
    }
    if (submission.status === SorobanSubmissionStatus.DROPPED) {
      return {
        success: false,
        txHash: submission.txHash,
        status: submission.status,
        sequence: submission.sequence.toString(),
        error: `${submission.lastError}. Submit a newly signed transaction using the account's current sequence.`,
        dropped: true,
      };
    }
    if (submission.status === SorobanSubmissionStatus.FAILED) {
      return {
        success: false,
        txHash: submission.txHash,
        status: submission.status,
        sequence: submission.sequence.toString(),
        ledgerSeq: submission.ledgerSeq ?? undefined,
        error: submission.lastError ?? "Transaction failed on ledger",
      };
    }
    return {
      success: false,
      txHash: submission.txHash,
      status: submission.status,
      sequence: submission.sequence.toString(),
      error: submission.lastError ?? "Transaction is awaiting on-chain verification",
      pendingVerification: true,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class SorobanTransactionReplayDaemon {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;

  constructor(
    private readonly queue = new SorobanTransactionReplayQueue(),
    private readonly pollIntervalMs = Number(process.env.SOROBAN_REPLAY_POLL_MS) || 2_000
  ) {}

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  public stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;
    try {
      await this.queue.processDueSubmissions();
    } catch (error) {
      console.error("[soroban-replay] Failed to process pending submissions:", error);
    } finally {
      this.processing = false;
      this.schedule(this.pollIntervalMs);
    }
  }
}

export const sorobanTransactionReplayDaemon =
  new SorobanTransactionReplayDaemon();
