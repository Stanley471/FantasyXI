import { logger } from './logger';
import { CircuitBreakerState, CircuitBreakerStatus, DataProvider, FailoverEvent } from './types';

/**
 * Circuit breaker implementation for graceful degradation
 * Follows the circuit breaker pattern to manage failover to backup sources
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastError?: string;
  private transitionTime: number = Date.now();

  private readonly failureThreshold: number = 3; // Open after 3 consecutive failures
  private readonly recoveryThreshold: number; // Consecutive successes needed to close
  private readonly halfOpenProbes: number = 1; // Number of probes in half-open state before deciding

  private onStateChange?: (event: FailoverEvent) => Promise<void>;

  constructor(recoveryThreshold: number = 5) {
    this.recoveryThreshold = recoveryThreshold;
    logger.info({ state: this.state, recoveryThreshold }, 'Circuit breaker initialized');
  }

  /**
   * Register callback for state changes (for notifications)
   */
  public onStateChangeListener(callback: (event: FailoverEvent) => Promise<void>): void {
    this.onStateChange = callback;
  }

  /**
   * Record a successful probe
   */
  public recordSuccess(): void {
    this.lastError = undefined;

    if (this.state === CircuitBreakerState.CLOSED) {
      // Still healthy, no action needed
      return;
    }

    this.successCount++;
    this.failureCount = 0;

    logger.debug(
      { state: this.state, successCount: this.successCount, threshold: this.recoveryThreshold },
      'Recorded success in non-closed state'
    );

    // Attempt to close if in half-open state
    if (this.state === CircuitBreakerState.HALF_OPEN && this.successCount >= this.halfOpenProbes) {
      this.transitionTo(CircuitBreakerState.CLOSED, 'Recovery verified - primary restored');
    }
  }

  /**
   * Record a failed probe
   */
  public recordFailure(error: string): void {
    this.lastError = error;
    this.failureCount++;
    this.successCount = 0;

    logger.debug(
      { state: this.state, failureCount: this.failureCount, threshold: this.failureThreshold, error },
      'Recorded failure'
    );

    if (this.state === CircuitBreakerState.CLOSED && this.failureCount >= this.failureThreshold) {
      this.transitionTo(CircuitBreakerState.OPEN, `Failure threshold reached: ${error}`);
    }
  }

  /**
   * Attempt to transition to half-open state (testing recovery)
   */
  public testRecovery(): void {
    if (this.state !== CircuitBreakerState.OPEN) {
      return;
    }

    logger.info('Attempting to test recovery with half-open state');
    this.successCount = 0;
    this.failureCount = 0;
    this.transitionTo(CircuitBreakerState.HALF_OPEN, 'Testing recovery');
  }

  /**
   * Transition to a new state with notification
   */
  private async transitionTo(newState: CircuitBreakerState, reason: string): Promise<void> {
    if (this.state === newState) {
      return;
    }

    const oldState = this.state;
    this.state = newState;
    this.transitionTime = Date.now();
    this.failureCount = 0;
    this.successCount = 0;

    const fromProvider: DataProvider = oldState === CircuitBreakerState.CLOSED ? 'PRIMARY' : 'BACKUP';
    const toProvider: DataProvider = newState === CircuitBreakerState.CLOSED ? 'PRIMARY' : 'BACKUP';

    logger.warn(
      { from: oldState, to: newState, reason, timestamp: this.transitionTime },
      'Circuit breaker state transition'
    );

    if (this.onStateChange) {
      await this.onStateChange({
        type: newState === CircuitBreakerState.CLOSED ? 'RECOVERY' : 'FAILOVER',
        fromProvider,
        toProvider,
        reason,
        timestamp: this.transitionTime,
      });
    }
  }

  /**
   * Get current state
   */
  public getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get current status
   */
  public getStatus(): CircuitBreakerStatus {
    return {
      state: this.state,
      transitionTime: this.transitionTime,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastError: this.lastError,
    };
  }

  /**
   * Is circuit breaker open (should use backup)?
   */
  public isOpen(): boolean {
    return this.state === CircuitBreakerState.OPEN || this.state === CircuitBreakerState.HALF_OPEN;
  }

  /**
   * Is in half-open state (testing recovery)?
   */
  public isHalfOpen(): boolean {
    return this.state === CircuitBreakerState.HALF_OPEN;
  }

  /**
   * Reset to closed state (manual override)
   */
  public reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastError = undefined;
    this.transitionTime = Date.now();
    logger.info('Circuit breaker manually reset to CLOSED state');
  }
}
