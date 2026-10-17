import crypto from "crypto";

export type TreasuryProposalStatus =
  | "PENDING_APPROVALS"
  | "TIMELOCK_QUEUED"
  | "EXECUTED"
  | "CANCELLED";

export interface TreasurySignerApproval {
  signerId: string;
  publicKeyPem: string;
  signatureBase64: string;
  approvedAtMs: number;
}

export interface TreasuryWithdrawalProposal {
  proposalId: string;
  destinationAddress: string;
  assetCode: string;
  amount: number;
  reason: string;
  proposerId: string;
  requiredSignatures: number;
  status: TreasuryProposalStatus;
  approvals: TreasurySignerApproval[];
  createdAtMs: number;
  quorumReachedAtMs: number | null;
  timelockExpiresAtMs: number | null;
  executedAtMs: number | null;
  executedTxHash: string | null;
  cancelledAtMs: number | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
}

export interface TreasuryAuditLogEntry {
  entryId: string;
  proposalId: string;
  action:
    | "PROPOSED"
    | "APPROVED"
    | "QUORUM_REACHED_TIMELOCK_STARTED"
    | "CANCELLED"
    | "EXECUTED";
  actorId: string;
  timestampMs: number;
  previousHash: string;
  entryHash: string;
  metadata: Record<string, unknown>;
}

export class TreasurySecurityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "UNAUTHORIZED_SIGNER"
      | "INVALID_SIGNATURE"
      | "DUPLICATE_APPROVAL"
      | "QUORUM_NOT_MET"
      | "TIMELOCK_ACTIVE"
      | "INVALID_PROPOSAL_STATE"
      | "PROPOSAL_NOT_FOUND"
  ) {
    super(message);
    this.name = "TreasurySecurityError";
  }
}

export const DEFAULT_TIMELOCK_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours

export class TreasuryTimelockService {
  private readonly authorizedSigners = new Map<string, string>(); // signerId -> Ed25519 publicKeyPem
  private readonly requiredSignatures: number;
  private readonly timelockDurationMs: number;
  private readonly proposals = new Map<string, TreasuryWithdrawalProposal>();
  private readonly auditChain: TreasuryAuditLogEntry[] = [];

  constructor(config: {
    authorizedSigners: Record<string, string>;
    requiredSignatures: number;
    timelockDurationMs?: number;
  }) {
    for (const [signerId, pubKeyPem] of Object.entries(config.authorizedSigners)) {
      this.authorizedSigners.set(signerId, pubKeyPem);
    }

    if (
      config.requiredSignatures < 1 ||
      config.requiredSignatures > this.authorizedSigners.size
    ) {
      throw new Error(
        `Invalid M-of-N quorum: requiredSignatures (${config.requiredSignatures}) must be between 1 and ${this.authorizedSigners.size}`
      );
    }

    this.requiredSignatures = config.requiredSignatures;
    this.timelockDurationMs =
      config.timelockDurationMs ?? DEFAULT_TIMELOCK_DURATION_MS;
  }

  /**
   * Canonical message payload that each M-of-N admin signer must sign with their Ed25519 private key.
   */
  public static buildSigningPayload(params: {
    proposalId: string;
    destinationAddress: string;
    assetCode: string;
    amount: number;
  }): Buffer {
    const canonical = `TREASURY_WITHDRAW:${params.proposalId}:${params.destinationAddress}:${params.assetCode}:${params.amount.toFixed(7)}`;
    return Buffer.from(canonical, "utf8");
  }

  /**
   * Helper to sign a proposal payload with an Ed25519 private key PEM.
   */
  public static signProposalPayload(
    proposal: Pick<
      TreasuryWithdrawalProposal,
      "proposalId" | "destinationAddress" | "assetCode" | "amount"
    >,
    privateKeyPem: string
  ): string {
    const payload = TreasuryTimelockService.buildSigningPayload(proposal);
    const privKey = crypto.createPrivateKey(privateKeyPem);
    return crypto.sign(null, payload, privKey).toString("base64");
  }

  /**
   * Creates a new treasury withdrawal proposal in PENDING_APPROVALS state.
   */
  public createProposal(params: {
    proposerId: string;
    destinationAddress: string;
    assetCode: string;
    amount: number;
    reason: string;
    nowMs?: number;
  }): TreasuryWithdrawalProposal {
    if (!this.authorizedSigners.has(params.proposerId)) {
      throw new TreasurySecurityError(
        `Proposer ${params.proposerId} is not an authorized treasury signer`,
        "UNAUTHORIZED_SIGNER"
      );
    }

    if (!params.destinationAddress || params.amount <= 0) {
      throw new TreasurySecurityError(
        "Valid destinationAddress and positive amount are required",
        "INVALID_PROPOSAL_STATE"
      );
    }

    const nowMs = params.nowMs ?? Date.now();
    const proposal: TreasuryWithdrawalProposal = {
      proposalId: crypto.randomUUID(),
      destinationAddress: params.destinationAddress,
      assetCode: params.assetCode,
      amount: params.amount,
      reason: params.reason,
      proposerId: params.proposerId,
      requiredSignatures: this.requiredSignatures,
      status: "PENDING_APPROVALS",
      approvals: [],
      createdAtMs: nowMs,
      quorumReachedAtMs: null,
      timelockExpiresAtMs: null,
      executedAtMs: null,
      executedTxHash: null,
      cancelledAtMs: null,
      cancelledBy: null,
      cancellationReason: null,
    };

    this.proposals.set(proposal.proposalId, proposal);
    this.appendAuditEntry({
      proposalId: proposal.proposalId,
      action: "PROPOSED",
      actorId: params.proposerId,
      timestampMs: nowMs,
      metadata: {
        destinationAddress: proposal.destinationAddress,
        assetCode: proposal.assetCode,
        amount: proposal.amount,
      },
    });

    return structuredClone(proposal);
  }

  /**
   * Verifies an authorized admin's Ed25519 signature over the canonical withdrawal payload.
   * Automatically starts the 48-hour timelock countdown once M-of-N signatures are collected.
   */
  public approveProposal(params: {
    proposalId: string;
    signerId: string;
    signatureBase64: string;
    nowMs?: number;
  }): TreasuryWithdrawalProposal {
    const nowMs = params.nowMs ?? Date.now();
    const proposal = this.proposals.get(params.proposalId);
    if (!proposal) {
      throw new TreasurySecurityError(
        `Proposal ${params.proposalId} not found`,
        "PROPOSAL_NOT_FOUND"
      );
    }

    if (proposal.status !== "PENDING_APPROVALS") {
      throw new TreasurySecurityError(
        `Cannot approve proposal in state ${proposal.status}`,
        "INVALID_PROPOSAL_STATE"
      );
    }

    const publicKeyPem = this.authorizedSigners.get(params.signerId);
    if (!publicKeyPem) {
      throw new TreasurySecurityError(
        `Signer ${params.signerId} is not an authorized treasury signer`,
        "UNAUTHORIZED_SIGNER"
      );
    }

    if (proposal.approvals.some((a) => a.signerId === params.signerId)) {
      throw new TreasurySecurityError(
        `Signer ${params.signerId} has already approved this proposal`,
        "DUPLICATE_APPROVAL"
      );
    }

    const payload = TreasuryTimelockService.buildSigningPayload(proposal);
    const pubKey = crypto.createPublicKey(publicKeyPem);
    const sigBuffer = Buffer.from(params.signatureBase64, "base64");
    const isValid = crypto.verify(null, payload, pubKey, sigBuffer);

    if (!isValid) {
      throw new TreasurySecurityError(
        `Invalid Ed25519 signature from signer ${params.signerId}`,
        "INVALID_SIGNATURE"
      );
    }

    proposal.approvals.push({
      signerId: params.signerId,
      publicKeyPem,
      signatureBase64: params.signatureBase64,
      approvedAtMs: nowMs,
    });

    this.appendAuditEntry({
      proposalId: proposal.proposalId,
      action: "APPROVED",
      actorId: params.signerId,
      timestampMs: nowMs,
      metadata: {
        currentApprovals: proposal.approvals.length,
        requiredSignatures: proposal.requiredSignatures,
      },
    });

    if (proposal.approvals.length >= proposal.requiredSignatures) {
      proposal.status = "TIMELOCK_QUEUED";
      proposal.quorumReachedAtMs = nowMs;
      proposal.timelockExpiresAtMs = nowMs + this.timelockDurationMs;

      this.appendAuditEntry({
        proposalId: proposal.proposalId,
        action: "QUORUM_REACHED_TIMELOCK_STARTED",
        actorId: params.signerId,
        timestampMs: nowMs,
        metadata: {
          timelockExpiresAtMs: proposal.timelockExpiresAtMs,
        },
      });
    }

    return structuredClone(proposal);
  }

  /**
   * Allows any authorized treasury admin to emergency-cancel a pending or timelock-queued
   * withdrawal proposal before execution.
   */
  public cancelProposal(params: {
    proposalId: string;
    actorId: string;
    reason: string;
    nowMs?: number;
  }): TreasuryWithdrawalProposal {
    const nowMs = params.nowMs ?? Date.now();
    const proposal = this.proposals.get(params.proposalId);
    if (!proposal) {
      throw new TreasurySecurityError(
        `Proposal ${params.proposalId} not found`,
        "PROPOSAL_NOT_FOUND"
      );
    }

    if (!this.authorizedSigners.has(params.actorId)) {
      throw new TreasurySecurityError(
        `Actor ${params.actorId} is not authorized to cancel treasury proposals`,
        "UNAUTHORIZED_SIGNER"
      );
    }

    if (
      proposal.status !== "PENDING_APPROVALS" &&
      proposal.status !== "TIMELOCK_QUEUED"
    ) {
      throw new TreasurySecurityError(
        `Cannot cancel proposal in state ${proposal.status}`,
        "INVALID_PROPOSAL_STATE"
      );
    }

    proposal.status = "CANCELLED";
    proposal.cancelledAtMs = nowMs;
    proposal.cancelledBy = params.actorId;
    proposal.cancellationReason = params.reason;

    this.appendAuditEntry({
      proposalId: proposal.proposalId,
      action: "CANCELLED",
      actorId: params.actorId,
      timestampMs: nowMs,
      metadata: { reason: params.reason },
    });

    return structuredClone(proposal);
  }

  /**
   * Executes a queued treasury withdrawal proposal only after both:
   * 1. M-of-N cryptographic approvals have been verified (`TIMELOCK_QUEUED`), AND
   * 2. The mandatory 48-hour timelock window has elapsed (`nowMs >= timelockExpiresAtMs`).
   */
  public executeProposal(params: {
    proposalId: string;
    executorId: string;
    nowMs?: number;
  }): TreasuryWithdrawalProposal {
    const nowMs = params.nowMs ?? Date.now();
    const proposal = this.proposals.get(params.proposalId);
    if (!proposal) {
      throw new TreasurySecurityError(
        `Proposal ${params.proposalId} not found`,
        "PROPOSAL_NOT_FOUND"
      );
    }

    if (!this.authorizedSigners.has(params.executorId)) {
      throw new TreasurySecurityError(
        `Executor ${params.executorId} is not an authorized treasury signer`,
        "UNAUTHORIZED_SIGNER"
      );
    }

    if (proposal.status === "PENDING_APPROVALS") {
      throw new TreasurySecurityError(
        `Proposal has only ${proposal.approvals.length}/${proposal.requiredSignatures} signatures`,
        "QUORUM_NOT_MET"
      );
    }

    if (proposal.status !== "TIMELOCK_QUEUED") {
      throw new TreasurySecurityError(
        `Proposal cannot be executed from state ${proposal.status}`,
        "INVALID_PROPOSAL_STATE"
      );
    }

    if (
      proposal.timelockExpiresAtMs === null ||
      nowMs < proposal.timelockExpiresAtMs
    ) {
      const remainingSeconds = Math.ceil(
        ((proposal.timelockExpiresAtMs ?? nowMs) - nowMs) / 1000
      );
      throw new TreasurySecurityError(
        `Treasury timelock is still active (${remainingSeconds}s remaining)`,
        "TIMELOCK_ACTIVE"
      );
    }

    proposal.status = "EXECUTED";
    proposal.executedAtMs = nowMs;
    proposal.executedTxHash = `stellar_tx_${crypto
      .createHash("sha256")
      .update(`${proposal.proposalId}:${nowMs}`)
      .digest("hex")
      .slice(0, 32)}`;

    this.appendAuditEntry({
      proposalId: proposal.proposalId,
      action: "EXECUTED",
      actorId: params.executorId,
      timestampMs: nowMs,
      metadata: {
        executedTxHash: proposal.executedTxHash,
        amount: proposal.amount,
        destinationAddress: proposal.destinationAddress,
      },
    });

    return structuredClone(proposal);
  }

  /**
   * Verifies the integrity of the hash-chained treasury audit log.
   */
  public verifyAuditChainIntegrity(): boolean {
    let expectedPrevHash = "GENESIS";
    for (const entry of this.auditChain) {
      if (entry.previousHash !== expectedPrevHash) {
        return false;
      }
      const recomputed = this.computeAuditEntryHash({
        entryId: entry.entryId,
        proposalId: entry.proposalId,
        action: entry.action,
        actorId: entry.actorId,
        timestampMs: entry.timestampMs,
        previousHash: entry.previousHash,
        metadata: entry.metadata,
      });
      if (recomputed !== entry.entryHash) {
        return false;
      }
      expectedPrevHash = entry.entryHash;
    }
    return true;
  }

  public getAuditChain(): ReadonlyArray<TreasuryAuditLogEntry> {
    return this.auditChain;
  }

  private appendAuditEntry(params: {
    proposalId: string;
    action: TreasuryAuditLogEntry["action"];
    actorId: string;
    timestampMs: number;
    metadata: Record<string, unknown>;
  }): void {
    const entryId = crypto.randomUUID();
    const previousHash =
      this.auditChain.length > 0
        ? this.auditChain[this.auditChain.length - 1].entryHash
        : "GENESIS";

    const entryHash = this.computeAuditEntryHash({
      entryId,
      proposalId: params.proposalId,
      action: params.action,
      actorId: params.actorId,
      timestampMs: params.timestampMs,
      previousHash,
      metadata: params.metadata,
    });

    this.auditChain.push({
      entryId,
      proposalId: params.proposalId,
      action: params.action,
      actorId: params.actorId,
      timestampMs: params.timestampMs,
      previousHash,
      metadata: params.metadata,
      entryHash,
    });
  }

  private computeAuditEntryHash(
    data: Omit<TreasuryAuditLogEntry, "entryHash">
  ): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
  }
}
