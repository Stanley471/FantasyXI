/**
 * Circuit Breaker and Adaptive Backoff for FPL Upstream API.
 *
 * Implements a state machine (CLOSED, OPEN, HALF_OPEN) with:
 * - Consecutive failure thresholds for upstream 5xx/429 errors
 * - Non-blocking rapid failure while OPEN (no unnecessary network calls)
 * - Automatic probe trial in HALF_OPEN after cooldown period
 * - Decorrelated jitter backoff calculation
 * - Fallback to cached/stale data
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
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
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
  private currentCooldownMs: number;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalFallbacks = 0;
  private openTransitions = 0;
  private halfOpenProbes = 0;
  private lastErrorMessage: string | null = null;

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

  public recordFallbackServed(): void {
    this.totalFallbacks++;
  }

  public getStats() {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
      remainingCooldownMs: this.getRemainingCooldownMs(),
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalFallbacks: this.totalFallbacks,
      openTransitions: this.openTransitions,
      halfOpenProbes: this.halfOpenProbes,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    if (newState === CircuitState.CLOSED) {
      this.consecutiveFailures = 0;
      this.halfOpenSuccesses = 0;
      this.nextAttemptTime = 0;
      this.currentCooldownMs = this.cooldownPeriodMs;
    } else if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses = 0;
      this.halfOpenProbes++;
    } else if (newState === CircuitState.OPEN) {
      this.openTransitions++;
      const jitter =
        oldState === CircuitState.HALF_OPEN
          ? calculateDecorrelatedJitter(
              this.currentCooldownMs,
              this.cooldownPeriodMs,
              Math.max(this.maxBackoffMs, this.cooldownPeriodMs * 4)
            )
          : this.cooldownPeriodMs;
      this.currentCooldownMs = jitter;
      this.nextAttemptTime = Date.now() + jitter;
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
    this.totalFailures++;
    if (error instanceof Error) {
      this.lastErrorMessage = error.message;
    }

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
    this.totalRequests++;
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      const remaining = this.getRemainingCooldownMs();
      if (fallback) {
        this.recordFallbackServed();
        return await fallback();
      }
      throw new CircuitBreakerOpenError(
        `FPL API Circuit Breaker is OPEN. Skipping request. Try again in ${Math.ceil(remaining / 1000)}s.`,
        remaining
      );
    }

    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (fallback) {
        this.recordFallbackServed();
        return await fallback();
      }
      throw err;
    }
  }
}
