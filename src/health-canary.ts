import axios, { AxiosInstance } from 'axios';
import { logger } from './logger';
import { validateFPLSchema, isSignificantSchemaChange } from './schema-validator';
import { CircuitBreaker } from './circuit-breaker';
import {
  HealthCheckResult,
  DegradationIndicator,
  CanaryMetrics,
  DataProvider,
  FailoverEvent,
} from './types';

/**
 * Health canary service that monitors FPL API health
 * Detects rate limiting, timeouts, schema changes, and other degradation indicators
 */
export class HealthCanary {
  private axiosInstance: AxiosInstance;
  private baseUrl: string;
  private probeIntervalMs: number;
  private probeTimeoutMs: number;
  private healthCheckThresholdMs: number;

  private circuitBreaker: CircuitBreaker;
  private currentProvider: DataProvider = 'PRIMARY';

  private probesExecuted: number = 0;
  private probesSucceeded: number = 0;
  private probesFailed: number = 0;
  private responseTimeHistory: number[] = [];
  private degradationIndicators: DegradationIndicator[] = [];

  private probeIntervalId?: NodeJS.Timeout;
  private recoveryTestIntervalId?: NodeJS.Timeout;

  private onFailover?: (event: FailoverEvent) => Promise<void>;

  constructor(
    baseUrl: string,
    probeIntervalMs: number = 30000,
    probeTimeoutMs: number = 3000,
    healthCheckThresholdMs: number = 3000,
    recoveryThresholdProbes: number = 5
  ) {
    this.baseUrl = baseUrl;
    this.probeIntervalMs = probeIntervalMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.healthCheckThresholdMs = healthCheckThresholdMs;

    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: this.probeTimeoutMs,
    });

    this.circuitBreaker = new CircuitBreaker(recoveryThresholdProbes);
    this.circuitBreaker.onStateChangeListener(this.handleStateChange.bind(this));

    logger.info(
      {
        baseUrl,
        probeIntervalMs,
        probeTimeoutMs,
        healthCheckThresholdMs,
        recoveryThresholdProbes,
      },
      'Health canary initialized'
    );
  }

  /**
   * Register callback for failover events
   */
  public onFailoverListener(callback: (event: FailoverEvent) => Promise<void>): void {
    this.onFailover = callback;
  }

  /**
   * Start periodic health checks
   */
  public start(): void {
    if (this.probeIntervalId) {
      logger.warn('Health canary already running');
      return;
    }

    logger.info({ intervalMs: this.probeIntervalMs }, 'Starting health canary probes');

    // Initial probe
    this.probe().catch((err) => {
      logger.error({ err }, 'Initial probe failed');
    });

    // Schedule periodic probes
    this.probeIntervalId = setInterval(() => {
      this.probe().catch((err) => {
        logger.error({ err }, 'Scheduled probe failed');
      });
    }, this.probeIntervalMs);

    // Schedule recovery testing when circuit is open
    this.recoveryTestIntervalId = setInterval(() => {
      if (this.circuitBreaker.getState() === 'OPEN') {
        logger.debug('Attempting recovery test (half-open transition)');
        this.circuitBreaker.testRecovery();
      }
    }, this.probeIntervalMs * 2); // Test recovery less frequently
  }

  /**
   * Stop health checks
   */
  public stop(): void {
    if (this.probeIntervalId) {
      clearInterval(this.probeIntervalId);
      this.probeIntervalId = undefined;
    }

    if (this.recoveryTestIntervalId) {
      clearInterval(this.recoveryTestIntervalId);
      this.recoveryTestIntervalId = undefined;
    }

    logger.info('Health canary probes stopped');
  }

  /**
   * Execute a single health probe
   */
  private async probe(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const endpoint = process.env.FPL_BOOTSTRAP_ENDPOINT || '/bootstrap-static/';

    try {
      const response = await this.axiosInstance.get(endpoint, {
        timeout: this.probeTimeoutMs,
      });

      const responseTimeMs = Date.now() - startTime;
      const schemaValidation = validateFPLSchema(response.data);

      const result: HealthCheckResult = {
        timestamp: startTime,
        statusCode: response.status,
        responseTimeMs,
        isHealthy: response.status === 200 && schemaValidation.isValid && responseTimeMs <= this.healthCheckThresholdMs,
        schemaValid: schemaValidation.isValid,
      };

      // Analyze health indicators
      if (response.status === 429) {
        this.addDegradationIndicator('RATE_LIMIT', 'HIGH', 'Rate limit detected (HTTP 429)');
        result.isHealthy = false;
      }

      if (responseTimeMs > this.healthCheckThresholdMs) {
        this.addDegradationIndicator('TIMEOUT', 'MEDIUM', `Response time ${responseTimeMs}ms exceeds threshold ${this.healthCheckThresholdMs}ms`);
        result.isHealthy = false;
      }

      if (!schemaValidation.isValid && isSignificantSchemaChange(schemaValidation)) {
        this.addDegradationIndicator('SCHEMA_CHANGE', 'HIGH', `Schema validation failed: ${JSON.stringify(schemaValidation)}`);
        result.isHealthy = false;
      }

      if (!result.isHealthy) {
        result.error = this.degradationIndicators[this.degradationIndicators.length - 1]?.message;
      }

      this.recordProbeResult(result);
      return result;
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage = axios.isAxiosError(error)
        ? `${error.response?.status || 'Unknown'}: ${error.message}`
        : error instanceof Error
          ? error.message
          : 'Unknown error';

      let errorType: 'TIMEOUT' | 'HTTP_ERROR' = 'HTTP_ERROR';
      if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
        errorType = 'TIMEOUT';
        this.addDegradationIndicator('TIMEOUT', 'HIGH', `Probe timeout after ${responseTimeMs}ms`);
      } else if (axios.isAxiosError(error) && error.response?.status === 502) {
        this.addDegradationIndicator('HTTP_ERROR', 'HIGH', 'Bad Gateway (HTTP 502)');
      } else {
        this.addDegradationIndicator('HTTP_ERROR', 'HIGH', `HTTP error: ${errorMessage}`);
      }

      const result: HealthCheckResult = {
        timestamp: Date.now(),
        statusCode: axios.isAxiosError(error) ? error.response?.status || 0 : 0,
        responseTimeMs,
        isHealthy: false,
        error: errorMessage,
        schemaValid: false,
      };

      this.recordProbeResult(result);
      return result;
    }
  }

  /**
   * Record probe result and update circuit breaker
   */
  private recordProbeResult(result: HealthCheckResult): void {
    this.probesExecuted++;

    if (result.isHealthy) {
      this.probesSucceeded++;
      this.circuitBreaker.recordSuccess();
    } else {
      this.probesFailed++;
      this.circuitBreaker.recordFailure(result.error || 'Unknown error');
    }

    // Track response times for metrics
    this.responseTimeHistory.push(result.responseTimeMs);
    if (this.responseTimeHistory.length > 100) {
      this.responseTimeHistory.shift();
    }

    const metrics = this.getMetrics();
    logger.debug(
      {
        probe: result,
        circuitBreaker: this.circuitBreaker.getStatus(),
        metrics: {
          probesExecuted: metrics.probesExecuted,
          successRate: `${((metrics.probesSucceeded / metrics.probesExecuted) * 100).toFixed(2)}%`,
          avgResponseTime: `${metrics.averageResponseTimeMs.toFixed(0)}ms`,
        },
      },
      'Health probe completed'
    );
  }

  /**
   * Add a degradation indicator
   */
  private addDegradationIndicator(type: 'RATE_LIMIT' | 'TIMEOUT' | 'SCHEMA_CHANGE' | 'HTTP_ERROR', severity: 'LOW' | 'MEDIUM' | 'HIGH', message: string): void {
    const indicator: DegradationIndicator = {
      type,
      severity,
      message,
      timestamp: Date.now(),
    };

    this.degradationIndicators.push(indicator);

    // Keep only last 50 indicators
    if (this.degradationIndicators.length > 50) {
      this.degradationIndicators.shift();
    }

    logger.warn({ indicator }, 'Degradation indicator detected');
  }

  /**
   * Handle circuit breaker state changes
   */
  private async handleStateChange(event: FailoverEvent): Promise<void> {
    const newProvider = event.toProvider;
    this.currentProvider = newProvider;

    logger.info({ event }, 'Circuit breaker state change triggering failover');

    if (this.onFailover) {
      await this.onFailover(event);
    }
  }

  /**
   * Get current health metrics
   */
  public getMetrics(): CanaryMetrics {
    const avgResponseTime =
      this.responseTimeHistory.length > 0
        ? this.responseTimeHistory.reduce((a, b) => a + b, 0) / this.responseTimeHistory.length
        : 0;

    return {
      probesExecuted: this.probesExecuted,
      probesSucceeded: this.probesSucceeded,
      probesFailed: this.probesFailed,
      averageResponseTimeMs: avgResponseTime,
      lastProbeTime: Date.now(),
      currentProvider: this.currentProvider,
      degradationIndicators: [...this.degradationIndicators],
    };
  }

  /**
   * Get current circuit breaker status
   */
  public getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }

  /**
   * Check if primary data source is healthy
   */
  public isPrimaryHealthy(): boolean {
    return !this.circuitBreaker.isOpen();
  }

  /**
   * Get the current data provider to use
   */
  public getCurrentProvider(): DataProvider {
    return this.currentProvider;
  }
}
