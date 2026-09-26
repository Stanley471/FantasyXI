/**
 * Financial Service — Escrow State Machine & Financial Accounting
 *
 * Laravel analogy: Like an EscrowManager service that handles payment intents,
 * payment confirmations, idempotency, prize settlement plans, and ledger reconciliation.
 *
 * Separation of concerns:
 * - Does NOT perform HTTP requests to Stellar directly (delegates to StellarService).
 * - Manages database transitions between PENDING -> PAYMENT_INITIATED -> PAYMENT_SUBMITTED -> PAYMENT_CONFIRMED.
 * - Enforces zero lost cents via PrizeService.
 */

import { prisma } from "../../config/db.js";
import { stellarConfig } from "../../config/stellar.js";
import { StellarService, stellarService } from "./stellarService.js";
import { PrizeService } from "../league/prizeService.js";
import { createSettlementProof } from "./settlementProof.js";
import {
  PayoutDeadLetterService,
  payoutDeadLetterService,
  DeadLetterConflictError,
  MISSING_WALLET_ERROR,
} from "./payoutDeadLetterService.js";
import {
  FinancialAuditAction,
  FinancialAuditRecorder,
  financialAuditLog,
  SYSTEM_ACTOR,
} from "../audit/financialAuditLog.js";
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  TransactionType,
  TransactionStatus,
  PaymentRequirement,
  PaymentSubmissionInput,
  PaymentVerificationResult,
  SettlementPlan,
  SettlementWinner,
  ReconciliationReport,
} from "../../types/index.js";

/** Max participants per refund invocation, keeps Soroban footprint and fees in bounds. */
export const REFUND_BATCH_SIZE = 10;

export interface RefundDispatchReport {
  leagueId: string;
  contractLeagueId: string;
  batches: number;
  refundedMemberIds: string[];
  failedBatches: Array<{ memberIds: string[]; error: string }>;
  /** Paid members without a linked Stellar address — need manual follow-up */
  skippedMemberIds: string[];
  /** Dead-letter entries created by this run (failed batches and missing wallets) */
  deadLetteredIds: string[];
  /** Members held back because they belong to an open dead-letter entry */
  isolatedMemberIds: string[];
  /** Recoverable dead-letter entries retried automatically by this run */
  autoRetried: Array<{ failedPayoutId: string; success: boolean }>;
}

type RefundInvocationOutcome = {
  success: boolean;
  txHash?: string;
  error?: string;
  contractErrorCode?: number;
};

export interface DeadLetterRetryResult {
  success: boolean;
  failedPayoutId: string;
  status: string;
  txHash: string | null;
  paidMemberIds: string[];
  error?: string;
}

export interface RefundReconciliationReport {
  leagueId: string;
  contractLeagueId: string;
  remainingEscrowStroops: string;
  outstandingMemberIds: string[];
  isFullyRefunded: boolean;
}

export class FinancialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialValidationError";
  }
}

export class FinancialNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialNotFoundError";
  }
}

export class FinancialForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialForbiddenError";
  }
}

export class FinancialConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialConflictError";
  }
}

export class FinancialService {
  private readonly deadLetters: PayoutDeadLetterService;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = prisma,
    private readonly stellar: StellarService = stellarService,
    deadLetters?: PayoutDeadLetterService,
    private readonly audit: FinancialAuditRecorder = financialAuditLog
  ) {
    // Share the injected DB so the DLQ and the ledger always see the same state
    this.deadLetters =
      deadLetters ?? (db === prisma ? payoutDeadLetterService : new PayoutDeadLetterService(db, audit));
  }

  /**
   * Generates a deterministic Stellar text memo (max 28 ASCII bytes)
   * Format: FXI:<8-char-league-id>:<8-char-user-id>
   */
  public formatPaymentMemo(leagueId: string, userId: string): string {
    const cleanLeague = leagueId
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 8)
      .toUpperCase();
    const cleanUser = userId
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 8)
      .toUpperCase();
    return `FXI:${cleanLeague}:${cleanUser}`;
  }

  /**
   * Initiates payment for a league entry fee.
   * Returns deterministic payment instructions (destination, asset, amount, memo).
   *
   * If the league is free (entryFee === 0), marks the membership as PAYMENT_CONFIRMED
   * and promotes it directly to ACTIVE.
   */
  public async createPaymentRequirement(
    userId: string,
    leagueId: string,
    squadId: string
  ): Promise<PaymentRequirement> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
    });

    if (!league) {
      throw new FinancialNotFoundError(`League with ID ${leagueId} was not found`);
    }

    if (league.status !== LeagueStatus.UPCOMING) {
      throw new FinancialValidationError(
        `Cannot initiate payment for a league in '${league.status}' status. Only UPCOMING leagues accept entry fees.`
      );
    }

    // Verify squad belongs to user
    const squad = await this.db.squad.findUnique({
      where: { id: squadId },
    });
    if (!squad || squad.userId !== userId) {
      throw new FinancialValidationError(
        "The selected squad does not belong to the user"
      );
    }

    const isFree = league.entryFee === 0;

    let member = await this.db.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId,
          userId,
        },
      },
    });

    // Private leagues are only reachable through a single-use invitation, which
    // creates the membership. Never let the payment flow create one implicitly.
    if (league.isPrivate && !member) {
      throw new FinancialForbiddenError(
        "This league is private. Accept an invitation to join before paying the entry fee."
      );
    }

    if (isFree) {
      if (!member) {
        member = await this.db.leagueMember.create({
          data: {
            leagueId,
            userId,
            squadId,
            status: MembershipStatus.ACTIVE,
            paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
            hasPaid: true,
          },
        });
      } else if (member.status !== MembershipStatus.ACTIVE) {
        member = await this.db.leagueMember.update({
          where: { id: member.id },
          data: {
            status: MembershipStatus.ACTIVE,
            paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
            hasPaid: true,
            squadId,
          },
        });
      }
    } else {
      if (!member) {
        member = await this.db.leagueMember.create({
          data: {
            leagueId,
            userId,
            squadId,
            status: MembershipStatus.PENDING,
            paymentStatus: PaymentStatus.PAYMENT_INITIATED,
          },
        });
      } else if (
        member.paymentStatus === PaymentStatus.PENDING ||
        member.paymentStatus === PaymentStatus.PAYMENT_FAILED
      ) {
        member = await this.db.leagueMember.update({
          where: { id: member.id },
          data: {
            paymentStatus: PaymentStatus.PAYMENT_INITIATED,
            squadId,
          },
        });
      }
    }

    const memo = this.formatPaymentMemo(leagueId, userId);

    return {
      leagueId: league.id,
      leagueName: league.name,
      entryFee: league.entryFee,
      assetCode: stellarConfig.usdcAssetCode,
      assetIssuer: stellarConfig.usdcIssuer,
      destinationAddress:
        stellarConfig.escrowContractId || stellarConfig.treasuryAddress,
      escrowContractId: stellarConfig.escrowContractId,
      memo,
      paymentStatus: member.paymentStatus,
    };
  }

  /**
   * Submits a Stellar transaction hash to record payment submission.
   * Transitions paymentStatus to PAYMENT_SUBMITTED and records Transaction record.
   */
  public async submitPayment(
    userId: string,
    leagueId: string,
    input: PaymentSubmissionInput
  ): Promise<{ member: any; transaction: any }> {
    const { stellarTxHash, stellarAddress } = input;

    if (!this.stellar.isValidTransactionHash(stellarTxHash)) {
      throw new FinancialValidationError(
        "Invalid transaction hash format. Expected 64-character hex string."
      );
    }

    if (!this.stellar.isValidStellarAddress(stellarAddress)) {
      throw new FinancialValidationError("Invalid Stellar wallet address");
    }

    const member = await this.db.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId,
          userId,
        },
      },
      include: {
        league: true,
      },
    });

    if (!member) {
      throw new FinancialNotFoundError(
        "You must initiate league join before submitting payment"
      );
    }

    if (member.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED) {
      return { member, transaction: null };
    }

    // Check if txHash has already been registered
    const existingTx = await this.db.transaction.findFirst({
      where: { stellarTxHash, type: TransactionType.ENTRY_FEE },
    });

    if (existingTx && existingTx.memberId && existingTx.memberId !== member.id) {
      throw new FinancialConflictError(
        "This transaction hash has already been registered for another participant"
      );
    }

    const updatedMember = await this.db.leagueMember.update({
      where: { id: member.id },
      data: {
        paymentStatus: PaymentStatus.PAYMENT_SUBMITTED,
        stellarAddress,
      },
    });

    const transaction = existingTx
      ? await this.db.transaction.update({
          where: { id: existingTx.id },
          data: {
            status: TransactionStatus.SUBMITTED,
            memberId: member.id,
          },
        })
      : await this.db.transaction.create({
          data: {
            type: TransactionType.ENTRY_FEE,
            status: TransactionStatus.SUBMITTED,
            amount: member.league.entryFee,
            asset: stellarConfig.usdcAssetCode,
            assetIssuer: stellarConfig.usdcIssuer,
            stellarTxHash,
            memo: this.formatPaymentMemo(leagueId, userId),
            memberId: member.id,
            leagueId: member.leagueId,
          },
        });

    this.audit.record({
      action: FinancialAuditAction.DEPOSIT_SUBMITTED,
      userId,
      actorId: userId,
      leagueId: member.leagueId,
      transactionId: transaction?.id,
      amount: member.league.entryFee,
      asset: stellarConfig.usdcAssetCode,
      stellarTxHash,
      metadata: { memberId: member.id, stellarAddress },
    });

    return { member: updatedMember, transaction };
  }

  /**
   * Verifies on-chain payment against Stellar Horizon.
   * If verified, transitions paymentStatus -> PAYMENT_CONFIRMED,
   * Transaction.status -> CONFIRMED, and promotes LeagueMember.status -> ACTIVE.
   */
  public async verifyAndConfirmPayment(
    userId: string,
    leagueId: string,
    stellarTxHash: string
  ): Promise<PaymentVerificationResult> {
    const member = await this.db.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId,
          userId,
        },
      },
      include: {
        league: true,
      },
    });

    if (!member) {
      throw new FinancialNotFoundError("Membership record not found");
    }

    // Idempotency: if already confirmed and active, return success immediately
    if (
      member.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED &&
      member.status === MembershipStatus.ACTIVE
    ) {
      return {
        success: true,
        txHash: stellarTxHash,
        amount: member.league.entryFee,
        assetCode: stellarConfig.usdcAssetCode,
      };
    }

    const expectedMemo = this.formatPaymentMemo(leagueId, userId);
    const expectedDestination =
      stellarConfig.escrowContractId || stellarConfig.treasuryAddress;

    const verification = await this.stellar.verifyPaymentTransaction({
      txHash: stellarTxHash,
      expectedDestination,
      expectedAmount: member.league.entryFee,
      expectedMemo,
      expectedSender: member.stellarAddress || undefined,
      expectedLeagueId: leagueId,
    });

    if (!verification.success) {
      await this.db.leagueMember.update({
        where: { id: member.id },
        data: {
          paymentStatus: PaymentStatus.PAYMENT_FAILED,
        },
      });

      await this.db.transaction.updateMany({
        where: { stellarTxHash },
        data: {
          status: TransactionStatus.FAILED,
          errorMessage: verification.error,
        },
      });

      this.audit.record({
        action: FinancialAuditAction.DEPOSIT_FAILED,
        userId,
        actorId: userId,
        leagueId,
        amount: member.league.entryFee,
        asset: stellarConfig.usdcAssetCode,
        stellarTxHash,
        metadata: { memberId: member.id, error: verification.error },
      });

      return verification;
    }

    // Atomically confirm payment and activate member
    await this.db.$transaction([
      this.db.leagueMember.update({
        where: { id: member.id },
        data: {
          paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
          status: MembershipStatus.ACTIVE,
          hasPaid: true,
        },
      }),
      this.db.transaction.updateMany({
        where: { stellarTxHash },
        data: {
          status: TransactionStatus.CONFIRMED,
          ledgerSeq: verification.ledgerSeq,
          confirmedAt: verification.confirmedAt || new Date(),
        },
      }),
    ]);

    this.audit.record({
      action: FinancialAuditAction.DEPOSIT_CONFIRMED,
      userId,
      actorId: userId,
      leagueId,
      amount: member.league.entryFee,
      asset: stellarConfig.usdcAssetCode,
      stellarTxHash,
      metadata: { memberId: member.id, ledgerSeq: verification.ledgerSeq },
    });

    return verification;
  }

  /**
   * Reconciles a membership whose payment never completed client-side verification —
   * e.g. the wallet's success callback was lost to a network drop or a closed tab
   * after the deposit already landed on-chain. Instead of trusting a transaction hash
   * from the client, this checks the Soroban escrow contract directly for the member's
   * own deposit balance and confirms membership only if it covers the entry fee.
   *
   * Idempotent and safe under concurrent retries: the confirming update is conditioned
   * on the member not already being PAYMENT_CONFIRMED, so two overlapping calls (e.g. a
   * user mashing "retry") can never double-confirm or double-credit the same deposit.
   */
  public async reconcileDeposit(
    userId: string,
    leagueId: string
  ): Promise<PaymentVerificationResult> {
    const member = await this.db.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId,
          userId,
        },
      },
      include: {
        league: true,
      },
    });

    if (!member) {
      throw new FinancialNotFoundError("Membership record not found");
    }

    if (
      member.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED &&
      member.status === MembershipStatus.ACTIVE
    ) {
      return {
        success: true,
        txHash: "",
        amount: member.league.entryFee,
        assetCode: stellarConfig.usdcAssetCode,
      };
    }

    if (!member.stellarAddress) {
      return {
        success: false,
        txHash: "",
        error:
          "No wallet address is on record for this membership yet. Submit the deposit first.",
      };
    }

    let onChainStroops: bigint;
    try {
      const contractLeagueId = FinancialService.toContractLeagueId(leagueId);
      onChainStroops = await this.stellar.getContractDeposit(
        contractLeagueId,
        member.stellarAddress
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        txHash: "",
        error: `Could not reach the Soroban network to reconcile your deposit: ${message}`,
      };
    }

    const depositedUsdc = Number(onChainStroops) / 10_000_000;
    const entryFee = Number(member.league.entryFee);
    if (depositedUsdc + 0.0001 < entryFee) {
      return {
        success: false,
        txHash: "",
        error:
          "No matching on-chain deposit was found yet. If you just submitted the transaction, wait a few seconds and retry.",
      };
    }

    // Conditional claim: only the first caller to observe an unconfirmed member wins the race.
    const claim = await this.db.leagueMember.updateMany({
      where: { id: member.id, paymentStatus: { not: PaymentStatus.PAYMENT_CONFIRMED } },
      data: {
        paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
        status: MembershipStatus.ACTIVE,
        hasPaid: true,
      },
    });

    if (claim.count === 0) {
      // Another request (or the original verify-payment call) already confirmed this
      // member in the meantime — reconciliation is a no-op, which is the correct outcome.
      return {
        success: true,
        txHash: "",
        amount: member.league.entryFee,
        assetCode: stellarConfig.usdcAssetCode,
      };
    }

    const existingTx = await this.db.transaction.findFirst({
      where: { memberId: member.id, type: TransactionType.ENTRY_FEE },
    });

    if (existingTx) {
      await this.db.transaction.update({
        where: { id: existingTx.id },
        data: { status: TransactionStatus.CONFIRMED, confirmedAt: new Date() },
      });
    } else {
      await this.db.transaction.create({
        data: {
          type: TransactionType.ENTRY_FEE,
          status: TransactionStatus.CONFIRMED,
          amount: member.league.entryFee,
          asset: stellarConfig.usdcAssetCode,
          assetIssuer: stellarConfig.usdcIssuer,
          memo: this.formatPaymentMemo(leagueId, userId),
          memberId: member.id,
          leagueId: member.leagueId,
          confirmedAt: new Date(),
        },
      });
    }

    this.audit.record({
      action: FinancialAuditAction.DEPOSIT_CONFIRMED,
      userId,
      actorId: userId,
      leagueId,
      amount: member.league.entryFee,
      asset: stellarConfig.usdcAssetCode,
      metadata: {
        memberId: member.id,
        reconciledViaOnChainQuery: true,
        onChainDepositUsdc: depositedUsdc,
      },
    });

    return {
      success: true,
      txHash: "",
      amount: member.league.entryFee,
      assetCode: stellarConfig.usdcAssetCode,
    };
  }

  /**
   * Prepares a deterministic settlement plan for a completed league.
   * Calculates gross total, platform fee, and 60/30/10 prize amounts using PrizeService.
   */
  public async prepareSettlement(
    leagueId: string,
    requesterUserId: string
  ): Promise<SettlementPlan> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: {
        members: {
          include: {
            user: true,
            squad: true,
          },
        },
      },
    });

    if (!league) {
      throw new FinancialNotFoundError(`League ${leagueId} not found`);
    }

    if (league.creatorId !== requesterUserId) {
      throw new FinancialForbiddenError(
        "Only the league creator or administrator can prepare settlements"
      );
    }

    if (league.status === LeagueStatus.CANCELLED) {
      return {
        leagueId: league.id,
        leagueName: league.name,
        status: league.status,
        totalParticipants: 0,
        entryFee: league.entryFee,
        grossPool: 0,
        platformFee: 0,
        netPrizePool: 0,
        winners: [],
        canSettle: false,
        unsettledReason: "League was cancelled. Funds must be refunded, not settled.",
      };
    }

    // Filter paid active participants
    const paidMembers = league.members.filter(
      (m: any) =>
        m.status === MembershipStatus.ACTIVE &&
        (league.entryFee === 0 ||
          m.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED)
    );

    if (paidMembers.length === 0) {
      return {
        leagueId: league.id,
        leagueName: league.name,
        status: league.status,
        totalParticipants: 0,
        entryFee: league.entryFee,
        grossPool: 0,
        platformFee: 0,
        netPrizePool: 0,
        winners: [],
        canSettle: false,
        unsettledReason: "No confirmed active participants found in this league.",
      };
    }

    // Calculate deterministic prize pool
    const distribution = PrizeService.calculatePrizeDistribution(
      paidMembers.length,
      league.entryFee
    );

    // Sort participants deterministically by points descending, then join timestamp
    const sortedMembers = [...paidMembers].sort((a: any, b: any) => {
      const aPoints = a.squad?.totalPoints || 0;
      const bPoints = b.squad?.totalPoints || 0;
      if (bPoints !== aPoints) return bPoints - aPoints;
      return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
    });

    const winners: SettlementWinner[] = [];

    // Winner 1 (60% or 70% if 2 players)
    if (sortedMembers[0] && distribution.prizes.first > 0) {
      winners.push({
        rank: 1,
        userId: sortedMembers[0].userId,
        username: sortedMembers[0].user?.username || "Unknown",
        stellarAddress: sortedMembers[0].stellarAddress || "PENDING_WALLET_LINK",
        squadName: sortedMembers[0].squad?.name || "Squad 1",
        totalPoints: sortedMembers[0].squad?.totalPoints || 0,
        prizeAmount: distribution.prizes.first,
      });
    }

    // Winner 2 (30%)
    if (sortedMembers[1] && distribution.prizes.second > 0) {
      winners.push({
        rank: 2,
        userId: sortedMembers[1].userId,
        username: sortedMembers[1].user?.username || "Unknown",
        stellarAddress: sortedMembers[1].stellarAddress || "PENDING_WALLET_LINK",
        squadName: sortedMembers[1].squad?.name || "Squad 2",
        totalPoints: sortedMembers[1].squad?.totalPoints || 0,
        prizeAmount: distribution.prizes.second,
      });
    }

    // Winner 3 (10% if 3+ players)
    if (sortedMembers[2] && distribution.prizes.third > 0) {
      winners.push({
        rank: 3,
        userId: sortedMembers[2].userId,
        username: sortedMembers[2].user?.username || "Unknown",
        stellarAddress: sortedMembers[2].stellarAddress || "PENDING_WALLET_LINK",
        squadName: sortedMembers[2].squad?.name || "Squad 3",
        totalPoints: sortedMembers[2].squad?.totalPoints || 0,
        prizeAmount: distribution.prizes.third,
      });
    }

    const proofHash = createSettlementProof({
      leagueId: league.id,
      grossPool: Number(distribution.grossTotal),
      platformFee: Number(distribution.platformFee),
      winners: winners.map((winner) => ({
        rank: winner.rank,
        userId: winner.userId,
        stellarAddress: winner.stellarAddress,
        totalPoints: winner.totalPoints,
        prizeAmount: winner.prizeAmount,
      })),
    });

    return {
      leagueId: league.id,
      leagueName: league.name,
      status: league.status,
      totalParticipants: paidMembers.length,
      entryFee: league.entryFee,
      grossPool: distribution.grossTotal,
      platformFee: distribution.platformFee,
      netPrizePool: distribution.prizePool,
      winners,
      canSettle: true,
      proofHash,
    };
  }

  /**
   * Maps a league UUID to the u64 `league_id` used by the escrow contract
   * (first 16 hex digits of the UUID).
   */
  public static toContractLeagueId(leagueId: string): bigint {
    const hex = leagueId.replace(/-/g, "").slice(0, 16);
    if (!/^[0-9a-fA-F]{16}$/.test(hex)) {
      throw new FinancialValidationError(`League ID ${leagueId} is not a valid UUID`);
    }
    return BigInt(`0x${hex}`);
  }

  /**
   * Splits items into consecutive batches of at most `size`.
   */
  public static chunk<T>(items: T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      batches.push(items.slice(i, i + size));
    }
    return batches;
  }

  /**
   * Refunds all paid participants of a cancelled league in batches of REFUND_BATCH_SIZE.
   * Each successful batch atomically marks its members REFUNDED and records REFUND
   * transactions with the batch's Stellar hash.
   *
   * Failed batches, and paid members without a wallet, are isolated in the payout
   * dead-letter queue. Later runs skip their members; only entries whose error is
   * recoverable are retried automatically (up to MAX_AUTOMATIC_ATTEMPTS), everything
   * else waits for an admin (see retryDeadLetteredPayout).
   */
  public async processLeagueRefunds(leagueId: string): Promise<RefundDispatchReport> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: { members: true },
    });

    if (!league) {
      throw new FinancialNotFoundError(`League ${leagueId} not found`);
    }
    if (league.status !== LeagueStatus.CANCELLED) {
      throw new FinancialValidationError(
        `Refunds can only be processed for CANCELLED leagues (current: ${league.status})`
      );
    }

    const contractLeagueId = FinancialService.toContractLeagueId(league.id);
    const report: RefundDispatchReport = {
      leagueId: league.id,
      contractLeagueId: contractLeagueId.toString(),
      batches: 0,
      refundedMemberIds: [],
      failedBatches: [],
      skippedMemberIds: [],
      deadLetteredIds: [],
      isolatedMemberIds: [],
      autoRetried: [],
    };

    // 1. Retry recoverable dead-letter entries first, as their original batches
    const retryable = await this.deadLetters.getAutoRetryable(league.id, TransactionType.REFUND);
    for (const entry of retryable) {
      try {
        const retry = await this.redispatchRefundEntry(entry.id, SYSTEM_ACTOR);
        report.autoRetried.push({ failedPayoutId: entry.id, success: retry.success });
        report.refundedMemberIds.push(...retry.paidMemberIds);
      } catch (error) {
        // Claimed concurrently by an admin or another worker: leave it to them
        if (!(error instanceof DeadLetterConflictError)) throw error;
      }
    }

    // 2. Dispatch every owed member that is not isolated in the dead-letter queue
    const isolated = await this.deadLetters.getIsolatedMemberIds(league.id, TransactionType.REFUND);
    const refundedNow = new Set(report.refundedMemberIds);
    const pending = league.members.filter(
      (m: any) => FinancialService.isRefundOwed(m) && !refundedNow.has(m.id)
    );
    report.isolatedMemberIds = pending
      .filter((m: any) => isolated.has(m.id))
      .map((m: any) => m.id);

    const dispatchable = pending.filter((m: any) => !isolated.has(m.id));
    const refundable = dispatchable.filter((m: any) => m.stellarAddress);
    const missingWallet = dispatchable.filter((m: any) => !m.stellarAddress);
    report.skippedMemberIds = missingWallet.map((m: any) => m.id);

    if (missingWallet.length > 0) {
      const entry = await this.deadLetters.deadLetter({
        type: TransactionType.REFUND,
        leagueId: league.id,
        memberIds: report.skippedMemberIds,
        recipients: [],
        amountPerRecipient: league.entryFee,
        error: MISSING_WALLET_ERROR,
        recoverable: false,
      });
      report.deadLetteredIds.push(entry.id);
    }

    const batches = FinancialService.chunk<any>(refundable, REFUND_BATCH_SIZE);
    report.batches = batches.length;

    for (const batch of batches) {
      const memberIds = batch.map((m: any) => m.id);
      const recipients = batch.map((m: any) => m.stellarAddress);
      const result = await this.dispatchRefund(contractLeagueId, recipients);

      if (!result.success) {
        const error = result.error || "Refund invocation failed";
        report.failedBatches.push({ memberIds, error });
        const entry = await this.deadLetters.deadLetter({
          type: TransactionType.REFUND,
          leagueId: league.id,
          memberIds,
          recipients,
          amountPerRecipient: league.entryFee,
          error,
          errorCode: result.contractErrorCode ?? null,
        });
        report.deadLetteredIds.push(entry.id);
        continue;
      }

      await this.commitRefundBatch(league, batch, result.txHash ?? null, SYSTEM_ACTOR);
      report.refundedMemberIds.push(...memberIds);
    }

    return report;
  }

  /**
   * Manually retries a dead-lettered payout. Admin only: the route layer enforces
   * RBAC and `actorId` is recorded in the audit log.
   */
  public async retryDeadLetteredPayout(
    failedPayoutId: string,
    actorId: string,
    note?: string
  ): Promise<DeadLetterRetryResult> {
    const entry = await this.deadLetters.get(failedPayoutId);
    if (entry.type !== TransactionType.REFUND) {
      throw new FinancialValidationError(
        `Manual retry is not supported for ${entry.type} payouts`
      );
    }
    return this.redispatchRefundEntry(failedPayoutId, actorId, note);
  }

  /** True when a member has paid and has not been refunded yet. */
  private static isRefundOwed(member: { paymentStatus: PaymentStatus }): boolean {
    return (
      member.paymentStatus === PaymentStatus.REFUND_PENDING ||
      member.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED
    );
  }

  private async dispatchRefund(
    contractLeagueId: bigint,
    recipients: string[]
  ): Promise<RefundInvocationOutcome> {
    try {
      return await this.stellar.refundParticipants(contractLeagueId, recipients);
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Atomically marks a refunded batch and records one REFUND transaction per member.
   */
  private async commitRefundBatch(
    league: { id: string; entryFee: any },
    batch: Array<{ id: string; userId: string; stellarAddress?: string | null }>,
    txHash: string | null,
    actorId: string
  ): Promise<void> {
    const confirmedAt = new Date();
    await this.db.$transaction([
      ...batch.map((m) =>
        this.db.leagueMember.update({
          where: { id: m.id },
          data: { paymentStatus: PaymentStatus.REFUNDED },
        })
      ),
      ...batch.map((m) =>
        this.db.transaction.create({
          data: {
            userId: m.userId,
            leagueId: league.id,
            memberId: m.id,
            type: TransactionType.REFUND,
            status: TransactionStatus.CONFIRMED,
            amount: league.entryFee,
            asset: stellarConfig.usdcAssetCode,
            assetIssuer: stellarConfig.usdcIssuer,
            stellarTxHash: txHash,
            confirmedAt,
          },
        })
      ),
    ]);

    for (const m of batch) {
      this.audit.record({
        action: FinancialAuditAction.REFUND,
        userId: m.userId,
        actorId,
        leagueId: league.id,
        amount: league.entryFee,
        asset: stellarConfig.usdcAssetCode,
        stellarTxHash: txHash,
        metadata: { memberId: m.id, stellarAddress: m.stellarAddress ?? null },
      });
    }
  }

  /**
   * Claims a dead-lettered refund, re-dispatches it with fresh member state, then
   * resolves or re-queues it. Members refunded in the meantime are never paid twice.
   */
  private async redispatchRefundEntry(
    failedPayoutId: string,
    actorId: string,
    note?: string
  ): Promise<DeadLetterRetryResult> {
    const entry = await this.deadLetters.claimForRetry(failedPayoutId);

    try {
      const league = await this.db.league.findUnique({
        where: { id: entry.leagueId },
        include: { members: true },
      });
      if (!league) {
        throw new FinancialNotFoundError(`League ${entry.leagueId} not found`);
      }

      const entryMemberIds = new Set<string>(entry.memberIds);
      const owed = league.members.filter(
        (m: any) => entryMemberIds.has(m.id) && FinancialService.isRefundOwed(m)
      );

      if (owed.length === 0) {
        const resolved = await this.deadLetters.markResolved(entry, {
          actorId,
          txHash: null,
          paidMemberIds: [],
          note: note ?? "No outstanding refunds remained for this entry",
        });
        return { success: true, failedPayoutId, status: resolved.status, txHash: null, paidMemberIds: [] };
      }

      // Wallets may have been linked since the failure, so always use fresh addresses
      const result: RefundInvocationOutcome = owed.some((m: any) => !m.stellarAddress)
        ? { success: false, error: MISSING_WALLET_ERROR }
        : await this.dispatchRefund(
            FinancialService.toContractLeagueId(league.id),
            owed.map((m: any) => m.stellarAddress)
          );

      if (!result.success) {
        const error = result.error || "Refund invocation failed";
        const failed = await this.deadLetters.markRetryFailed(entry, {
          actorId,
          error,
          errorCode: result.contractErrorCode ?? null,
        });
        return {
          success: false,
          failedPayoutId,
          status: failed.status,
          txHash: result.txHash ?? null,
          paidMemberIds: [],
          error,
        };
      }

      const txHash = result.txHash ?? null;
      const paidMemberIds = owed.map((m: any) => m.id);
      await this.commitRefundBatch(league, owed, txHash, actorId);
      const resolved = await this.deadLetters.markResolved(entry, {
        actorId,
        txHash,
        paidMemberIds,
        note,
      });

      return { success: true, failedPayoutId, status: resolved.status, txHash, paidMemberIds };
    } catch (error) {
      // Never leave an entry stuck in RETRYING after an unexpected error. Refunds are
      // idempotent on-chain, so re-queueing is safe even after a partial run.
      await this.deadLetters
        .markRetryFailed(entry, { actorId, error: (error as Error).message })
        .catch((releaseError: Error) =>
          console.error(`[payouts] Failed to release payout ${failedPayoutId}:`, releaseError)
        );
      throw error;
    }
  }

  /**
   * Confirms that the escrow contract holds no remaining deposits for a refunded league.
   */
  public async verifyRefundReconciliation(
    leagueId: string
  ): Promise<RefundReconciliationReport> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: { members: true },
    });

    if (!league) {
      throw new FinancialNotFoundError(`League ${leagueId} not found`);
    }

    const contractLeagueId = FinancialService.toContractLeagueId(league.id);
    let remaining = 0n;
    for (const m of league.members) {
      if (m.stellarAddress) {
        remaining += await this.stellar.getContractDeposit(
          contractLeagueId,
          m.stellarAddress
        );
      }
    }

    const outstandingMemberIds = league.members
      .filter(
        (m: any) =>
          m.paymentStatus === PaymentStatus.REFUND_PENDING ||
          m.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED
      )
      .map((m: any) => m.id);

    return {
      leagueId: league.id,
      contractLeagueId: contractLeagueId.toString(),
      remainingEscrowStroops: remaining.toString(),
      outstandingMemberIds,
      isFullyRefunded: remaining === 0n && outstandingMemberIds.length === 0,
    };
  }

  /**
   * Reconciles application ledger with verified transactions.
   * Computes expected gross, confirmed deposits, and identifies any discrepancy.
   */
  public async reconcileLeague(leagueId: string): Promise<ReconciliationReport> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: {
        members: true,
        transactions: true,
      },
    });

    if (!league) {
      throw new FinancialNotFoundError(`League ${leagueId} not found`);
    }

    const activeMembers = league.members.filter(
      (m: any) => m.status === MembershipStatus.ACTIVE
    );

    const confirmedTx = (league.transactions || []).filter(
      (tx: any) =>
        tx.type === TransactionType.ENTRY_FEE &&
        tx.status === TransactionStatus.CONFIRMED
    );

    const expectedGross = activeMembers.length * league.entryFee;
    const confirmedTotal = confirmedTx.reduce(
      (sum: number, tx: any) => sum + tx.amount,
      0
    );
    const discrepancy = parseFloat((expectedGross - confirmedTotal).toFixed(4));

    return {
      leagueId: league.id,
      leagueName: league.name,
      activeMemberCount: activeMembers.length,
      entryFee: league.entryFee,
      expectedGross,
      confirmedDepositsTotal: confirmedTotal,
      discrepancy,
      isBalanced: Math.abs(discrepancy) < 0.0001,
      transactions: (league.transactions || []).map((tx: any) => ({
        id: tx.id,
        type: tx.type,
        status: tx.status,
        amount: tx.amount,
        stellarTxHash: tx.stellarTxHash,
        confirmedAt: tx.confirmedAt,
      })),
    };
  }
}

export const financialService = new FinancialService();
