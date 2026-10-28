/**
 * Adaptive Soroban inclusion-fee oracle.
 *
 * Samples Soroban RPC `getFeeStats`, smooths the observed surge percentile
 * with an asymmetric exponential moving average (fast to escalate during
 * gameweek-deadline spikes, slow to decay afterwards), applies a safety
 * headroom and clamps the result to [minFee, maxFee]. When telemetry is
 * missing, failing or stale, a conservative fallback fee is returned instead.
 */

import { BASE_FEE, type rpc } from "@stellar/stellar-sdk";

export interface FeeStatsSource {
  getFeeStats(): Promise<rpc.Api.GetFeeStatsResponse>;
}

export interface SorobanFeeOracleOptions {
  /** Lower bound for any estimate, in stroops. */
  minFee?: number;
  /** Upper bound for any estimate, in stroops. */
  maxFee?: number;
  /** Fee used when telemetry is unavailable or stale, in stroops. */
  fallbackFee?: number;
  /** Smoothing factor applied when fees rise (0..1, higher reacts faster). */
  escalationAlpha?: number;
  /** Smoothing factor applied when fees fall (0..1, lower decays slower). */
  decayAlpha?: number;
  /** Multiplier applied on top of the smoothed fee. */
  headroom?: number;
  /** Minimum interval between RPC samples. */
  refreshIntervalMs?: number;
  /** Age after which the last successful sample is no longer trusted. */
  staleAfterMs?: number;
  now?: () => number;
}

export const FEE_ORACLE_DEFAULTS = {
  minFee: Number(BASE_FEE),
  maxFee: 1_000_000,
  fallbackFee: 10_000,
  escalationAlpha: 0.6,
  decayAlpha: 0.2,
  headroom: 1.25,
  refreshIntervalMs: 5_000,
  staleAfterMs: 60_000,
} as const;

export class SorobanFeeOracle {
  private readonly config: Required<Omit<SorobanFeeOracleOptions, "now">>;
  private readonly now: () => number;
  private smoothedFee?: number;
  private lastSampleAt?: number;
  private lastAttemptAt?: number;
  private inFlight?: Promise<void>;

  constructor(private readonly source: FeeStatsSource, options: SorobanFeeOracleOptions = {}) {
    const { now, ...rest } = options;
    this.config = { ...FEE_ORACLE_DEFAULTS, ...rest };
    this.now = now ?? Date.now;
    if (this.config.minFee > this.config.maxFee) {
      throw new Error("SorobanFeeOracle minFee must not exceed maxFee");
    }
  }

  /** Records one fee observation (stroops) into the smoothing filter. */
  public observe(observedFee: number): void {
    if (!Number.isFinite(observedFee) || observedFee <= 0) {
      throw new Error(`Invalid fee observation: ${observedFee}`);
    }
    if (this.smoothedFee === undefined) {
      this.smoothedFee = observedFee;
    } else {
      const alpha =
        observedFee > this.smoothedFee ? this.config.escalationAlpha : this.config.decayAlpha;
      this.smoothedFee = alpha * observedFee + (1 - alpha) * this.smoothedFee;
    }
    this.lastSampleAt = this.now();
  }

  /** Polls RPC fee stats once and feeds the surge percentile into the filter. */
  public async sample(): Promise<void> {
    this.lastAttemptAt = this.now();
    const stats = await this.source.getFeeStats();
    const distribution = stats.sorobanInclusionFee;
    // An idle network reports zero transactions; its percentiles carry no signal.
    if (Number(distribution.transactionCount) === 0) {
      this.observe(this.config.minFee);
      return;
    }
    this.observe(Math.max(Number(distribution.p90), Number(distribution.mode)));
  }

  /** Current estimate (stroops) without touching the network. */
  public currentEstimate(): number {
    const stale =
      this.smoothedFee === undefined ||
      this.lastSampleAt === undefined ||
      this.now() - this.lastSampleAt > this.config.staleAfterMs;
    const fee = stale ? this.config.fallbackFee : this.smoothedFee! * this.config.headroom;
    return Math.min(this.config.maxFee, Math.max(this.config.minFee, Math.ceil(fee)));
  }

  /** Refreshes telemetry when due and returns the inclusion fee as a string. */
  public async estimateInclusionFee(): Promise<string> {
    const due =
      this.lastAttemptAt === undefined ||
      this.now() - this.lastAttemptAt >= this.config.refreshIntervalMs;
    if (due) {
      this.inFlight ??= this.sample()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight = undefined;
        });
      await this.inFlight;
    }
    return this.currentEstimate().toString();
  }
}
