import { PrizeDistribution } from "../../types/index.js";

export type PrizePreset = "standard" | "winner-takes-all" | "top-five" | "custom";

export interface PrizeOptions {
  preset?: PrizePreset;
  /** Rank weights in basis points. Must total 10,000 for custom distributions. */
  customSplitsBps?: number[];
}

/** Deterministic payout calculations in cents; no floating-point allocation. */
export class PrizeService {
  public static readonly PLATFORM_FEE_PERCENT = 5;
  public static readonly STANDARD_SPLITS_BPS = [6000, 3000, 1000];
  public static readonly TWO_PLAYER_SPLITS_BPS = [7000, 3000];
  public static readonly TOP_FIVE_SPLITS_BPS = [4500, 2500, 1500, 1000, 500];

  public static parsePreset(value: string): PrizePreset {
    if (["standard", "winner-takes-all", "top-five", "custom"].includes(value)) return value as PrizePreset;
    throw new Error("Unknown prize distribution preset");
  }

  /** Serialize rank weights as Soroban u32 basis-point arguments. */
  public static encodeSorobanDistribution(splitsBps: number[]): number[] {
    this.validateSplits(splitsBps);
    return [...splitsBps];
  }

  /** Derive on-chain weights for an already tie-adjusted, exact-cent payout list. */
  public static encodeSorobanPayoutAmounts(payouts: number[], prizePool: number): number[] {
    const poolCents = Math.round(prizePool * 100);
    const payoutCents = payouts.map((amount) => Math.round(amount * 100));
    if (poolCents <= 0 || payoutCents.length === 0 || payoutCents.some((amount) => amount < 0) || payoutCents.reduce((sum, amount) => sum + amount, 0) !== poolCents) {
      throw new Error("Payout amounts must exactly equal a positive net prize pool");
    }
    let remainingBps = 10_000;
    const encoded = payoutCents.map((amount, index) => {
      if (index === payoutCents.length - 1) return remainingBps;
      const basisPoints = Math.ceil(amount * 10_000 / poolCents);
      const representedCents = Math.floor(poolCents * basisPoints / 10_000);
      if (representedCents !== amount || basisPoints > remainingBps) {
        throw new Error("Tie-adjusted payouts cannot be represented by Soroban basis points");
      }
      remainingBps -= basisPoints;
      return basisPoints;
    });
    this.validateSplits(encoded);
    return encoded;
  }

  public static validateSplits(splitsBps: number[]): void {
    if (
      splitsBps.length === 0 ||
      splitsBps.some((value) => !Number.isInteger(value) || value < 0 || value > 10_000) ||
      splitsBps.reduce((sum, value) => sum + value, 0) !== 10_000
    ) {
      throw new Error("Prize splits must be non-negative integer basis points totaling 10000");
    }
  }

  public static calculatePrizeDistribution(
    participantCount: number,
    entryFee: number,
    options: PrizeOptions = {}
  ): PrizeDistribution & { payouts: number[]; splitsBps: number[] } {
    if (!Number.isFinite(participantCount) || participantCount < 0 || !Number.isFinite(entryFee) || entryFee < 0) {
      throw new Error("Participant count and entry fee must be non-negative");
    }
    const count = Math.floor(participantCount);
    const feeInCents = Math.round(entryFee * 100);
    const grossCents = count * feeInCents;
    const platformFeeCents = Math.round(grossCents * this.PLATFORM_FEE_PERCENT / 100);
    const prizePoolCents = grossCents - platformFeeCents;
    let splitsBps: number[];
    if (options.preset === "custom") {
      if (!options.customSplitsBps) throw new Error("Custom prize splits are required");
      this.validateSplits(options.customSplitsBps);
      splitsBps = [...options.customSplitsBps];
    } else if (options.preset === "winner-takes-all") {
      splitsBps = [10_000];
    } else if (options.preset === "top-five") {
      const tiers = this.TOP_FIVE_SPLITS_BPS.slice(0, Math.min(count, 5));
      const weight = tiers.reduce((sum, value) => sum + value, 0);
      splitsBps = tiers.map((value, index) => index === tiers.length - 1
        ? 10_000 - tiers.slice(0, index).reduce((sum, prior) => sum + Math.floor(prior * 10_000 / weight), 0)
        : Math.floor(value * 10_000 / weight));
    } else if (options.preset === undefined || options.preset === "standard") {
      splitsBps = count === 1 ? [10_000] : count === 2 ? [...this.TWO_PLAYER_SPLITS_BPS] : [...this.STANDARD_SPLITS_BPS];
    } else {
      throw new Error("Unknown prize distribution preset");
    }
    if (count > 0 && count < splitsBps.length) {
      const availableTiers = splitsBps.slice(0, count);
      const availableWeight = availableTiers.reduce((sum, value) => sum + value, 0);
      splitsBps = availableTiers.map((value, index) => index === availableTiers.length - 1
        ? 10_000 - availableTiers.slice(0, index).reduce((sum, prior) => sum + Math.floor(prior * 10_000 / availableWeight), 0)
        : Math.floor(value * 10_000 / availableWeight));
    }
    const payoutsCents = splitsBps.map((basisPoints, index) => {
      if (index === splitsBps.length - 1) return prizePoolCents - splitsBps.slice(0, index).reduce((sum, prior) => sum + Math.floor(prizePoolCents * prior / 10_000), 0);
      return Math.floor(prizePoolCents * basisPoints / 10_000);
    });
    const payouts = payoutsCents.map((value) => value / 100);
    return {
      participantCount: count,
      entryFee: feeInCents / 100,
      grossTotal: grossCents / 100,
      platformFee: platformFeeCents / 100,
      prizePool: prizePoolCents / 100,
      prizes: { first: payouts[0] ?? 0, second: payouts[1] ?? 0, third: payouts[2] ?? 0 },
      payouts,
      splitsBps,
    };
  }
}
