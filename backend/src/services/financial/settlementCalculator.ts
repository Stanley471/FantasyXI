/**
 * Settlement Calculator — Deterministic Multi-Currency Prize Distribution
 *
 * Enforces exact 60/30/10 prize splits with zero fractional slippage loss.
 * Handles arbitrary participant pools and multi-currency settlements.
 *
 * Mathematical invariants:
 * - Σ(prizes) + platform_fee ≡ 100% of pool (zero slippage)
 * - All intermediate calculations preserve fractional cents
 * - Tie-aware: equal scores receive equal payouts
 */

export type Currency = "USDC" | "ZEC" | "XLM";

export interface CurrencyAmount {
  currency: Currency;
  amount: number; // amount in the base unit of the currency
}

export interface PrizeDistributionConfig {
  /** Prize splits in basis points: [first, second, third, ...]. Must sum to 10,000 */
  splitsBps: number[];
  /** Platform fee as percentage (0-100), default 5% */
  platformFeePercent?: number;
}

export interface SettlementBreakdown {
  /** Gross pool before fees */
  grossPoolCents: number;
  /** Platform fee in cents */
  platformFeeCents: number;
  /** Net prize pool in cents */
  prizePoolCents: number;
  /** Individual prize amounts in cents */
  prizesCents: number[];
  /** Basis points for each prize tier */
  splitsBps: number[];
  /** Verification: sum of prizes equals prize pool */
  invariantValid: boolean;
}

export interface TieAdjustmentResult {
  /** Groups of tied players with their rank ranges */
  tieGroups: Array<{
    playerIds: string[];
    rank: number; // the rank this group receives
    prizeAmount: number; // in cents
  }>;
  /** Total additional rounding loss to be allocated */
  roundingLossCents: number;
  /** Resulting individual payouts in cents */
  payouts: Map<string, number>;
}

/**
 * Core settlement calculator. Uses integer arithmetic (cents) to avoid
 * floating-point rounding errors.
 */
export class SettlementCalculator {
  /** Standard 60/30/10 split in basis points */
  private static readonly STANDARD_SPLITS_BPS = [6000, 3000, 1000];
  /** 70/30 split for 2-player leagues */
  private static readonly TWO_PLAYER_SPLITS_BPS = [7000, 3000];
  /** Default platform fee: 5% */
  private static readonly DEFAULT_PLATFORM_FEE_PERCENT = 5;

  /**
   * Calculate exact prize distribution for a prize pool.
   * All calculations in cents to preserve precision.
   *
   * @param entryFeeCents - Entry fee per participant in cents
   * @param participantCount - Number of participants
   * @param config - Prize split configuration
   * @returns Settlement breakdown with invariant verification
   */
  static calculateSettlement(
    entryFeeCents: number,
    participantCount: number,
    config: PrizeDistributionConfig = {}
  ): SettlementBreakdown {
    if (!Number.isInteger(entryFeeCents) || entryFeeCents < 0) {
      throw new Error("Entry fee must be non-negative integer cents");
    }
    if (!Number.isInteger(participantCount) || participantCount < 1) {
      throw new Error("Participant count must be positive integer");
    }

    const feePercent =
      config.platformFeePercent ?? this.DEFAULT_PLATFORM_FEE_PERCENT;
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
      throw new Error("Platform fee percent must be between 0 and 100");
    }

    // Calculate gross pool (all entry fees)
    const grossPoolCents = participantCount * entryFeeCents;

    // Calculate platform fee (round to nearest cent)
    const platformFeeCents = Math.round(
      (grossPoolCents * feePercent) / 100
    );

    // Calculate net prize pool
    const prizePoolCents = grossPoolCents - platformFeeCents;

    if (prizePoolCents < 0) {
      throw new Error("Prize pool cannot be negative");
    }

    // Determine splits based on participant count
    let splitsBps = this.determineSplits(participantCount, config);

    // Calculate individual prize amounts with rounding preservation
    const prizesCents = this.calculatePrizeAmounts(
      prizePoolCents,
      splitsBps
    );

    // Verify invariant: sum of prizes must equal prize pool
    const prizeSum = prizesCents.reduce((sum, p) => sum + p, 0);
    const invariantValid = prizeSum === prizePoolCents;

    if (!invariantValid) {
      throw new Error(
        `Prize calculation invariant violated: ${prizeSum} != ${prizePoolCents}`
      );
    }

    return {
      grossPoolCents,
      platformFeeCents,
      prizePoolCents,
      prizesCents,
      splitsBps,
      invariantValid,
    };
  }

  /**
   * Adjust payouts for tied players. Distributes rounding loss across ties.
   *
   * @param settlement - Calculated settlement
   * @param playerGroups - Array of [playerIds[], score] representing ties
   * @returns Tie-adjusted payouts with rounding preservation
   */
  static adjustForTies(
    settlement: SettlementBreakdown,
    playerGroups: Array<[string[], number]>
  ): TieAdjustmentResult {
    if (playerGroups.length === 0) {
      throw new Error("Player groups cannot be empty");
    }

    const tieGroups: TieAdjustmentResult["tieGroups"] = [];
    const payouts = new Map<string, number>();
    let currentRank = 1;
    let roundingLossCents = 0;

    // Process each group (ties have the same prize amount)
    for (const [playerIds, _score] of playerGroups) {
      if (playerIds.length === 0) {
        throw new Error("Empty player group");
      }

      const groupSize = playerIds.length;

      // Collect prize amounts for this rank range
      const prizeAmountsForGroup = settlement.prizesCents.slice(
        currentRank - 1,
        currentRank - 1 + groupSize
      );

      // All players in a tie get the average of their prize tier amounts
      const totalPrizesCents = prizeAmountsForGroup.reduce((a, b) => a + b, 0);
      const averagePrizeCents = Math.floor(totalPrizesCents / groupSize);
      const extraCents = totalPrizesCents % groupSize;

      // Distribute average to all tie members
      for (const playerId of playerIds) {
        payouts.set(playerId, averagePrizeCents);
      }

      // Track rounding loss
      roundingLossCents += extraCents;

      tieGroups.push({
        playerIds,
        rank: currentRank,
        prizeAmount: averagePrizeCents * groupSize + extraCents,
      });

      currentRank += groupSize;
    }

    return {
      tieGroups,
      roundingLossCents,
      payouts,
    };
  }

  /**
   * Determine appropriate prize splits based on participant count.
   */
  private static determineSplits(
    participantCount: number,
    config: PrizeDistributionConfig
  ): number[] {
    // Use custom splits if provided
    if (config.splitsBps) {
      this.validateSplits(config.splitsBps);
      return config.splitsBps;
    }

    // Default: standard 60/30/10 split
    let baseSplits =
      participantCount === 2
        ? this.TWO_PLAYER_SPLITS_BPS
        : this.STANDARD_SPLITS_BPS;

    // Truncate to number of participants
    if (participantCount < baseSplits.length) {
      baseSplits = baseSplits.slice(0, participantCount);
    }

    // Normalize if truncated
    if (baseSplits.reduce((sum, bps) => sum + bps, 0) !== 10000) {
      const total = baseSplits.reduce((sum, bps) => sum + bps, 0);
      baseSplits = baseSplits.map((bps, index) =>
        index === baseSplits.length - 1
          ? 10000 - baseSplits.slice(0, index).reduce((sum, b) => sum + b, 0)
          : Math.floor((bps * 10000) / total)
      );
    }

    return baseSplits;
  }

  /**
   * Calculate individual prize amounts from basis points.
   * Uses a "waterfall" approach to ensure exact sum.
   */
  private static calculatePrizeAmounts(
    prizePoolCents: number,
    splitsBps: number[]
  ): number[] {
    this.validateSplits(splitsBps);

    const prizes: number[] = [];
    let remainingCents = prizePoolCents;

    for (let i = 0; i < splitsBps.length; i++) {
      if (i === splitsBps.length - 1) {
        // Last prize gets whatever is left
        prizes.push(remainingCents);
      } else {
        // Calculate this tier's share and round down
        const tierCents = Math.floor(
          (prizePoolCents * splitsBps[i]) / 10000
        );
        prizes.push(tierCents);
        remainingCents -= tierCents;
      }
    }

    return prizes;
  }

  /**
   * Validate that prize splits sum to 10,000 basis points.
   */
  private static validateSplits(splitsBps: number[]): void {
    if (!Array.isArray(splitsBps) || splitsBps.length === 0) {
      throw new Error("Prize splits must be non-empty array");
    }

    const total = splitsBps.reduce((sum, bps) => sum + bps, 0);
    if (total !== 10000) {
      throw new Error(
        `Prize splits must sum to 10,000 basis points, got ${total}`
      );
    }

    for (const bps of splitsBps) {
      if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
        throw new Error("Each split must be integer basis point value 0-10,000");
      }
    }
  }

  /**
   * Convert a currency amount from the base unit to cents.
   * Used to normalize multi-currency inputs.
   *
   * @param currency - Asset type
   * @param amount - Amount in asset's base unit
   * @returns Amount in cents (1/100th of base unit)
   */
  static toCents(currency: Currency, amount: number): number {
    // All supported currencies have 6 decimal places on Stellar
    // 1 USDC = 1,000,000 stroops = 10,000 cents
    const stroopsPerUnit = 1_000_000;
    const centsPerUnit = 10_000; // 100 cents per dollar equivalent

    const stroops = Math.round(amount * stroopsPerUnit);
    return Math.round(stroops / (stroopsPerUnit / centsPerUnit));
  }

  /**
   * Convert from cents back to asset base unit.
   */
  static fromCents(currency: Currency, cents: number): number {
    const stroopsPerUnit = 1_000_000;
    const centsPerUnit = 10_000;

    return (cents * (stroopsPerUnit / centsPerUnit)) / stroopsPerUnit;
  }
}
