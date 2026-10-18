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
 * Half-open health probing (issue #275):
 * - Only one probe request is let through while HALF_OPEN; concurrent callers
 *   short-circuit to their fallback instead of stampeding a recovering upstream.
 * - The first cooldown after tripping can be jittered (cooldownJitterRatio)
 *   so multiple API instances do not probe in lockstep.
 * - Each failed probe re-opens the circuit with a decorrelated-jitter cooldown
 *   that grows toward maxCooldownMs, backing off a persistently-down upstream.
 * - Lifetime counters (getStats) feed the admin telemetry endpoint.
 */

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export class CircuitBreakerOpenError extends Error {
  public readonly remainingCooldownMs: number;

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
  /** Upper bound for the cooldown after repeated failed half-open probes. Default 8x cooldownPeriodMs. */
  maxCooldownMs?: number;
  /** Random extra fraction (0-1) added to the first cooldown after tripping. Default 0. */
  cooldownJitterRatio?: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number | null;
  nextAttemptTime: number;
  remainingCooldownMs: number;
  currentCooldownMs: number;
  lastStateChangeAt: number | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  /** Requests answered without calling upstream because the circuit was open. */
  totalShortCircuited: number;
  timesOpened: number;
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
  private currentCooldownMs = 0;
  private probeInFlight = false;
  private lastStateChangeAt: number | null = null;
  private totalRequests = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalShortCircuited = 0;
  private timesOpened = 0;

  public readonly failureThreshold: number;
  public readonly cooldownPeriodMs: number;
  public readonly successThreshold: number;
  public readonly baseBackoffMs: number;
  public readonly maxBackoffMs: number;
  public readonly maxCooldownMs: number;
  public readonly cooldownJitterRatio: number;
  private onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownPeriodMs = options.cooldownPeriodMs ?? 30000;
    this.successThreshold = options.successThreshold ?? 1;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.maxCooldownMs = Math.max(
      this.cooldownPeriodMs,
      options.maxCooldownMs ?? this.cooldownPeriodMs * 8
    );
    this.cooldownJitterRatio = Math.min(Math.max(options.cooldownJitterRatio ?? 0, 0), 1);
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

  public getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
      remainingCooldownMs: this.getRemainingCooldownMs(),
      currentCooldownMs: this.currentCooldownMs,
      lastStateChangeAt: this.lastStateChangeAt,
      totalRequests: this.totalRequests,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalShortCircuited: this.totalShortCircuited,
      timesOpened: this.timesOpened,
    };
  }

  /**
   * Cooldown before the next half-open probe. Tripping from CLOSED waits the
   * base cooldown (plus optional jitter); re-opening after a failed probe
   * grows the wait with decorrelated jitter, capped at maxCooldownMs.
   */
  private nextCooldownMs(fromState: CircuitState): number {
    if (fromState === CircuitState.HALF_OPEN && this.currentCooldownMs > 0) {
      return calculateDecorrelatedJitter(
        this.currentCooldownMs,
        this.cooldownPeriodMs,
        this.maxCooldownMs
      );
    }
    const jitter = Math.floor(Math.random() * this.cooldownPeriodMs * this.cooldownJitterRatio);
    return Math.min(this.maxCooldownMs, this.cooldownPeriodMs + jitter);
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
      this.currentCooldownMs = 0;
    } else if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses = 0;
    } else if (newState === CircuitState.OPEN) {
      this.currentCooldownMs = this.nextCooldownMs(oldState);
      this.nextAttemptTime = Date.now() + this.currentCooldownMs;
      this.timesOpened++;
    }
    if (this.onStateChange) {
      this.onStateChange(oldState, newState);
    }
  }

  public recordSuccess(): void {
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
    this.lastFailureTime = Date.now();
    this.consecutiveFailures++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED && this.consecutiveFailures >= this.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
    }
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
   * If the circuit is open, immediately invokes the fallback (if provided) or throws CircuitBreakerOpenError.
   */
  public async execute<T>(
    action: () => Promise<T>,
    fallback?: () => Promise<T> | T
  ): Promise<T> {
    const currentState = this.getState();
    this.totalRequests++;

    // While HALF_OPEN a single probe tests the upstream; everyone else waits it out
    const shortCircuit =
      currentState === CircuitState.OPEN ||
      (currentState === CircuitState.HALF_OPEN && this.probeInFlight);

    if (shortCircuit) {
      this.totalShortCircuited++;
      const remaining = this.getRemainingCooldownMs();
      if (fallback) {
        return await fallback();
      }
      throw new CircuitBreakerOpenError(
        `FPL API Circuit Breaker is ${currentState}. Skipping request. Try again in ${Math.ceil(remaining / 1000)}s.`,
        remaining
      );
    }

    const isProbe = currentState === CircuitState.HALF_OPEN;
    if (isProbe) this.probeInFlight = true;

    try {
      const result = await action();
      this.totalSuccesses++;
      this.recordSuccess();
      return result;
    } catch (err) {
      this.totalFailures++;
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
