import { CircuitBreaker } from '../circuit-breaker';
import { CircuitBreakerState } from '../types';

describe('Circuit Breaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker(3); // recovery threshold of 3
  });

  describe('state transitions', () => {
    it('should start in CLOSED state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(circuitBreaker.isOpen()).toBe(false);
    });

    it('should transition to OPEN after failure threshold', () => {
      circuitBreaker.recordFailure('Error 1');
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      circuitBreaker.recordFailure('Error 2');
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      circuitBreaker.recordFailure('Error 3');
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);
      expect(circuitBreaker.isOpen()).toBe(true);
    });

    it('should track last error', () => {
      circuitBreaker.recordFailure('Connection timeout');
      circuitBreaker.recordFailure('Rate limit exceeded');
      circuitBreaker.recordFailure('Invalid response');

      const status = circuitBreaker.getStatus();
      expect(status.lastError).toBe('Invalid response');
    });

    it('should transition to HALF_OPEN when testing recovery', () => {
      // Open the circuit
      circuitBreaker.recordFailure('Error 1');
      circuitBreaker.recordFailure('Error 2');
      circuitBreaker.recordFailure('Error 3');
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Test recovery
      circuitBreaker.testRecovery();
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);
      expect(circuitBreaker.isHalfOpen()).toBe(true);
    });

    it('should close circuit after recovery threshold successes in half-open', () => {
      // Open the circuit
      circuitBreaker.recordFailure('Error 1');
      circuitBreaker.recordFailure('Error 2');
      circuitBreaker.recordFailure('Error 3');
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Enter half-open state
      circuitBreaker.testRecovery();
      expect(circuitBreaker.isHalfOpen()).toBe(true);

      // Record success
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should ignore successes in closed state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      const status = circuitBreaker.getStatus();
      expect(status.successCount).toBe(0);
    });

    it('should reset failures when success is recorded in open state', () => {
      circuitBreaker.recordFailure('Error 1');
      circuitBreaker.recordFailure('Error 2');
      circuitBreaker.recordFailure('Error 3');

      circuitBreaker.testRecovery();
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.getStatus().failureCount).toBe(0);
    });
  });

  describe('manual reset', () => {
    it('should reset to CLOSED state', () => {
      circuitBreaker.recordFailure('Error 1');
      circuitBreaker.recordFailure('Error 2');
      circuitBreaker.recordFailure('Error 3');
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(circuitBreaker.getStatus().failureCount).toBe(0);
      expect(circuitBreaker.getStatus().lastError).toBeUndefined();
    });
  });

  describe('state change listeners', () => {
    it('should notify on failover', (done) => {
      const mockCallback = jest.fn();

      circuitBreaker.onStateChangeListener(async (event) => {
        mockCallback(event);
        expect(event.type).toBe('FAILOVER');
        expect(event.fromProvider).toBe('PRIMARY');
        expect(event.toProvider).toBe('BACKUP');
        done();
      });

      circuitBreaker.recordFailure('Error 1');
      circuitBreaker.recordFailure('Error 2');
      circuitBreaker.recordFailure('Error 3');

      expect(mockCallback).toHaveBeenCalled();
    });

    it('should notify on recovery', (done) => {
      const mockCallback = jest.fn();

      circuitBreaker.onStateChangeListener(async (event) => {
        if (event.type === 'RECOVERY') {
          mockCallback(event);
          expect(event.type).toBe('RECOVERY');
          expect(event.fromProvider).toBe('BACKUP');
          expect(event.toProvider).toBe('PRIMARY');
          done();
        }
      });

      // Open the circuit
      circuitBreaker.recordFailure('Error 1');
      circuitBreaker.recordFailure('Error 2');
      circuitBreaker.recordFailure('Error 3');

      // Recover
      circuitBreaker.testRecovery();
      circuitBreaker.recordSuccess();
    });
  });

  describe('status reporting', () => {
    it('should provide complete status information', () => {
      circuitBreaker.recordFailure('Test error');

      const status = circuitBreaker.getStatus();
      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('failureCount');
      expect(status).toHaveProperty('successCount');
      expect(status).toHaveProperty('transitionTime');
      expect(status).toHaveProperty('lastError');
    });
  });
});
