import crypto from "crypto";
import { prisma as defaultPrisma } from "../../config/db.js";
import { StellarService, stellarService as defaultStellarService } from "./stellarService.js";
import {
  FinancialService,
  financialService as defaultFinancialService,
  FinancialValidationError,
  FinancialNotFoundError,
  FinancialForbiddenError,
  FinancialConflictError,
  SettlementDispatchReport,
  RefundDispatchReport,
} from "./financialService.js";
import {
  FinancialAuditRecorder,
  financialAuditLog as defaultFinancialAuditLog,
} from "../audit/financialAuditLog.js";
import {
  LeagueStatus,
  MembershipStatus,
  UserRole,
} from "../../types/index.js";

export enum DisputeStatus {
  OPEN = "OPEN",
  UNDER_REVIEW = "UNDER_REVIEW",
  RESOLVED_PAYOUT = "RESOLVED_PAYOUT",
  RESOLVED_REFUND = "RESOLVED_REFUND",
}

export type DisputeCategory =
  | "PAYOUT_ANOMALY"
  | "SCORING_ANOMALY"
  | "COLLUSION"
  | "OTHER";

export interface FileDisputeInput {
  leagueId: string;
  reporterId: string;
  category?: DisputeCategory | string;
  reason: string;
  evidence?: Record<string, unknown> | null;
}

export interface ReviewDisputeInput {
  adminUserId: string;
  justification?: string;
}

export interface ResolveDisputeInput {
  adminUserId: string;
  ruling: DisputeStatus.RESOLVED_PAYOUT | DisputeStatus.RESOLVED_REFUND | "RESOLVED_PAYOUT" | "RESOLVED_REFUND";
  justification: string;
  /** Optional basis points (1..10000) for proportional refund; defaults to 10000 (100% full refund) */
  refundProportionBps?: number;
}

export interface DisputeRulingLogRecord {
  id: string;
  disputeId: string;
  leagueId: string;
  actorId: string;
  actorRole: UserRole | string;
  fromStatus: DisputeStatus | null;
  toStatus: DisputeStatus;
  justification: string;
  evidenceSnapshot?: Record<string, unknown> | null;
  executionTxHash: string | null;
  entryHash: string;
  previousHash: string | null;
  createdAt: Date;
}

export interface PaymentDisputeRecord {
  id: string;
  leagueId: string;
  reporterId: string;
  category: string;
  reason: string;
  evidence: Record<string, unknown> | null;
  status: DisputeStatus;
  escrowFrozen: boolean;
  freezeTxHash: string | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  rulingJustification: string | null;
  resolutionTxHash: string | null;
  resolutionMetadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  rulingLogs?: DisputeRulingLogRecord[];
}

export interface DisputeResolutionOutcome {
  dispute: PaymentDisputeRecord;
  rulingLog: DisputeRulingLogRecord;
  settlementReport?: SettlementDispatchReport;
  refundReport?: RefundDispatchReport;
}

const ALLOWED_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  [DisputeStatus.OPEN]: [
    DisputeStatus.UNDER_REVIEW,
    DisputeStatus.RESOLVED_PAYOUT,
    DisputeStatus.RESOLVED_REFUND,
  ],
  [DisputeStatus.UNDER_REVIEW]: [
    DisputeStatus.RESOLVED_PAYOUT,
    DisputeStatus.RESOLVED_REFUND,
  ],
  [DisputeStatus.RESOLVED_PAYOUT]: [],
  [DisputeStatus.RESOLVED_REFUND]: [],
};

const VALID_CATEGORIES = new Set([
  "PAYOUT_ANOMALY",
  "SCORING_ANOMALY",
  "COLLUSION",
  "OTHER",
]);

export function computeRulingEntryHash(params: {
  disputeId: string;
  leagueId: string;
  actorId: string;
  actorRole: string;
  fromStatus: string | null;
  toStatus: string;
  justification: string;
  executionTxHash: string | null;
  previousHash: string | null;
  createdAtIso: string;
}): string {
  const canonical = JSON.stringify({
    disputeId: params.disputeId,
    leagueId: params.leagueId,
    actorId: params.actorId,
    actorRole: params.actorRole,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    justification: params.justification,
    executionTxHash: params.executionTxHash,
    previousHash: params.previousHash,
    createdAtIso: params.createdAtIso,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export class DisputeResolutionService {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = defaultPrisma,
    private readonly stellar: StellarService = defaultStellarService,
    private readonly financial: FinancialService = defaultFinancialService,
    private readonly audit: FinancialAuditRecorder = defaultFinancialAuditLog
  ) {}

  public static canTransition(from: DisputeStatus, to: DisputeStatus): boolean {
    return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
  }

  private assertValidTransition(from: DisputeStatus, to: DisputeStatus): void {
    if (!DisputeResolutionService.canTransition(from, to)) {
      throw new FinancialConflictError(
        `Invalid dispute state transition from '${from}' to '${to}'`
      );
    }
  }

  private async appendRulingLog(params: {
    disputeId: string;
    leagueId: string;
    actorId: string;
    actorRole: UserRole | string;
    fromStatus: DisputeStatus | null;
    toStatus: DisputeStatus;
    justification: string;
    evidenceSnapshot?: Record<string, unknown> | null;
    executionTxHash?: string | null;
  }): Promise<DisputeRulingLogRecord> {
    const existingLogs: DisputeRulingLogRecord[] = await this.db.disputeRulingLog.findMany({
      where: { disputeId: params.disputeId },
      orderBy: { createdAt: "asc" },
    });

    const previousHash =
      existingLogs.length > 0
        ? existingLogs[existingLogs.length - 1].entryHash
        : null;
    const createdAt = new Date();
    const entryHash = computeRulingEntryHash({
      disputeId: params.disputeId,
      leagueId: params.leagueId,
      actorId: params.actorId,
      actorRole: String(params.actorRole),
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      justification: params.justification,
      executionTxHash: params.executionTxHash ?? null,
      previousHash,
      createdAtIso: createdAt.toISOString(),
    });

    return this.db.disputeRulingLog.create({
      data: {
        disputeId: params.disputeId,
        leagueId: params.leagueId,
        actorId: params.actorId,
        actorRole: params.actorRole,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        justification: params.justification,
        evidenceSnapshot: params.evidenceSnapshot ?? null,
        executionTxHash: params.executionTxHash ?? null,
        entryHash,
        previousHash,
        createdAt,
      },
    });
  }

  /**
   * Raises a formal payment or scoring dispute and triggers an immediate automated
   * freeze on the target league's escrow pool.
   */
  public async fileDispute(input: FileDisputeInput): Promise<{
    dispute: PaymentDisputeRecord;
    rulingLog: DisputeRulingLogRecord;
  }> {
    if (!input.leagueId || typeof input.leagueId !== "string") {
      throw new FinancialValidationError("leagueId is required");
    }
    if (!input.reporterId || typeof input.reporterId !== "string") {
      throw new FinancialValidationError("reporterId is required");
    }
    const reason = (input.reason || "").trim();
    if (reason.length < 10) {
      throw new FinancialValidationError(
        "Dispute reason must be at least 10 characters long"
      );
    }

    const category = (input.category || "PAYOUT_ANOMALY").trim().toUpperCase();
    if (!VALID_CATEGORIES.has(category)) {
      throw new FinancialValidationError(
        `Invalid dispute category '${category}'. Allowed: ${Array.from(VALID_CATEGORIES).join(", ")}`
      );
    }

    const league = await this.db.league.findUnique({
      where: { id: input.leagueId },
      include: { members: true },
    });

    if (!league) {
      throw new FinancialNotFoundError(`League ${input.leagueId} not found`);
    }

    if (league.status === LeagueStatus.COMPLETED) {
      throw new FinancialConflictError(
        "Cannot file an escrow-freezing dispute after league funds have already been disbursed"
      );
    }
    if (league.status === LeagueStatus.CANCELLED) {
      throw new FinancialConflictError(
        "Cannot file a dispute on a cancelled league"
      );
    }

    const reporter = await this.db.user.findUnique({
      where: { id: input.reporterId },
    });
    if (!reporter) {
      throw new FinancialNotFoundError("Reporter user not found");
    }

    const isParticipant = (league.members || []).some(
      (m: any) =>
        m.userId === input.reporterId && m.status === MembershipStatus.ACTIVE
    );
    const isCreatorOrAdmin =
      league.creatorId === input.reporterId || reporter.role === UserRole.ADMIN;

    if (!isParticipant && !isCreatorOrAdmin) {
      throw new FinancialForbiddenError(
        "Only active league participants, the league creator, or administrators can file a dispute"
      );
    }

    // Invoke Soroban escrow contract freeze call to halt on-chain disbursements
    const contractLeagueId = FinancialService.toContractLeagueId(league.id);
    let freezeTxHash: string | null = null;

    if (typeof (this.stellar as any).freezeLeagueEscrow === "function") {
      const freezeResult = await this.stellar.freezeLeagueEscrow(
        contractLeagueId,
        reason
      );
      if (!freezeResult.success) {
        throw new FinancialConflictError(
          `Automated contract escrow freeze failed: ${freezeResult.error || "Unknown contract error"}`
        );
      }
      freezeTxHash = freezeResult.txHash ?? null;
    }

    await this.db.league.update({
      where: { id: league.id },
      data: { escrowFrozen: true },
    });

    const dispute: PaymentDisputeRecord = await this.db.paymentDispute.create({
      data: {
        leagueId: league.id,
        reporterId: input.reporterId,
        category,
        reason,
        evidence: input.evidence ?? null,
        status: DisputeStatus.OPEN,
        escrowFrozen: true,
        freezeTxHash,
      },
    });

    const rulingLog = await this.appendRulingLog({
      disputeId: dispute.id,
      leagueId: league.id,
      actorId: input.reporterId,
      actorRole: reporter.role ?? UserRole.USER,
      fromStatus: null,
      toStatus: DisputeStatus.OPEN,
      justification: `Dispute filed (${category}): ${reason}`,
      evidenceSnapshot: input.evidence ?? null,
      executionTxHash: freezeTxHash,
    });

    this.audit.record({
      action: "ESCROW_FROZEN" as any,
      userId: input.reporterId,
      actorId: input.reporterId,
      leagueId: league.id,
      stellarTxHash: freezeTxHash,
      metadata: {
        disputeId: dispute.id,
        category,
        reason,
      },
    });

    this.audit.record({
      action: "DISPUTE_OPENED" as any,
      userId: input.reporterId,
      actorId: input.reporterId,
      leagueId: league.id,
      stellarTxHash: freezeTxHash,
      metadata: {
        disputeId: dispute.id,
        category,
        rulingLogHash: rulingLog.entryHash,
      },
    });

    return { dispute, rulingLog };
  }

  /**
   * Transitions an OPEN dispute to UNDER_REVIEW while maintaining the escrow freeze.
   */
  public async markUnderReview(
    disputeId: string,
    input: ReviewDisputeInput
  ): Promise<{
    dispute: PaymentDisputeRecord;
    rulingLog: DisputeRulingLogRecord;
  }> {
    const admin = await this.db.user.findUnique({
      where: { id: input.adminUserId },
    });
    if (
      !admin ||
      (admin.role !== UserRole.ADMIN && admin.role !== UserRole.MODERATOR)
    ) {
      throw new FinancialForbiddenError(
        "Only an administrator or moderator can place a dispute under review"
      );
    }

    const dispute: PaymentDisputeRecord | null =
      await this.db.paymentDispute.findUnique({
        where: { id: disputeId },
      });
    if (!dispute) {
      throw new FinancialNotFoundError(`Dispute ${disputeId} not found`);
    }

    this.assertValidTransition(dispute.status, DisputeStatus.UNDER_REVIEW);

    const justification =
      (input.justification || "").trim() ||
      "Dispute claimed for administrative review; escrow freeze remains active.";

    const reviewedAt = new Date();
    const updated: PaymentDisputeRecord = await this.db.paymentDispute.update({
      where: { id: dispute.id },
      data: {
        status: DisputeStatus.UNDER_REVIEW,
        reviewedById: input.adminUserId,
        reviewedAt,
      },
    });

    const rulingLog = await this.appendRulingLog({
      disputeId: dispute.id,
      leagueId: dispute.leagueId,
      actorId: input.adminUserId,
      actorRole: admin.role,
      fromStatus: dispute.status,
      toStatus: DisputeStatus.UNDER_REVIEW,
      justification,
      evidenceSnapshot: dispute.evidence,
    });

    this.audit.record({
      action: "DISPUTE_UNDER_REVIEW" as any,
      userId: dispute.reporterId,
      actorId: input.adminUserId,
      leagueId: dispute.leagueId,
      metadata: {
        disputeId: dispute.id,
        justification,
        rulingLogHash: rulingLog.entryHash,
      },
    });

    return { dispute: updated, rulingLog };
  }

  /**
   * Submits an administrative ruling (RESOLVED_PAYOUT or RESOLVED_REFUND),
   * records an immutable hash-chained ruling log, lifts the contract escrow freeze,
   * and triggers either standard payout settlement or participant refunds.
   */
  public async resolveDispute(
    disputeId: string,
    input: ResolveDisputeInput
  ): Promise<DisputeResolutionOutcome> {
    const admin = await this.db.user.findUnique({
      where: { id: input.adminUserId },
    });
    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new FinancialForbiddenError(
        "Only an administrator can issue a final dispute ruling"
      );
    }

    const justification = (input.justification || "").trim();
    if (justification.length < 10) {
      throw new FinancialValidationError(
        "Admin ruling justification must be at least 10 characters long"
      );
    }

    if (
      input.ruling !== DisputeStatus.RESOLVED_PAYOUT &&
      input.ruling !== DisputeStatus.RESOLVED_REFUND
    ) {
      throw new FinancialValidationError(
        "Ruling must be either RESOLVED_PAYOUT or RESOLVED_REFUND"
      );
    }

    const targetStatus = input.ruling as DisputeStatus;

    const dispute: PaymentDisputeRecord | null =
      await this.db.paymentDispute.findUnique({
        where: { id: disputeId },
      });
    if (!dispute) {
      throw new FinancialNotFoundError(`Dispute ${disputeId} not found`);
    }

    this.assertValidTransition(dispute.status, targetStatus);

    const league = await this.db.league.findUnique({
      where: { id: dispute.leagueId },
      include: { members: true, endGameweek: true },
    });
    if (!league) {
      throw new FinancialNotFoundError(`League ${dispute.leagueId} not found`);
    }

    const contractLeagueId = FinancialService.toContractLeagueId(league.id);

    if (targetStatus === DisputeStatus.RESOLVED_PAYOUT) {
      // Ensure no other open/under-review disputes exist on the same league before unfreezing & paying out
      const otherOpenDisputes: PaymentDisputeRecord[] =
        await this.db.paymentDispute.findMany({
          where: {
            leagueId: league.id,
            status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
          },
        });
      const remainingOpen = otherOpenDisputes.filter((d) => d.id !== dispute.id);
      if (remainingOpen.length > 0) {
        throw new FinancialConflictError(
          `Cannot execute RESOLVED_PAYOUT while ${remainingOpen.length} other dispute(s) on league ${league.id} remain unresolved`
        );
      }

      if (typeof (this.stellar as any).unfreezeLeagueEscrow === "function") {
        const unfreezeRes = await this.stellar.unfreezeLeagueEscrow(
          contractLeagueId
        );
        if (!unfreezeRes.success) {
          throw new FinancialConflictError(
            `Failed to unfreeze league escrow on-chain: ${unfreezeRes.error || "Unknown contract error"}`
          );
        }
      }

      // Mark dispute resolved and unfreeze league prior to settlement execution
      const resolvedAt = new Date();
      await this.db.league.update({
        where: { id: league.id },
        data: { escrowFrozen: false },
      });

      let updatedDispute: PaymentDisputeRecord =
        await this.db.paymentDispute.update({
          where: { id: dispute.id },
          data: {
            status: DisputeStatus.RESOLVED_PAYOUT,
            escrowFrozen: false,
            resolvedById: input.adminUserId,
            resolvedAt,
            rulingJustification: justification,
          },
        });

      const settlementReport = await this.financial.executeSettlement(
        league.id,
        input.adminUserId
      );

      updatedDispute = await this.db.paymentDispute.update({
        where: { id: dispute.id },
        data: {
          resolutionTxHash: settlementReport.stellarTxHash,
          resolutionMetadata: {
            winnerTransactionCount: settlementReport.winnerTransactionCount,
            platformFee: settlementReport.platformFee,
            ledgerSeq: settlementReport.ledgerSeq ?? null,
          },
        },
      });

      const rulingLog = await this.appendRulingLog({
        disputeId: dispute.id,
        leagueId: league.id,
        actorId: input.adminUserId,
        actorRole: admin.role,
        fromStatus: dispute.status,
        toStatus: DisputeStatus.RESOLVED_PAYOUT,
        justification,
        evidenceSnapshot: dispute.evidence,
        executionTxHash: settlementReport.stellarTxHash,
      });

      this.audit.record({
        action: "ESCROW_UNFROZEN" as any,
        userId: dispute.reporterId,
        actorId: input.adminUserId,
        leagueId: league.id,
        stellarTxHash: settlementReport.stellarTxHash,
        metadata: { disputeId: dispute.id, ruling: DisputeStatus.RESOLVED_PAYOUT },
      });

      this.audit.record({
        action: "DISPUTE_RESOLVED_PAYOUT" as any,
        userId: dispute.reporterId,
        actorId: input.adminUserId,
        leagueId: league.id,
        stellarTxHash: settlementReport.stellarTxHash,
        metadata: {
          disputeId: dispute.id,
          justification,
          rulingLogHash: rulingLog.entryHash,
        },
      });

      return {
        dispute: updatedDispute,
        rulingLog,
        settlementReport,
      };
    }

    // RESOLVED_REFUND branch: unfreeze on-chain, transition league to CANCELLED, and execute refunds
    const refundProportionBps = input.refundProportionBps ?? 10_000;
    if (
      !Number.isInteger(refundProportionBps) ||
      refundProportionBps <= 0 ||
      refundProportionBps > 10_000
    ) {
      throw new FinancialValidationError(
        "refundProportionBps must be an integer between 1 and 10000"
      );
    }

    if (typeof (this.stellar as any).unfreezeLeagueEscrow === "function") {
      const unfreezeRes = await this.stellar.unfreezeLeagueEscrow(
        contractLeagueId
      );
      if (!unfreezeRes.success) {
        throw new FinancialConflictError(
          `Failed to unfreeze league escrow on-chain: ${unfreezeRes.error || "Unknown contract error"}`
        );
      }
    }

    const effectiveEntryFee =
      refundProportionBps === 10_000
        ? Number(league.entryFee)
        : Math.floor(Number(league.entryFee) * refundProportionBps) / 10_000;

    await this.db.league.update({
      where: { id: league.id },
      data: {
        status: LeagueStatus.CANCELLED,
        escrowFrozen: false,
        entryFee: effectiveEntryFee,
      },
    });

    const refundReport = await this.financial.processLeagueRefunds(league.id);
    const resolvedAt = new Date();

    const updatedDispute: PaymentDisputeRecord =
      await this.db.paymentDispute.update({
        where: { id: dispute.id },
        data: {
          status: DisputeStatus.RESOLVED_REFUND,
          escrowFrozen: false,
          resolvedById: input.adminUserId,
          resolvedAt,
          rulingJustification: justification,
          resolutionMetadata: {
            refundProportionBps,
            refundedAmountPerMember: effectiveEntryFee,
            refundedMemberIds: refundReport.refundedMemberIds,
            batches: refundReport.batches,
          },
        },
      });

    const rulingLog = await this.appendRulingLog({
      disputeId: dispute.id,
      leagueId: league.id,
      actorId: input.adminUserId,
      actorRole: admin.role,
      fromStatus: dispute.status,
      toStatus: DisputeStatus.RESOLVED_REFUND,
      justification,
      evidenceSnapshot: dispute.evidence,
      executionTxHash: null,
    });

    this.audit.record({
      action: "ESCROW_UNFROZEN" as any,
      userId: dispute.reporterId,
      actorId: input.adminUserId,
      leagueId: league.id,
      metadata: { disputeId: dispute.id, ruling: DisputeStatus.RESOLVED_REFUND },
    });

    this.audit.record({
      action: "DISPUTE_RESOLVED_REFUND" as any,
      userId: dispute.reporterId,
      actorId: input.adminUserId,
      leagueId: league.id,
      amount: effectiveEntryFee,
      metadata: {
        disputeId: dispute.id,
        justification,
        refundProportionBps,
        refundedMemberCount: refundReport.refundedMemberIds.length,
        rulingLogHash: rulingLog.entryHash,
      },
    });

    return {
      dispute: updatedDispute,
      rulingLog,
      refundReport,
    };
  }

  /**
   * Lists disputes for administrative dashboard review.
   */
  public async listDisputes(filter?: {
    leagueId?: string;
    status?: DisputeStatus;
  }): Promise<PaymentDisputeRecord[]> {
    const where: Record<string, unknown> = {};
    if (filter?.leagueId) where.leagueId = filter.leagueId;
    if (filter?.status) where.status = filter.status;

    return this.db.paymentDispute.findMany({
      where,
      include: { rulingLogs: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Retrieves a single dispute along with its immutable ruling logs.
   */
  public async getDisputeById(disputeId: string): Promise<PaymentDisputeRecord> {
    const dispute = await this.db.paymentDispute.findUnique({
      where: { id: disputeId },
      include: { rulingLogs: { orderBy: { createdAt: "asc" } } },
    });
    if (!dispute) {
      throw new FinancialNotFoundError(`Dispute ${disputeId} not found`);
    }
    return dispute;
  }

  /**
   * Verifies the cryptographic SHA-256 hash chain of all ruling logs for a dispute.
   */
  public async verifyRulingLogIntegrity(disputeId: string): Promise<{
    valid: boolean;
    entryCount: number;
    tamperedEntryId?: string;
  }> {
    const logs: DisputeRulingLogRecord[] = await this.db.disputeRulingLog.findMany({
      where: { disputeId },
      orderBy: { createdAt: "asc" },
    });

    let expectedPreviousHash: string | null = null;
    for (const entry of logs) {
      if (entry.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          entryCount: logs.length,
          tamperedEntryId: entry.id,
        };
      }

      const recomputed = computeRulingEntryHash({
        disputeId: entry.disputeId,
        leagueId: entry.leagueId,
        actorId: entry.actorId,
        actorRole: String(entry.actorRole),
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        justification: entry.justification,
        executionTxHash: entry.executionTxHash ?? null,
        previousHash: entry.previousHash ?? null,
        createdAtIso: new Date(entry.createdAt).toISOString(),
      });

      if (recomputed !== entry.entryHash) {
        return {
          valid: false,
          entryCount: logs.length,
          tamperedEntryId: entry.id,
        };
      }

      expectedPreviousHash = entry.entryHash;
    }

    return {
      valid: true,
      entryCount: logs.length,
    };
  }
}

export const disputeResolutionService = new DisputeResolutionService();
export default disputeResolutionService;
