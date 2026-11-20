import * as client from "prom-client";

/**
 * Prometheus metrics collection for FantasyXI backend services.
 * Exports standard prom-client metrics with custom histograms and gauges
 * for HTTP request latency, database connection pool health, and BullMQ worker status.
 *
 * Metrics are exposed on /metrics endpoint, protected by service key authentication.
 */

// Register default metrics (process metrics, GC, etc)
client.collectDefaultMetrics();

// ============================================================
// HTTP Request Metrics
// ============================================================

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request latency in milliseconds",
  labelNames: ["method", "route", "status"],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

export const httpRequestTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
});

export const httpErrorTotal = new client.Counter({
  name: "http_errors_total",
  help: "Total HTTP errors by status code",
  labelNames: ["method", "route", "status"],
});

// ============================================================
// Database Metrics
// ============================================================

export const dbConnectionPoolSize = new client.Gauge({
  name: "db_connection_pool_size",
  help: "PostgreSQL connection pool size (current connections)",
});

export const dbConnectionPoolCapacity = new client.Gauge({
  name: "db_connection_pool_capacity",
  help: "PostgreSQL connection pool maximum capacity",
});

export const dbQueryDuration = new client.Histogram({
  name: "db_query_duration_ms",
  help: "Database query duration in milliseconds",
  labelNames: ["model", "operation"],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});

export const dbQueryTotal = new client.Counter({
  name: "db_queries_total",
  help: "Total database queries",
  labelNames: ["model", "operation", "status"],
});

export const dbSlowQueryCount = new client.Gauge({
  name: "db_slow_queries_total",
  help: "Total slow queries (>100ms) in the current minute",
});

// ============================================================
// Redis/Queue Metrics
// ============================================================

export const redisConnectionActive = new client.Gauge({
  name: "redis_connections_active",
  help: "Active Redis connections",
  labelNames: ["purpose"],
});

export const bullQueueDepth = new client.Gauge({
  name: "bull_queue_depth",
  help: "BullMQ job queue depth (pending jobs)",
  labelNames: ["queue"],
});

export const bullQueueProcessingCount = new client.Gauge({
  name: "bull_queue_processing",
  help: "BullMQ jobs currently being processed",
  labelNames: ["queue"],
});

export const bullJobDuration = new client.Histogram({
  name: "bull_job_duration_ms",
  help: "BullMQ job processing duration in milliseconds",
  labelNames: ["queue", "status"],
  buckets: [100, 500, 1000, 5000, 10000, 30000, 60000],
});

// ============================================================
// Application Metrics
// ============================================================

export const appUptime = new client.Gauge({
  name: "app_uptime_seconds",
  help: "Application uptime in seconds",
});

export const appVersion = new client.Gauge({
  name: "app_version_info",
  help: "Application version and build info",
  labelNames: ["version", "environment"],
});

/**
 * Collect and return Prometheus formatted metrics.
 * Calls register.metrics() to format all registered metrics in text format.
 */
export async function collectMetrics(): Promise<string> {
  return await client.register.metrics();
}

/**
 * Get content type for Prometheus metrics response.
 */
export function getMetricsContentType(): string {
  return client.register.contentType;
}

/**
 * Reset metrics (useful for testing).
 */
export function resetMetrics(): void {
  client.register.resetMetrics();
}

/**
 * Get detailed registry metrics in JSON format (for debugging).
 */
export async function getMetricsJson(): Promise<client.MetricPresentation[]> {
  return await client.register.getMetricsAsJSON();
}
