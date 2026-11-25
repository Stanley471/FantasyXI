import { Request, Response, NextFunction } from "express";
import { collectMetrics, getMetricsContentType, getMetricsJson } from "../config/metrics.js";
import { DbMetricsCollector } from "../services/metrics/dbMetricsCollector.js";

/**
 * GET /metrics - Prometheus metrics export endpoint.
 * 
 * Protected by service key authentication (X-Service-Key header).
 * Returns metrics in Prometheus text format with standard histograms:
 * - http_request_duration_ms: HTTP latency with p50, p95, p99 buckets
 * - http_requests_total: Request count by method, route, status
 * - db_query_duration_ms: Database query latency
 * - bull_queue_depth: Job queue depth
 * - process metrics: Memory, GC, CPU
 *
 * Example:
 *   curl -H "X-Service-Key: <key>" http://localhost:5000/metrics
 */
export async function exportMetrics(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Update slow query metrics before export
    DbMetricsCollector.updateSlowQueryMetrics();

    // Collect and return all metrics in Prometheus text format
    const metrics = await collectMetrics();
    res.set("Content-Type", getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /metrics/json - Debug endpoint returning metrics as JSON.
 * 
 * Protected by service key authentication.
 * Useful for testing and debugging metric collection.
 */
export async function exportMetricsJson(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Update metrics before export
    DbMetricsCollector.updateSlowQueryMetrics();

    const metricsJson = await getMetricsJson();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      metrics: metricsJson,
    });
  } catch (error) {
    next(error);
  }
}
