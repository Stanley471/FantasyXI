/**
 * Health check result types
 */
export interface HealthCheckResult {
  timestamp: number;
  statusCode: number;
  responseTimeMs: number;
  isHealthy: boolean;
  error?: string;
  schemaValid: boolean;
}

/**
 * Circuit breaker states
 */
export enum CircuitBreakerState {
  CLOSED = 'CLOSED',         // Normal operation, using primary
  OPEN = 'OPEN',             // Degradation detected, using backup
  HALF_OPEN = 'HALF_OPEN',   // Testing recovery
}

/**
 * Circuit breaker status
 */
export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  transitionTime: number;
  failureCount: number;
  successCount: number;
  lastError?: string;
}

/**
 * Degradation indicators
 */
export interface DegradationIndicator {
  type: 'RATE_LIMIT' | 'TIMEOUT' | 'SCHEMA_CHANGE' | 'HTTP_ERROR';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  message: string;
  timestamp: number;
}

/**
 * Data provider type
 */
export type DataProvider = 'PRIMARY' | 'BACKUP' | 'FALLBACK';

/**
 * Canary probe metrics
 */
export interface CanaryMetrics {
  probesExecuted: number;
  probesSucceeded: number;
  probesFailed: number;
  averageResponseTimeMs: number;
  lastProbeTime: number;
  currentProvider: DataProvider;
  degradationIndicators: DegradationIndicator[];
}

/**
 * Failover event for notifications
 */
export interface FailoverEvent {
  type: 'FAILOVER' | 'RECOVERY';
  fromProvider: DataProvider;
  toProvider: DataProvider;
  reason?: string;
  timestamp: number;
  metrics?: CanaryMetrics;
}

/**
 * Schema validation result
 */
export interface SchemaValidationResult {
  isValid: boolean;
  missingFields?: string[];
  extraFields?: string[];
  typeErrors?: Record<string, string>;
}
