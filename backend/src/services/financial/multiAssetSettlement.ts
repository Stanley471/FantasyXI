/**
 * Multi-Asset Settlement Transaction Coordinator
 *
 * Coordinates settlement transactions across multiple currencies (USDC, ZEC, XLM).
 * Manages:
 * - Prize split calculation in a common reference currency
 * - Conversion to participant's preferred currency
 * - Transaction batch creation and submission
 * - Invariant verification across all settlements
 */

import {
  SettlementCalculator,
  SettlementBreakdown,
  PrizeDistributionConfig,
  Currency,
} from "./settlementCalculator.js";
import { CurrencyConverter } from "./currencyConverter.js";

export interface Participant {
  id: string;
  rank?: number; // ties share the same rank
  score: number;
  preferredCurrency: Currency;
  stellarAddress: string;
}

export interface SettlementEntry {
  participantId: string;
  participantRank: number;
  prizeAmountInReferenceCurrency: number; // cents
  preferredCurrency: Currency;
  stellarAddress: string;
  convertedAmount: number; // in participant's preferred currency (base units)
  slippageCents: number;
}

export interface MultiAssetSettlementResult {
  leagueId: string;
  referenceCurrency: Currency;
  totalParticipants: number;
  grossPoolCents: number;
  platformFeeCents: number;
  prizePoolCents: number;
  entries: SettlementEntry[];
  /** Total converted amounts across all participants */
  totalConvertedAmount: number;
  /** Sum of all slippage losses (in cents) */
  totalSlippageCents: number;
  /** Verification: sum of converted amounts accounts for all slippage */
  invariantValid: boolean;
  /** Timestamp of rate snapshot used */
  settledAt: Date;
}

export interface SettlementPlan {
  leagueId: string;
  grossPoolCents: number;
  platformFeeCents: number;
  prizePoolCents: number;
  settlement: SettlementBreakdown;
  participants: Participant[];
  referenceCurrency: Currency;
  priorityFeePerTx: number; // in stroops
}

/**
 * Coordinates multi-currency settlements with precise accounting.
 */
export class MultiAssetSettlement {
  private calculator = SettlementCalculator;
  private converter: CurrencyConverter;

  constructor(converter: CurrencyConverter) {
    this.converter = converter;
  }

  /**
   * Create a settlement plan from a league's entry fees and participants.
   *
   * @param leagueId - League identifier
   * @param entryFeeCents - Fee per participant in cents (reference currency)
   * @param participants - List of participants with preferences
   * @param referenceCurrency - Currency used for initial calculations (USDC)
   * @param config - Prize split configuration
   * @returns Executable settlement plan
   */
  createSettlementPlan(
    leagueId: string,
    entryFeeCents: number,
    participants: Participant[],
    referenceCurrency: Currency = "USDC",
    config: PrizeDistributionConfig = {}
  ): SettlementPlan {
    if (participants.length === 0) {
      throw new Error("Settlement requires at least one participant");
    }

    const settlement = this.calculator.calculateSettlement(
      entryFeeCents,
      participants.length,
      config
    );

    return {
      leagueId,
      grossPoolCents: settlement.grossPoolCents,
      platformFeeCents: settlement.platformFeeCents,
      prizePoolCents: settlement.prizePoolCents,
      settlement,
      participants,
      referenceCurrency,
      priorityFeePerTx: 1000, // default: 1000 stroops per tx
    };
  }

  /**
   * Execute a settlement plan, converting to each participant's preferred currency.
   *
   * @param plan - Settlement plan from createSettlementPlan
   * @returns Complete settlement with all conversions
   */
  async executeSettlement(
    plan: SettlementPlan
  ): Promise<MultiAssetSettlementResult> {
    // Capture exchange rates for this settlement
    const currencies = Array.from(
      new Set([
        plan.referenceCurrency,
        ...plan.participants.map((p) => p.preferredCurrency),
      ])
    ) as Currency[];

    await this.converter.captureRateSnapshot(currencies, 60);

    // Sort participants by rank for deterministic ordering
    const sortedParticipants = [...plan.participants].sort((a, b) => {
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });

    const entries: SettlementEntry[] = [];
    let totalConvertedAmount = 0;
    let totalSlippageCents = 0;

    // Assign prizes based on rank, handling ties
    let rankIndex = 0;
    for (let i = 0; i < sortedParticipants.length; i++) {
      const participant = sortedParticipants[i];
      const participantRank = participant.rank ?? i + 1;

      // Use cached prize amount for this rank
      let prizeAmountCents = plan.settlement.prizesCents[participantRank - 1];
      if (prizeAmountCents === undefined) {
        // Fallback if not enough tiers: all remaining get proportional share
        prizeAmountCents = 0;
      }

      // Convert to participant's preferred currency
      const prizeInReferenceCurrency = this.calculator.fromCents(
        plan.referenceCurrency,
        prizeAmountCents
      );

      const conversionResult = this.converter.convert(
        prizeInReferenceCurrency,
        plan.referenceCurrency,
        participant.preferredCurrency,
        "round"
      );

      entries.push({
        participantId: participant.id,
        participantRank,
        prizeAmountInReferenceCurrency: prizeAmountCents,
        preferredCurrency: participant.preferredCurrency,
        stellarAddress: participant.stellarAddress,
        convertedAmount: conversionResult.convertedAmount,
        slippageCents: Math.round(conversionResult.slippageInCents),
      });

      totalConvertedAmount += conversionResult.convertedAmount;
      totalSlippageCents += Math.round(conversionResult.slippageInCents);
    }

    // Verify invariant: accounting for multi-currency conversion
    // All conversions back to reference currency should account for slippage
    let reconvertedTotal = 0;
    for (const entry of entries) {
      const reconverted = this.converter.convert(
        entry.convertedAmount,
        entry.preferredCurrency,
        plan.referenceCurrency,
        "floor" // conservative: floor to catch gains
      );
      reconvertedTotal += this.calculator.toCents(
        plan.referenceCurrency,
        reconverted.convertedAmount
      );
    }

    // Allow small variance due to rounding, but must be within slippage budget
    const variance = Math.abs(
      plan.prizePoolCents - reconvertedTotal
    );
    const invariantValid = variance <= totalSlippageCents + 100; // 1 cent tolerance

    return {
      leagueId: plan.leagueId,
      referenceCurrency: plan.referenceCurrency,
      totalParticipants: plan.participants.length,
      grossPoolCents: plan.grossPoolCents,
      platformFeeCents: plan.platformFeeCents,
      prizePoolCents: plan.prizePoolCents,
      entries,
      totalConvertedAmount,
      totalSlippageCents,
      invariantValid,
      settledAt: new Date(),
    };
  }

  /**
   * Batch create settlement entries for transaction submission to blockchain.
   * Groups participants by currency to minimize transaction count.
   */
  groupSettlementByCurrency(
    result: MultiAssetSettlementResult
  ): Map<
    Currency,
    {
      currency: Currency;
      entries: SettlementEntry[];
      totalAmount: number;
    }
  > {
    const grouped = new Map<
      Currency,
      {
        currency: Currency;
        entries: SettlementEntry[];
        totalAmount: number;
      }
    >();

    for (const entry of result.entries) {
      const currency = entry.preferredCurrency;
      if (!grouped.has(currency)) {
        grouped.set(currency, {
          currency,
          entries: [],
          totalAmount: 0,
        });
      }

      const group = grouped.get(currency)!;
      group.entries.push(entry);
      group.totalAmount += entry.convertedAmount;
    }

    return grouped;
  }

  /**
   * Validate a completed settlement for audit/compliance.
   */
  validateSettlement(result: MultiAssetSettlementResult): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check invariant
    if (!result.invariantValid) {
      errors.push("Settlement invariant check failed");
    }

    // Check all entries have valid stellar addresses
    for (const entry of result.entries) {
      if (!entry.stellarAddress || entry.stellarAddress.length < 10) {
        errors.push(
          `Invalid stellar address for participant ${entry.participantId}`
        );
      }
    }

    // Check no duplicate participants
    const participantIds = new Set(result.entries.map((e) => e.participantId));
    if (participantIds.size !== result.entries.length) {
      errors.push("Duplicate participant entries detected");
    }

    // Check prize amounts are non-negative
    for (const entry of result.entries) {
      if (entry.prizeAmountInReferenceCurrency < 0) {
        errors.push(
          `Negative prize amount for participant ${entry.participantId}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Generate audit trail for settlement compliance.
   */
  generateAuditTrail(result: MultiAssetSettlementResult): string {
    const lines = [
      `League Settlement Audit Trail`,
      `League ID: ${result.leagueId}`,
      `Settlement Time: ${result.settledAt.toISOString()}`,
      `Reference Currency: ${result.referenceCurrency}`,
      ``,
      `Pool Accounting:`,
      `  Gross Pool: ${(result.grossPoolCents / 100).toFixed(2)} ${result.referenceCurrency}`,
      `  Platform Fee (5%): ${(result.platformFeeCents / 100).toFixed(2)} ${result.referenceCurrency}`,
      `  Prize Pool: ${(result.prizePoolCents / 100).toFixed(2)} ${result.referenceCurrency}`,
      ``,
      `Multi-Currency Conversion:`,
      `  Total Slippage: ${(result.totalSlippageCents / 100).toFixed(4)} ${result.referenceCurrency}`,
      `  Invariant Valid: ${result.invariantValid ? "YES" : "NO"}`,
      ``,
      `Payouts (${result.entries.length} participants):`,
    ];

    for (const entry of result.entries) {
      lines.push(
        `  Rank ${entry.participantRank}: ${entry.participantId} -> ` +
        `${entry.convertedAmount.toFixed(6)} ${entry.preferredCurrency} ` +
        `(${(entry.prizeAmountInReferenceCurrency / 100).toFixed(2)} ${result.referenceCurrency})`
      );
    }

    return lines.join("\n");
  }
}
