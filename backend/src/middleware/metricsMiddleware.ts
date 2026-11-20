import { Request, Response, NextFunction } from "express";
import {
  httpRequestDuration,
  httpRequestTotal,
  httpErrorTotal,
  appUptime,
  appVersion,
} from "../config/metrics.js";

const APP_START_TIME = Date.now();

/**
 * Express middleware to collect HTTP request metrics.
 * Tracks request latency, status codes, and error rates by route and method.
 *
 * Metrics collected:
 * - http_request_duration_ms: Request latency percentiles (p50, p95, p99)
 * - http_requests_total: Total requests by method, route, status
 * - http_errors_total: Errors by status code
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const method = req.method;
  const route = req.route?.path || req.path || "unknown";

  // Capture the original res.end to intercept response finalization
  const originalEnd = res.end;
  res.end = function (chunk?: any, encoding?: any) {
    const statusCode = res.statusCode;
    const durationMs = Date.now() - startTime;

    // Record metrics
    httpRequestDuration.labels(method, route, statusCode).observe(durationMs);
    httpRequestTotal.labels(method, route, statusCode).inc();

    // Track errors (5xx and 4xx)
    if (statusCode >= 400) {
      httpErrorTotal.labels(method, route, statusCode).inc();
    }

    // Update uptime
    const uptimeSeconds = (Date.now() - APP_START_TIME) / 1000;
    appUptime.set(uptimeSeconds);

    // Update version info (only once)
    if (appVersion.resetMetrics === undefined) {
      const version = process.env.APP_VERSION || "0.2.0";
      const environment = process.env.NODE_ENV || "development";
      appVersion.labels(version, environment).set(1);
    }

    // Call the original res.end
    return originalEnd.call(this, chunk, encoding);
  };

  next();
}

/**
 * Get uptime in seconds since application start.
 */
export function getUptimeSeconds(): number {
  return (Date.now() - APP_START_TIME) / 1000;
}
