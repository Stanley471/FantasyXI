import { dbConnectionPoolSize, dbConnectionPoolCapacity, dbQueryDuration, dbQueryTotal, dbSlowQueryCount } from "../../config/metrics.js";
import { getSlowQueryCount } from "../../config/db.js";

/**
 * Collects metrics from PostgreSQL connection pool and query performance.
 */
export class DbMetricsCollector {
  private static queryCount = 0;
  private static slowQueryCount = 0;

  /**
   * Update database connection pool metrics.
   * Should be called periodically or during health checks.
   */
  static updateConnectionPoolMetrics(currentConnections: number, maxConnections: number = 20): void {
    dbConnectionPoolSize.set(currentConnections);
    dbConnectionPoolCapacity.set(maxConnections);
  }

  /**
   * Record a database query execution.
   */
  static recordQueryExecution(model: string, operation: string, durationMs: number, success: boolean = true): void {
    const status = success ? "success" : "error";
    
    dbQueryDuration.labels(model, operation).observe(durationMs);
    dbQueryTotal.labels(model, operation, status).inc();
    
    // Track slow queries (>100ms)
    if (durationMs > 100) {
      this.slowQueryCount++;
    }
  }

  /**
   * Update slow query gauge from the database configuration.
   */
  static updateSlowQueryMetrics(): void {
    const slowCount = getSlowQueryCount();
    dbSlowQueryCount.set(slowCount);
  }

  /**
   * Get the total number of slow queries recorded since app start.
   */
  static getSlowQueryCount(): number {
    return this.slowQueryCount;
  }

  /**
   * Reset counters (useful for testing).
   */
  static reset(): void {
    this.queryCount = 0;
    this.slowQueryCount = 0;
  }
}
