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
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  TransactionType,
  TransactionStatus,
  UserRole,
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
}

export interface RefundReconciliationReport {
  leagueId: string;
  contractLeagueId: string;
  remainingEscrowStroops: string;
  outstandingMemberIds: string[];
  isFullyRefunded: boolean;
}

export interface SettlementDispatchReport {
  leagueId: string;
  contractLeagueId: string;
  stellarTxHash: string;
  ledgerSeq?: number;
  winnerTransactionCount: number;
  platformFee: number;
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
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = prisma,
    private readonly stellar: StellarService = stellarService
  ) {}

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

    return verification;
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

    // Sort participants deterministically by points descending, then join timestamp.
    const sortedMembers = [...paidMembers].sort((a: any, b: any) => {
      const aPoints = a.squad?.totalPoints || 0;
      const bPoints = b.squad?.totalPoints || 0;
      if (bPoints !== aPoints) return bPoints - aPoints;
      return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
    });

    const winners: SettlementWinner[] = [];
    const hasFirstPlaceTie =
      sortedMembers.length > 1 &&
      (sortedMembers[0].squad?.totalPoints || 0) ===
        (sortedMembers[1].squad?.totalPoints || 0);
    const tiedFirstPrize = hasFirstPlaceTie
      ? Math.floor((distribution.prizes.first + distribution.prizes.second) * 100 / 2) / 100
      : distribution.prizes.first;
    const tiedSecondPrize = hasFirstPlaceTie
      ? distribution.prizes.first + distribution.prizes.second - tiedFirstPrize
      : distribution.prizes.second;

    // Winner 1 (or the deterministic first half of a tied first place).
    if (sortedMembers[0] && distribution.prizes.first > 0) {
      winners.push({
        rank: 1,
        userId: sortedMembers[0].userId,
        username: sortedMembers[0].user?.username || "Unknown",
        stellarAddress: sortedMembers[0].stellarAddress || "PENDING_WALLET_LINK",
        squadName: sortedMembers[0].squad?.name || "Squad 1",
        totalPoints: sortedMembers[0].squad?.totalPoints || 0,
        prizeAmount: hasFirstPlaceTie ? tiedFirstPrize : distribution.prizes.first,
      });
    }

    // Winner 2 (or the deterministic second half of a tied first place).
    if (sortedMembers[1] && distribution.prizes.second > 0) {
      winners.push({
        rank: hasFirstPlaceTie ? 1 : 2,
        userId: sortedMembers[1].userId,
        username: sortedMembers[1].user?.username || "Unknown",
        stellarAddress: sortedMembers[1].stellarAddress || "PENDING_WALLET_LINK",
        squadName: sortedMembers[1].squad?.name || "Squad 2",
        totalPoints: sortedMembers[1].squad?.totalPoints || 0,
        prizeAmount: hasFirstPlaceTie ? tiedSecondPrize : distribution.prizes.second,
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
    };
  }

  /**
   * Dispatches a verified settlement to Soroban and records the confirmed
   * payout and platform-fee transactions atomically.
   */
  public async executeSettlement(
    leagueId: string,
    adminUserId: string
  ): Promise<SettlementDispatchReport> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: { endGameweek: true },
    });

    if (!league) {
      throw new FinancialNotFoundError(`League ${leagueId} not found`);
    }
    if (league.status === LeagueStatus.COMPLETED) {
      throw new FinancialConflictError("League settlement has already been executed");
    }
    if (league.status === LeagueStatus.CANCELLED) {
      throw new FinancialValidationError("Cancelled leagues cannot be settled");
    }
    if (!league.endGameweek?.isFinished) {
      throw new FinancialValidationError(
        "Settlement is blocked until the league end gameweek is finished"
      );
    }

    const admin = await this.db.user.findUnique({ where: { id: adminUserId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new FinancialForbiddenError("Only an administrator can execute settlements");
    }

    const plan = await this.prepareSettlement(leagueId, league.creatorId);
    if (!plan.canSettle || plan.winners.length === 0) {
      throw new FinancialValidationError(
        plan.unsettledReason || "The league has no eligible settlement winners"
      );
    }

    for (const winner of plan.winners) {
      if (!this.stellar.isValidStellarAddress(winner.stellarAddress)) {
        throw new FinancialValidationError(
          `Winner ${winner.userId} does not have a linked Stellar address`
        );
      }
    }

    const contractLeagueId = FinancialService.toContractLeagueId(leagueId);
    const toStroops = (amount: number): bigint =>
      BigInt(Math.round(amount * 100)) * 100_000n;
    let result;
    try {
      result = await this.stellar.settleLeague(
        contractLeagueId,
        plan.winners.map((winner) => ({
          winner: winner.stellarAddress,
          amount: toStroops(winner.prizeAmount).toString(),
        })),
        toStroops(plan.platformFee)
      );
    } catch (error) {
      throw new FinancialConflictError(
        `Settlement dispatch failed: ${(error as Error).message}`
      );
    }

    if (!result.success || !result.txHash) {
      throw new FinancialConflictError(
        result.error || "Settlement transaction was not confirmed"
      );
    }

    const confirmedAt = new Date();
    await this.db.$transaction([
      this.db.league.update({
        where: { id: leagueId },
        data: {
          status: LeagueStatus.COMPLETED,
          prizePool: plan.netPrizePool,
        },
      }),
      ...plan.winners.map((winner) =>
        this.db.transaction.create({
          data: {
            userId: winner.userId,
            leagueId,
            type: TransactionType.PRIZE_PAYOUT,
            amount: winner.prizeAmount,
            asset: stellarConfig.usdcAssetCode,
            assetIssuer: stellarConfig.usdcIssuer,
            stellarTxHash: result.txHash,
            ledgerSeq: result.ledgerSeq,
            status: TransactionStatus.CONFIRMED,
            confirmedAt,
            memo: `PRIZE_PAYOUT:${leagueId}:${winner.rank}`,
          },
        })
      ),
      this.db.transaction.create({
        data: {
          userId: adminUserId,
          leagueId,
          type: TransactionType.PLATFORM_FEE,
          amount: plan.platformFee,
          asset: stellarConfig.usdcAssetCode,
          assetIssuer: stellarConfig.usdcIssuer,
          stellarTxHash: result.txHash,
          ledgerSeq: result.ledgerSeq,
          status: TransactionStatus.CONFIRMED,
          confirmedAt,
          memo: `PLATFORM_FEE:${leagueId}`,
        },
      }),
    ]);

    return {
      leagueId,
      contractLeagueId: contractLeagueId.toString(),
      stellarTxHash: result.txHash,
      ledgerSeq: result.ledgerSeq,
      winnerTransactionCount: plan.winners.length,
      platformFee: plan.platformFee,
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
   * transactions with the batch's Stellar hash. Failed batches stay pending, so the
   * dispatcher can safely be re-run (the contract ignores already-refunded deposits).
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

    const pending = league.members.filter(
      (m: any) =>
        m.paymentStatus === PaymentStatus.REFUND_PENDING ||
        m.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED
    );
    const refundable = pending.filter((m: any) => m.stellarAddress);
    const contractLeagueId = FinancialService.toContractLeagueId(league.id);
    const batches = FinancialService.chunk(refundable, REFUND_BATCH_SIZE);

    const report: RefundDispatchReport = {
      leagueId: league.id,
      contractLeagueId: contractLeagueId.toString(),
      batches: batches.length,
      refundedMemberIds: [],
      failedBatches: [],
      skippedMemberIds: pending
        .filter((m: any) => !m.stellarAddress)
        .map((m: any) => m.id),
    };

    for (const batch of batches) {
      const memberIds = batch.map((m: any) => m.id);
      let result;
      try {
        result = await this.stellar.refundParticipants(
          contractLeagueId,
          batch.map((m: any) => m.stellarAddress)
        );
      } catch (error) {
        result = { success: false, error: (error as Error).message };
      }

      if (!result.success) {
        report.failedBatches.push({
          memberIds,
          error: result.error || "Refund invocation failed",
        });
        continue;
      }

      const confirmedAt = new Date();
      await this.db.$transaction([
        ...batch.map((m: any) =>
          this.db.leagueMember.update({
            where: { id: m.id },
            data: { paymentStatus: PaymentStatus.REFUNDED },
          })
        ),
        ...batch.map((m: any) =>
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
              stellarTxHash: result.txHash ?? null,
              confirmedAt,
            },
          })
        ),
      ]);
      report.refundedMemberIds.push(...memberIds);
    }

    return report;
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
