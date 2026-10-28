import {
  SorobanSubmissionStatus,
} from "@prisma/client";
import type {
  SorobanReplayStore,
  SorobanSubmissionRecord,
} from "../../services/financial/sorobanTransactionReplayQueue.js";

export class MemorySorobanReplayStore implements SorobanReplayStore {
  public readonly records = new Map<string, SorobanSubmissionRecord>();
  public readonly transitions: Array<{
    submissionId: string;
    fromStatus: SorobanSubmissionStatus | null;
    toStatus: SorobanSubmissionStatus;
    reason: string;
  }> = [];
  private nextId = 1;

  public async enqueue(input: {
    txHash: string;
    sourceAccount: string;
    sequence: bigint;
    signedEnvelope: string;
  }): Promise<SorobanSubmissionRecord> {
    const existing = await this.getByHash(input.txHash);
    if (existing) return existing;
    const record: SorobanSubmissionRecord = {
      id: String(this.nextId++),
      ...input,
      status: SorobanSubmissionStatus.PENDING_VERIFICATION,
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: new Date(0),
      lastPolledAt: null,
      ledgerSeq: null,
      lastError: null,
      leaseExpiresAt: null,
    };
    this.records.set(record.id, record);
    this.transitions.push({
      submissionId: record.id,
      fromStatus: null,
      toStatus: record.status,
      reason: "Persisted before transaction submission",
    });
    return record;
  }

  public async getById(id: string): Promise<SorobanSubmissionRecord | null> {
    return this.records.get(id) ?? null;
  }

  public async getByHash(txHash: string): Promise<SorobanSubmissionRecord | null> {
    return [...this.records.values()].find((record) => record.txHash === txHash) ?? null;
  }

  public async listDue(
    now: Date,
    limit: number
  ): Promise<SorobanSubmissionRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          (record.status === SorobanSubmissionStatus.PENDING_VERIFICATION ||
            record.status === SorobanSubmissionStatus.SUBMITTED) &&
          record.nextAttemptAt <= now &&
          (!record.leaseExpiresAt || record.leaseExpiresAt <= now)
      )
      .slice(0, limit);
  }

  public async claim(
    record: SorobanSubmissionRecord,
    now: Date,
    leaseUntil: Date
  ): Promise<boolean> {
    const current = this.records.get(record.id);
    if (
      !current ||
      current.status !== record.status ||
      current.nextAttemptAt > now ||
      (current.leaseExpiresAt && current.leaseExpiresAt > now)
    ) {
      return false;
    }
    current.leaseExpiresAt = leaseUntil;
    return true;
  }

  public async release(id: string): Promise<void> {
    const current = this.records.get(id);
    if (current) current.leaseExpiresAt = null;
  }

  public async update(
    id: string,
    status: SorobanSubmissionStatus,
    patch: Record<string, unknown>,
    reason: string
  ): Promise<SorobanSubmissionRecord | null> {
    const current = this.records.get(id);
    if (!current) return null;
    if (
      current.status === SorobanSubmissionStatus.SUCCESS ||
      current.status === SorobanSubmissionStatus.FAILED ||
      current.status === SorobanSubmissionStatus.DROPPED
    ) {
      return current;
    }

    const fromStatus = current.status;
    const auditRepeatedPendingError =
      status === SorobanSubmissionStatus.PENDING_VERIFICATION &&
      typeof patch.lastError === "string" &&
      patch.lastError !== current.lastError;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "attemptCount" && value && typeof value === "object" &&
          "increment" in value && typeof value.increment === "number") {
        current.attemptCount += value.increment;
      } else {
        Object.assign(current, { [key]: value });
      }
    }
    current.status = status;
    if (
      fromStatus !== status ||
      auditRepeatedPendingError
    ) {
      this.transitions.push({ submissionId: id, fromStatus, toStatus: status, reason });
    }
    return current;
  }
}
