/**
 * Circuit Breaker and Adaptive Backoff for FPL Upstream API.
 *
 * Implements a state machine (CLOSED, OPEN, HALF_OPEN) with:
 * - Consecutive failure thresholds for upstream 5xx/429 errors
 * - Non-blocking rapid failure while OPEN (no unnecessary network calls)
 * - Automatic probe trial in HALF_OPEN after cooldown period
 * - Decorrelated jitter backoff calculation
 * - Fallback to cached/stale data
 *
 * Issue #275 additions:
 * - Every failed HALF_OPEN probe re-opens the circuit with a decorrelated-jitter
 *   cooldown (capped at maxCooldownMs), so instances do not re-probe a
 *   struggling upstream in lockstep.
 * - HALF_OPEN admits a single in-flight probe; concurrent calls are
 *   short-circuited instead of stampeding the recovering upstream.
 * - An optional `probe` runs automatically when the cooldown elapses, so the
 *   circuit recovers (HALF_OPEN -> CLOSED) even when no traffic arrives.
 * - getStats() exposes rolling failure rate and lifetime totals for telemetry.
 */

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export class CircuitBreakerOpenError extends Error {
  public readonly remainingCooldownMs: number;
  /** Read by the global error handler: an open circuit is a 503, not a 500 */
  public readonly statusCode = 503;

  constructor(message: string, remainingCooldownMs: number) {
    super(message);
    this.name = "CircuitBreakerOpenError";
    this.remainingCooldownMs = remainingCooldownMs;
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownPeriodMs?: number;
  successThreshold?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  /** Sliding-window error ratio used when set; takes precedence over failureThreshold. */
  failureRateThreshold?: number;
  rollingWindowMs?: number;
  minimumSamples?: number;
  /** Cap for the jittered cooldown after repeated failed probes. Default 5 minutes. */
  maxCooldownMs?: number;
  /** Health check run automatically once the cooldown elapses (unref'd timer). */
  probe?: () => Promise<unknown>;
}

export function calculateDecorrelatedJitter(
  currentBackoff: number,
  baseBackoffMs = 1000,
  maxBackoffMs = 30000
): number {
  const minDelay = baseBackoffMs;
  const maxRange = Math.max(minDelay, currentBackoff * 3);
  const nextDelay = Math.floor(minDelay + Math.random() * (maxRange - minDelay + 1));
  return Math.min(maxBackoffMs, nextDelay);
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private nextAttemptTime = 0;
  private lastFailureTime: number | null = null;
  private readonly outcomes: Array<{ at: number; failed: boolean }> = [];
  private readonly failureRateThreshold?: number;
  private readonly rollingWindowMs: number;
  private readonly minimumSamples: number;
  private readonly maxCooldownMs: number;
  private readonly probe?: () => Promise<unknown>;
  private currentCooldownMs: number;
  private probeInFlight = false;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateChangeAt: number | null = null;
  private readonly totals = { successes: 0, failures: 0, shortCircuited: 0 };

  public readonly failureThreshold: number;
  public readonly cooldownPeriodMs: number;
  public readonly successThreshold: number;
  public readonly baseBackoffMs: number;
  public readonly maxBackoffMs: number;
  private onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownPeriodMs = options.cooldownPeriodMs ?? 30000;
    this.successThreshold = options.successThreshold ?? 1;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.failureRateThreshold = options.failureRateThreshold;
    this.rollingWindowMs = options.rollingWindowMs ?? 30_000;
    this.minimumSamples = options.minimumSamples ?? 4;
    this.maxCooldownMs = Math.max(options.maxCooldownMs ?? 5 * 60_000, this.cooldownPeriodMs);
    this.probe = options.probe;
    this.currentCooldownMs = this.cooldownPeriodMs;
    this.onStateChange = options.onStateChange;
  }

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttemptTime) {
      this.transitionTo(CircuitState.HALF_OPEN);
    }
    return this.state;
  }

  public isOpen(): boolean {
    return this.getState() === CircuitState.OPEN;
  }

  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  public getNextAttemptTime(): number {
    return this.nextAttemptTime;
  }

  public getRemainingCooldownMs(): number {
    if (this.state !== CircuitState.OPEN) return 0;
    return Math.max(0, this.nextAttemptTime - Date.now());
  }

  public getStats() {
    const now = Date.now();
    this.pruneOutcomes(now);
    const failures = this.outcomes.reduce((count, outcome) => count + Number(outcome.failed), 0);
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
      remainingCooldownMs: this.getRemainingCooldownMs(),
      currentCooldownMs: this.currentCooldownMs,
      lastStateChangeAt: this.lastStateChangeAt,
      /** Failure ratio over the rolling window; null before any sample */
      failureRate: this.outcomes.length > 0 ? failures / this.outcomes.length : null,
      windowSamples: this.outcomes.length,
      totals: { ...this.totals },
    };
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.lastStateChangeAt = Date.now();
    if (newState === CircuitState.CLOSED) {
      this.consecutiveFailures = 0;
      this.halfOpenSuccesses = 0;
      this.nextAttemptTime = 0;
      this.outcomes.length = 0;
      this.currentCooldownMs = this.cooldownPeriodMs;
      this.clearProbeTimer();
    } else if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses = 0;
    } else if (newState === CircuitState.OPEN) {
      // A failed probe means the upstream is still down: back off further
      this.currentCooldownMs =
        oldState === CircuitState.HALF_OPEN
          ? calculateDecorrelatedJitter(this.currentCooldownMs, this.cooldownPeriodMs, this.maxCooldownMs)
          : this.cooldownPeriodMs;
      this.nextAttemptTime = Date.now() + this.currentCooldownMs;
      this.armProbe(this.currentCooldownMs);
    }
    if (this.onStateChange) {
      this.onStateChange(oldState, newState);
    }
  }

  private armProbe(delayMs: number): void {
    if (!this.probe) return;
    this.clearProbeTimer();
    this.probeTimer = setTimeout(() => this.runScheduledProbe(), delayMs);
    // Never keeps the process alive on its own
    this.probeTimer.unref?.();
  }

  private clearProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private runScheduledProbe(): void {
    this.probeTimer = null;
    const state = this.getState();
    if (state === CircuitState.OPEN) {
      this.armProbe(this.getRemainingCooldownMs());
      return;
    }
    // A real request may already be the probe; its outcome drives the transition
    if (state !== CircuitState.HALF_OPEN || this.probeInFlight) return;
    // A failure is recorded by execute() and re-arms the next probe; with
    // successThreshold > 1 a success keeps probing until the circuit closes
    this.execute(this.probe!).then(
      () => {
        if (this.state === CircuitState.HALF_OPEN) this.armProbe(this.baseBackoffMs);
      },
      () => undefined
    );
  }

  public recordSuccess(): void {
    this.totals.successes++;
    this.recordOutcome(false);
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  public recordFailure(error?: unknown): void {
    this.totals.failures++;
    this.lastFailureTime = Date.now();
    this.consecutiveFailures++;
    this.recordOutcome(true);

    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED && this.shouldOpen()) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private recordOutcome(failed: boolean): void {
    const now = Date.now();
    this.outcomes.push({ at: now, failed });
    this.pruneOutcomes(now);
  }

  private pruneOutcomes(now: number): void {
    while (this.outcomes.length > 0 && this.outcomes[0].at <= now - this.rollingWindowMs) {
      this.outcomes.shift();
    }
  }

  private shouldOpen(): boolean {
    if (this.failureRateThreshold === undefined) return this.consecutiveFailures >= this.failureThreshold;
    this.pruneOutcomes(Date.now());
    if (this.outcomes.length < this.minimumSamples) return false;
    const failures = this.outcomes.reduce((count, outcome) => count + Number(outcome.failed), 0);
    return failures / this.outcomes.length > this.failureRateThreshold;
  }

  public trip(): void {
    this.consecutiveFailures = this.failureThreshold;
    this.transitionTo(CircuitState.OPEN);
  }

  public reset(): void {
    this.transitionTo(CircuitState.CLOSED);
  }

  public calculateNextBackoff(currentBackoff: number): number {
    return calculateDecorrelatedJitter(currentBackoff, this.baseBackoffMs, this.maxBackoffMs);
  }

  /**
   * Executes an asynchronous action through the circuit breaker.
   * If the circuit is open (or HALF_OPEN with its single probe already in
   * flight), immediately invokes the fallback (if provided) or throws CircuitBreakerOpenError.
   */
  public async execute<T>(
    action: () => Promise<T>,
    fallback?: () => Promise<T> | T
  ): Promise<T> {
    const currentState = this.getState();
    const isProbe = currentState === CircuitState.HALF_OPEN;

    if (currentState === CircuitState.OPEN || (isProbe && this.probeInFlight)) {
      this.totals.shortCircuited++;
      const remaining = this.getRemainingCooldownMs();
      if (fallback) {
        return await fallback();
      }
      throw new CircuitBreakerOpenError(
        `FPL API Circuit Breaker is OPEN. Skipping request. Try again in ${Math.ceil(remaining / 1000)}s.`,
        remaining
      );
    }

    if (isProbe) this.probeInFlight = true;
    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (fallback) {
        return await fallback();
      }
      throw err;
    } finally {
      if (isProbe) this.probeInFlight = false;
    }
  }
}
