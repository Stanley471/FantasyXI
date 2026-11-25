/**
 * Multi-Signature Smart Escrow Dispute Arbitration & Refund Service
 *
 * Implements Issue #419:
 * - 2-of-3 multi-signature authorization between league admins, platform
 *   arbitrators, and automated smart escrow contracts.
 * - LeagueEscrow state transitions: DISPUTED, ARBITRATION_PENDING, REFUNDED, SETTLED.
 * - Minimum threshold signature enforcement prior to Soroban RPC broadcast.
 * - Automated dispute timeout transitioning unreviewed disputes to proportional
 *   refund mode after a configurable lock window.
 * - Full audit trail with operator IDs, dispute reasons, and transaction hashes.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Keypair } from "@stellar/stellar-sdk";
import {
  SorobanContractClient,
  type InvocationResult,
} from "./sorobanContractClient.js";
import { toContractLeagueId } from "./contractLeagueId.js";

export enum LeagueEscrowState {
  ACTIVE = "ACTIVE",
  DISPUTED = "DISPUTED",
  ARBITRATION_PENDING = "ARBITRATION_PENDING",
  REFUNDED = "REFUNDED",
  SETTLED = "SETTLED",
}

export type ArbitrationRole =
  | "LEAGUE_ADMIN"
  | "PLATFORM_ARBITRATOR"
  | "SMART_ESCROW_CONTRACT";

export interface ParticipantDeposit {
  address: string;
  amountStroops: bigint;
}

export interface RefundSignature {
  signerPublicKey: string;
  signerSecret?: string;
  operatorId: string;
  role: ArbitrationRole;
  signatureHex: string;
  signedAt: Date;
}

export interface RefundProposal {
  id: string;
  onChainProposalId?: bigint;
  leagueId: string;
  contractLeagueId: bigint;
  reason: string;
  payloadDigestHex: string;
  participants: ParticipantDeposit[];
  threshold: number;
  requiredSigners: number;
  signatures: RefundSignature[];
  escrowState: LeagueEscrowState;
  proportionalMode: boolean;
  createdByOperatorId: string;
  createdAt: Date;
  lockWindowMs: number;
  expiresAt: Date;
  executedAt?: Date;
  txHash?: string;
}

export interface ArbitrationAuditEntry {
  id: string;
  timestamp: Date;
  leagueId: string;
  proposalId?: string;
  operatorId: string;
  action:
    | "PROPOSAL_INITIATED"
    | "SIGNATURE_COLLECTED"
    | "MULTISIG_REFUND_BROADCAST"
    | "TIMEOUT_PROPORTIONAL_REFUND"
    | "LEAGUE_SETTLED";
  fromState: LeagueEscrowState;
  toState: LeagueEscrowState;
  reason: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface ProposeRefundParams {
  leagueId: string;
  reason: string;
  participants: ParticipantDeposit[];
  operatorId: string;
  threshold?: number;
  lockWindowMs?: number;
  onChainProposalId?: bigint;
}

export interface SubmitSignatureParams {
  signerPublicKey: string;
  signerSecret?: string;
  operatorId: string;
  role: ArbitrationRole;
  signatureHex?: string;
}

export interface EscrowArbitrationOptions {
  contractClient?: SorobanContractClient;
  defaultThreshold?: number;
  defaultLockWindowMs?: number;
  serviceCallerSecret?: string;
  serviceCallerPublic?: string;
}

const DEFAULT_THRESHOLD = 2;
const DEFAULT_REQUIRED_SIGNERS = 3;
const DEFAULT_LOCK_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours

export class EscrowArbitrationService extends EventEmitter {
  private contractClient: SorobanContractClient;
  private defaultThreshold: number;
  private defaultLockWindowMs: number;
  private serviceCallerSecret: string;
  private serviceCallerPublic: string;
  private proposals: Map<string, RefundProposal> = new Map();
  private leagueStates: Map<string, LeagueEscrowState> = new Map();
  private auditTrail: ArbitrationAuditEntry[] = [];

  constructor(options?: EscrowArbitrationOptions) {
    super();
    this.contractClient =
      options?.contractClient ||
      (process.env.STELLAR_ESCROW_CONTRACT_ID
        ? new SorobanContractClient()
        : ({} as unknown as SorobanContractClient));
    this.defaultThreshold = options?.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.defaultLockWindowMs =
      options?.defaultLockWindowMs ?? DEFAULT_LOCK_WINDOW_MS;
    this.serviceCallerSecret =
      options?.serviceCallerSecret ||
      process.env.STELLAR_ESCROW_ADMIN_SECRET ||
      "";
    this.serviceCallerPublic =
      options?.serviceCallerPublic ||
      process.env.STELLAR_ESCROW_ADMIN_PUBLIC ||
      "";
  }

  public static computePayloadDigest(
    proposalId: string,
    leagueId: string,
    reason: string,
    participants: ParticipantDeposit[]
  ): Buffer {
    const canonicalParticipants = participants
      .map((p) => `${p.address}:${p.amountStroops.toString()}`)
      .sort()
      .join(",");
    return crypto
      .createHash("sha256")
      .update(
        Buffer.from(
          `${proposalId}|${leagueId}|${reason}|${canonicalParticipants}`,
          "utf8"
        )
      )
      .digest();
  }

  public getLeagueEscrowState(leagueId: string): LeagueEscrowState {
    return this.leagueStates.get(leagueId) ?? LeagueEscrowState.ACTIVE;
  }

  public initiateRefundProposal(
    params: ProposeRefundParams,
    now: Date = new Date()
  ): RefundProposal {
    const currentState = this.getLeagueEscrowState(params.leagueId);
    if (
      currentState === LeagueEscrowState.SETTLED ||
      currentState === LeagueEscrowState.REFUNDED
    ) {
      throw new Error(
        `Cannot initiate refund proposal for league in terminal state ${currentState}`
      );
    }
    if (!params.reason.trim()) {
      throw new Error("Dispute reason is required");
    }
    if (params.participants.length === 0) {
      throw new Error("At least one participant is required for a refund proposal");
    }

    const threshold = params.threshold ?? this.defaultThreshold;
    if (threshold < 1 || threshold > DEFAULT_REQUIRED_SIGNERS) {
      throw new Error(
        `Invalid multisig threshold ${threshold}; must be between 1 and ${DEFAULT_REQUIRED_SIGNERS}`
      );
    }

    const lockWindowMs = params.lockWindowMs ?? this.defaultLockWindowMs;
    if (lockWindowMs <= 0) {
      throw new Error("Lock window must be positive");
    }

    const proposalId = crypto.randomUUID();
    const contractLeagueId = toContractLeagueId(params.leagueId);
    const digest = EscrowArbitrationService.computePayloadDigest(
      proposalId,
      params.leagueId,
      params.reason,
      params.participants
    );

    const proposal: RefundProposal = {
      id: proposalId,
      onChainProposalId: params.onChainProposalId,
      leagueId: params.leagueId,
      contractLeagueId,
      reason: params.reason,
      payloadDigestHex: digest.toString("hex"),
      participants: params.participants,
      threshold,
      requiredSigners: DEFAULT_REQUIRED_SIGNERS,
      signatures: [],
      escrowState: LeagueEscrowState.DISPUTED,
      proportionalMode: false,
      createdByOperatorId: params.operatorId,
      createdAt: now,
      lockWindowMs,
      expiresAt: new Date(now.getTime() + lockWindowMs),
    };

    this.proposals.set(proposalId, proposal);
    this.leagueStates.set(params.leagueId, LeagueEscrowState.DISPUTED);

    this.recordAudit({
      leagueId: params.leagueId,
      proposalId,
      operatorId: params.operatorId,
      action: "PROPOSAL_INITIATED",
      fromState: currentState,
      toState: LeagueEscrowState.DISPUTED,
      reason: params.reason,
      metadata: {
        threshold,
        lockWindowMs,
        participantCount: params.participants.length,
      },
    });

    this.emit("arbitration:proposal_initiated", proposal);
    return proposal;
  }

  public collectSignature(
    proposalId: string,
    params: SubmitSignatureParams,
    now: Date = new Date()
  ): RefundProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Refund proposal ${proposalId} not found`);
    }
    if (
      proposal.escrowState === LeagueEscrowState.REFUNDED ||
      proposal.escrowState === LeagueEscrowState.SETTLED
    ) {
      throw new Error(
        `Cannot collect signature for proposal in terminal state ${proposal.escrowState}`
      );
    }

    if (
      proposal.signatures.some(
        (s) => s.signerPublicKey === params.signerPublicKey
      )
    ) {
      throw new Error(
        `Signer ${params.signerPublicKey} has already signed proposal ${proposalId}`
      );
    }

    const digest = Buffer.from(proposal.payloadDigestHex, "hex");
    let signatureHex: string;

    if (params.signerSecret) {
      const kp = Keypair.fromSecret(params.signerSecret);
      if (kp.publicKey() !== params.signerPublicKey) {
        throw new Error("Signer secret does not match provided public key");
      }
      signatureHex = kp.sign(digest).toString("hex");
    } else if (params.signatureHex) {
      const kp = Keypair.fromPublicKey(params.signerPublicKey);
      const sigBuf = Buffer.from(params.signatureHex, "hex");
      if (!kp.verify(digest, sigBuf)) {
        throw new Error(
          `Invalid cryptographic signature for signer ${params.signerPublicKey}`
        );
      }
      signatureHex = params.signatureHex;
    } else {
      throw new Error(
        "Either signatureHex or signerSecret must be provided to authorize refund proposal"
      );
    }

    const fromState = proposal.escrowState;
    proposal.signatures.push({
      signerPublicKey: params.signerPublicKey,
      signerSecret: params.signerSecret,
      operatorId: params.operatorId,
      role: params.role,
      signatureHex,
      signedAt: now,
    });

    proposal.escrowState = LeagueEscrowState.ARBITRATION_PENDING;
    this.leagueStates.set(
      proposal.leagueId,
      LeagueEscrowState.ARBITRATION_PENDING
    );

    this.recordAudit({
      leagueId: proposal.leagueId,
      proposalId,
      operatorId: params.operatorId,
      action: "SIGNATURE_COLLECTED",
      fromState,
      toState: LeagueEscrowState.ARBITRATION_PENDING,
      reason: proposal.reason,
      metadata: {
        signerPublicKey: params.signerPublicKey,
        role: params.role,
        collectedSignatures: proposal.signatures.length,
        threshold: proposal.threshold,
      },
    });

    this.emit("arbitration:signature_collected", {
      proposalId,
      signerPublicKey: params.signerPublicKey,
      role: params.role,
      count: proposal.signatures.length,
      threshold: proposal.threshold,
    });

    return proposal;
  }

  /**
   * Broadcasts the multi-signature refund transaction to Soroban RPC once the
   * minimum threshold of distinct cryptographic signatures has been collected.
   */
  public async broadcastRefundProposal(
    proposalId: string,
    operatorId: string,
    now: Date = new Date()
  ): Promise<RefundProposal> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Refund proposal ${proposalId} not found`);
    }
    if (proposal.escrowState === LeagueEscrowState.REFUNDED) {
      throw new Error(`Refund proposal ${proposalId} has already been executed`);
    }
    if (proposal.signatures.length < proposal.threshold) {
      throw new Error(
        `Insufficient signatures to broadcast refund proposal ${proposalId}: ${proposal.signatures.length} of ${proposal.threshold} required`
      );
    }

    const approverSecrets = proposal.signatures
      .map((s) => s.signerSecret)
      .filter((secret): secret is string => Boolean(secret));

    if (approverSecrets.length < proposal.threshold) {
      throw new Error(
        `Insufficient Soroban signing secrets for multisig assembly: ${approverSecrets.length} of ${proposal.threshold} required`
      );
    }

    const participantAddresses = proposal.participants.map((p) => p.address);
    const result: InvocationResult =
      await this.contractClient.refundWithMultisig(
        approverSecrets,
        proposal.contractLeagueId,
        participantAddresses,
        proposal.threshold
      );

    if (!result.success) {
      throw new Error(
        `On-chain multisig refund broadcast failed: ${result.error}`
      );
    }

    const fromState = proposal.escrowState;
    proposal.escrowState = LeagueEscrowState.REFUNDED;
    proposal.executedAt = now;
    proposal.txHash = result.txHash;
    this.leagueStates.set(proposal.leagueId, LeagueEscrowState.REFUNDED);

    this.recordAudit({
      leagueId: proposal.leagueId,
      proposalId,
      operatorId,
      action: "MULTISIG_REFUND_BROADCAST",
      fromState,
      toState: LeagueEscrowState.REFUNDED,
      reason: proposal.reason,
      txHash: result.txHash,
      metadata: {
        signerCount: proposal.signatures.length,
        threshold: proposal.threshold,
      },
    });

    this.emit("arbitration:refund_broadcast", proposal);
    return proposal;
  }

  /**
   * Automated dispute timeout processor: transitions unreviewed or under-signed
   * disputes whose configurable lock window has expired into proportional refund mode.
   */
  public async processExpiredDisputes(
    now: Date = new Date(),
    operatorId: string = "system:timeout-arbiter"
  ): Promise<RefundProposal[]> {
    const transitioned: RefundProposal[] = [];

    for (const proposal of this.proposals.values()) {
      const isPending =
        proposal.escrowState === LeagueEscrowState.DISPUTED ||
        proposal.escrowState === LeagueEscrowState.ARBITRATION_PENDING;

      if (!isPending || now.getTime() < proposal.expiresAt.getTime()) {
        continue;
      }

      const fromState = proposal.escrowState;
      let txHash: string | undefined;

      if (
        this.serviceCallerSecret &&
        this.serviceCallerPublic &&
        typeof this.contractClient.executeTimeoutProportionalRefund === "function"
      ) {
        const res = await this.contractClient.executeTimeoutProportionalRefund(
          this.serviceCallerSecret,
          this.serviceCallerPublic,
          proposal.contractLeagueId,
          proposal.onChainProposalId ?? 1n
        );
        if (!res.success) {
          throw new Error(
            `Automated timeout proportional refund failed for proposal ${proposal.id}: ${res.error}`
          );
        }
        txHash = res.txHash;
      }

      proposal.proportionalMode = true;
      proposal.escrowState = LeagueEscrowState.REFUNDED;
      proposal.executedAt = now;
      proposal.txHash = txHash;
      this.leagueStates.set(proposal.leagueId, LeagueEscrowState.REFUNDED);

      this.recordAudit({
        leagueId: proposal.leagueId,
        proposalId: proposal.id,
        operatorId,
        action: "TIMEOUT_PROPORTIONAL_REFUND",
        fromState,
        toState: LeagueEscrowState.REFUNDED,
        reason: `Consensus timeout after ${proposal.lockWindowMs}ms: ${proposal.reason}`,
        txHash,
        metadata: {
          collectedSignatures: proposal.signatures.length,
          threshold: proposal.threshold,
          proportionalMode: true,
        },
      });

      this.emit("arbitration:timeout_refunded", proposal);
      transitioned.push(proposal);
    }

    return transitioned;
  }

  public markLeagueSettled(
    leagueId: string,
    operatorId: string,
    txHash: string,
    reason: string = "League settlement finalized"
  ): void {
    const fromState = this.getLeagueEscrowState(leagueId);
    this.leagueStates.set(leagueId, LeagueEscrowState.SETTLED);
    this.recordAudit({
      leagueId,
      operatorId,
      action: "LEAGUE_SETTLED",
      fromState,
      toState: LeagueEscrowState.SETTLED,
      reason,
      txHash,
    });
  }

  public getProposal(proposalId: string): RefundProposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  public getProposalsForLeague(leagueId: string): RefundProposal[] {
    const result: RefundProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.leagueId === leagueId) {
        result.push(proposal);
      }
    }
    return result;
  }

  public getAuditTrail(leagueId?: string): ArbitrationAuditEntry[] {
    if (!leagueId) {
      return [...this.auditTrail];
    }
    return this.auditTrail.filter((entry) => entry.leagueId === leagueId);
  }

  private recordAudit(
    entry: Omit<ArbitrationAuditEntry, "id" | "timestamp">
  ): ArbitrationAuditEntry {
    const fullEntry: ArbitrationAuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...entry,
    };
    this.auditTrail.push(fullEntry);
    return fullEntry;
  }
}

export const escrowArbitrationService = new EscrowArbitrationService();
