/**
 * Payment Dispute Resolution Workflow & Automated Escrow Freeze Service
 *
 * Implements Issue #364: Formal dispute lifecycle state machine and
 * automated smart contract escrow freeze mechanism.
 *
 * Financial and operational safety guarantees:
 * 1. Immediate Escrow Freeze: Filing a legitimate dispute automatically triggers
 *    an on-chain `freeze_league` call with a 32-byte cryptographic commitment to
 *    the dispute reason and evidence, halting all payouts, claims, and emergency refunds.
 * 2. Deterministic State Machine:
 *    OPEN -> UNDER_REVIEW -> RESOLVED_PAYOUT | RESOLVED_REFUND | REJECTED
 * 3. Atomic Resolution:
 *    - Payout resolution executes verified distribution via `resolve_dispute_payout`
 *      and atomically lifts the freeze.
 *    - Refund resolution returns full deposits via `resolve_dispute_refund` and lifts the freeze.
 *    - Rejection unfreezes the contract via `unfreeze_league` and preserves prior state.
 * 4. Audit Trail: All status transitions, evidence submissions, and tx hashes are tracked.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  SorobanContractClient,
  type WinnerPayoutParam,
  type InvocationResult,
} from "./sorobanContractClient.js";
import { toContractLeagueId } from "./contractLeagueId.js";

export enum DisputeStatus {
  OPEN = "OPEN",
  UNDER_REVIEW = "UNDER_REVIEW",
  RESOLVED_PAYOUT = "RESOLVED_PAYOUT",
  RESOLVED_REFUND = "RESOLVED_REFUND",
  REJECTED = "REJECTED",
}

export interface DisputeEvidence {
  id: string;
  submittedBy: string;
  submittedAt: Date;
  description: string;
  evidenceUrl?: string;
}

export interface DisputeRecord {
  id: string;
  leagueId: string;
  contractLeagueId: bigint;
  claimantAddress: string;
  reason: string;
  reasonHash: string; // 32-byte hexadecimal hash committed on-chain
  status: DisputeStatus;
  createdAt: Date;
  updatedAt: Date;
  freezeTxHash?: string;
  resolutionTxHash?: string;
  resolutionNotes?: string;
  evidence: DisputeEvidence[];
}

export interface FileDisputeParams {
  leagueId: string;
  claimantAddress: string;
  reason: string;
  evidenceUrl?: string;
  autoFreeze?: boolean;
}

export interface ResolveDisputePayoutParams {
  winners: WinnerPayoutParam[];
  platformTreasury: string;
  platformFeeStroops: bigint;
  notes?: string;
}

export interface ResolveDisputeRefundParams {
  participants: string[];
  notes?: string;
}

export interface DisputeServiceOptions {
  contractClient?: SorobanContractClient;
  adminSecret?: string;
  adminPublic?: string;
}

export class DisputeService extends EventEmitter {
  private contractClient: SorobanContractClient;
  private adminSecret: string;
  private adminPublic: string;
  private disputes: Map<string, DisputeRecord> = new Map();

  constructor(options?: DisputeServiceOptions) {
    super();
    this.contractClient =
      options?.contractClient ||
      (process.env.STELLAR_ESCROW_CONTRACT_ID
        ? new SorobanContractClient()
        : ({} as unknown as SorobanContractClient));
    this.adminSecret =
      options?.adminSecret || process.env.STELLAR_ESCROW_ADMIN_SECRET || "";
    this.adminPublic =
      options?.adminPublic || process.env.STELLAR_ESCROW_ADMIN_PUBLIC || "";
  }

  /**
   * Generates a deterministic 32-byte hash commitment for the dispute.
   * Time complexity: O(L) where L is length of inputs.
   */
  public static computeReasonHash(
    disputeId: string,
    leagueId: string,
    claimant: string,
    reason: string
  ): string {
    return crypto
      .createHash("sha256")
      .update(Buffer.from(`${disputeId}:${leagueId}:${claimant}:${reason}`, "utf8"))
      .digest("hex");
  }

  /**
   * Files a new payment dispute and automatically freezes the league on Soroban escrow.
   */
  public async fileDispute(params: FileDisputeParams): Promise<DisputeRecord> {
    const disputeId = crypto.randomUUID();
    const contractLeagueId = toContractLeagueId(params.leagueId);
    const reasonHash = DisputeService.computeReasonHash(
      disputeId,
      params.leagueId,
      params.claimantAddress,
      params.reason
    );

    const initialEvidence: DisputeEvidence[] = [];
    if (params.reason || params.evidenceUrl) {
      initialEvidence.push({
        id: crypto.randomUUID(),
        submittedBy: params.claimantAddress,
        submittedAt: new Date(),
        description: params.reason,
        evidenceUrl: params.evidenceUrl,
      });
    }

    const record: DisputeRecord = {
      id: disputeId,
      leagueId: params.leagueId,
      contractLeagueId,
      claimantAddress: params.claimantAddress,
      reason: params.reason,
      reasonHash,
      status: DisputeStatus.OPEN,
      createdAt: new Date(),
      updatedAt: new Date(),
      evidence: initialEvidence,
    };

    // Automated freeze on smart contract escrow
    if (params.autoFreeze !== false && this.adminSecret && this.adminPublic) {
      try {
        const freezeRes: InvocationResult = await this.contractClient.freezeLeague(
          this.adminSecret,
          this.adminPublic,
          contractLeagueId,
          reasonHash
        );
        if (freezeRes.success) {
          record.freezeTxHash = freezeRes.txHash;
          record.status = DisputeStatus.UNDER_REVIEW;
          this.emit("dispute:frozen", {
            disputeId,
            leagueId: params.leagueId,
            contractLeagueId: contractLeagueId.toString(),
            freezeTxHash: freezeRes.txHash,
          });
        } else {
          this.emit("dispute:freeze_failed", {
            disputeId,
            error: freezeRes.error,
          });
        }
      } catch (err) {
        this.emit("dispute:freeze_error", {
          disputeId,
          error: (err as Error).message,
        });
      }
    }

    this.disputes.set(disputeId, record);
    this.emit("dispute:filed", record);
    return record;
  }

  /**
   * Adds additional evidence or audit documentation to an open dispute.
   */
  public async addEvidence(
    disputeId: string,
    evidence: { submittedBy: string; description: string; evidenceUrl?: string }
  ): Promise<DisputeRecord> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (
      dispute.status !== DisputeStatus.OPEN &&
      dispute.status !== DisputeStatus.UNDER_REVIEW
    ) {
      throw new Error(
        `Cannot add evidence to dispute in status ${dispute.status}`
      );
    }

    const newEvidence: DisputeEvidence = {
      id: crypto.randomUUID(),
      submittedBy: evidence.submittedBy,
      submittedAt: new Date(),
      description: evidence.description,
      evidenceUrl: evidence.evidenceUrl,
    };

    dispute.evidence.push(newEvidence);
    dispute.updatedAt = new Date();
    this.emit("dispute:evidence_added", { disputeId, evidence: newEvidence });
    return dispute;
  }

  /**
   * Resolves the dispute via updated/corrected prize payout distributions.
   */
  public async resolveWithPayout(
    disputeId: string,
    params: ResolveDisputePayoutParams
  ): Promise<DisputeRecord> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (
      dispute.status !== DisputeStatus.OPEN &&
      dispute.status !== DisputeStatus.UNDER_REVIEW
    ) {
      throw new Error(
        `Cannot resolve dispute in status ${dispute.status}`
      );
    }

    if (!this.adminSecret || !this.adminPublic) {
      throw new Error("Admin credentials required to resolve dispute on-chain");
    }

    const res: InvocationResult = await this.contractClient.resolveDisputePayout(
      this.adminSecret,
      this.adminPublic,
      dispute.contractLeagueId,
      params.winners,
      params.platformTreasury,
      params.platformFeeStroops
    );

    if (!res.success) {
      throw new Error(`On-chain dispute payout failed: ${res.error}`);
    }

    dispute.status = DisputeStatus.RESOLVED_PAYOUT;
    dispute.resolutionTxHash = res.txHash;
    dispute.resolutionNotes = params.notes;
    dispute.updatedAt = new Date();

    this.emit("dispute:resolved_payout", {
      disputeId,
      txHash: res.txHash,
      notes: params.notes,
    });
    return dispute;
  }

  /**
   * Resolves the dispute by refunding all participants' deposits.
   */
  public async resolveWithRefund(
    disputeId: string,
    params: ResolveDisputeRefundParams
  ): Promise<DisputeRecord> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (
      dispute.status !== DisputeStatus.OPEN &&
      dispute.status !== DisputeStatus.UNDER_REVIEW
    ) {
      throw new Error(
        `Cannot resolve dispute in status ${dispute.status}`
      );
    }

    if (!this.adminSecret || !this.adminPublic) {
      throw new Error("Admin credentials required to refund dispute on-chain");
    }

    const res: InvocationResult = await this.contractClient.resolveDisputeRefund(
      this.adminSecret,
      this.adminPublic,
      dispute.contractLeagueId,
      params.participants
    );

    if (!res.success) {
      throw new Error(`On-chain dispute refund failed: ${res.error}`);
    }

    dispute.status = DisputeStatus.RESOLVED_REFUND;
    dispute.resolutionTxHash = res.txHash;
    dispute.resolutionNotes = params.notes;
    dispute.updatedAt = new Date();

    this.emit("dispute:resolved_refund", {
      disputeId,
      txHash: res.txHash,
      notes: params.notes,
    });
    return dispute;
  }

  /**
   * Rejects an unsubstantiated dispute and unfreezes the escrow contract.
   */
  public async rejectDispute(
    disputeId: string,
    notes: string
  ): Promise<DisputeRecord> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (
      dispute.status !== DisputeStatus.OPEN &&
      dispute.status !== DisputeStatus.UNDER_REVIEW
    ) {
      throw new Error(
        `Cannot reject dispute in status ${dispute.status}`
      );
    }

    // If league was previously frozen on-chain, lift the freeze
    if (dispute.freezeTxHash && this.adminSecret && this.adminPublic) {
      const unfreezeRes: InvocationResult = await this.contractClient.unfreezeLeague(
        this.adminSecret,
        this.adminPublic,
        dispute.contractLeagueId
      );
      if (!unfreezeRes.success) {
        throw new Error(`Failed to unfreeze league: ${unfreezeRes.error}`);
      }
    }

    dispute.status = DisputeStatus.REJECTED;
    dispute.resolutionNotes = notes;
    dispute.updatedAt = new Date();

    this.emit("dispute:rejected", { disputeId, notes });
    return dispute;
  }

  /**
   * Retrieves a dispute record by ID.
   * Time complexity: O(1).
   */
  public async getDispute(disputeId: string): Promise<DisputeRecord | null> {
    return this.disputes.get(disputeId) || null;
  }

  /**
   * Retrieves all disputes associated with a specific league.
   * Time complexity: O(N) where N is total disputes.
   */
  public async getDisputesForLeague(leagueId: string): Promise<DisputeRecord[]> {
    const results: DisputeRecord[] = [];
    for (const record of this.disputes.values()) {
      if (record.leagueId === leagueId) {
        results.push(record);
      }
    }
    return results;
  }
}

export const disputeService = new DisputeService();
