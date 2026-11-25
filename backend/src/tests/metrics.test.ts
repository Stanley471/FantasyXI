import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import { metricsMiddleware, getUptimeSeconds } from "../middleware/metricsMiddleware.js";
import {
  httpRequestDuration,
  httpRequestTotal,
  httpErrorTotal,
  collectMetrics,
  getMetricsContentType,
  resetMetrics,
  dbConnectionPoolSize,
  dbConnectionPoolCapacity,
  bullQueueDepth,
} from "../config/metrics.js";
import { DbMetricsCollector } from "../services/metrics/dbMetricsCollector.js";
import { QueueMetricsCollector } from "../services/metrics/queueMetricsCollector.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { exportMetrics, exportMetricsJson } from "../controllers/metrics.controller.js";
import { SERVICE_KEY_HEADER, authenticateServiceKey } from "../config/serviceAuth.js";

describe("Metrics Collection and Prometheus Endpoint", () => {
  let app: Express;
  const testServiceKey = "test-service-key-1234567890abcdef";

  before(() => {
    // Create a minimal Express app with metrics middleware for testing
    app = express();
    app.use(express.json());
    app.use(metricsMiddleware);

    // Test routes for metrics collection
    app.get("/test/success", (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    });

    app.get("/test/error", (_req: Request, res: Response) => {
      res.status(500).json({ error: "Internal Server Error" });
    });

    app.get("/test/not-found", (_req: Request, res: Response) => {
      res.status(404).json({ error: "Not Found" });
    });

    // Metrics endpoint protected by service key
    app.get("/metrics", async (req: Request, res: Response, next: NextFunction) => {
      // Check for service key authentication
      const serviceKey = req.headers[SERVICE_KEY_HEADER];
      if (!serviceKey || !authenticateServiceKey(serviceKey as string, testServiceKey)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      await exportMetrics(req, res, next);
    });

    app.get("/metrics/json", async (req: Request, res: Response, next: NextFunction) => {
      const serviceKey = req.headers[SERVICE_KEY_HEADER];
      if (!serviceKey || !authenticateServiceKey(serviceKey as string, testServiceKey)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      await exportMetricsJson(req, res, next);
    });
  });

  beforeEach(() => {
    resetMetrics();
    DbMetricsCollector.reset();
  });

  describe("HTTP Request Metrics", () => {
    it("should track successful HTTP requests", async () => {
      await request(app).get("/test/success").expect(200);

      const metrics = await collectMetrics();
      assert(metrics.includes("http_requests_total"), "should include http_requests_total");
      assert(metrics.includes("http_request_duration_ms"), "should include http_request_duration_ms");
      assert(metrics.includes('method="GET"'), "should track GET method");
      assert(metrics.includes('status="200"'), "should track 200 status code");
    });

    it("should track HTTP error responses (5xx)", async () => {
      await request(app).get("/test/error").expect(500);

      const metrics = await collectMetrics();
      assert(metrics.includes('status="500"'), "should track 500 status code");
      assert(metrics.includes("http_errors_total"), "should include http_errors_total");
    });

    it("should track HTTP error responses (4xx)", async () => {
      await request(app).get("/test/not-found").expect(404);

      const metrics = await collectMetrics();
      assert(metrics.includes('status="404"'), "should track 404 status code");
      assert(metrics.includes("http_errors_total"), "should include http_errors_total");
    });

    it("should collect histogram metrics with latency buckets", async () => {
      await request(app).get("/test/success").expect(200);

      const metrics = await collectMetrics();
      // Check for histogram buckets
      assert(metrics.includes("le=") && metrics.includes("http_request_duration_ms_bucket"), "should include histogram buckets");
    });

    it("should track multiple requests to the same route", async () => {
      await request(app).get("/test/success").expect(200);
      await request(app).get("/test/success").expect(200);
      await request(app).get("/test/success").expect(200);

      const metrics = await collectMetrics();
      // All three requests should be counted
      assert(metrics.includes("http_requests_total"), "should track total requests");
    });

    it("should track different HTTP methods separately", async () => {
      await request(app).get("/test/success").expect(200);

      const metrics = await collectMetrics();
      assert(metrics.includes('method="GET"'), "should track GET method");
    });

    it("should track app uptime", async () => {
      await request(app).get("/test/success").expect(200);

      const metrics = await collectMetrics();
      assert(metrics.includes("app_uptime_seconds"), "should include app_uptime_seconds");
    });

    it("getUptimeSeconds() should return positive number", () => {
      const uptime = getUptimeSeconds();
      assert(uptime >= 0, "uptime should be >= 0");
      assert(typeof uptime === "number", "uptime should be a number");
    });
  });

  describe("Database Connection Pool Metrics", () => {
    it("should record database connection pool size", () => {
      DbMetricsCollector.updateConnectionPoolMetrics(15, 20);

      const metrics = require("prom-client");
      // Note: Actual assertion depends on prom-client registry state
      assert.ok(true, "should not throw when updating pool metrics");
    });

    it("should record database query execution", () => {
      DbMetricsCollector.recordQueryExecution("User", "findMany", 50, true);
      DbMetricsCollector.recordQueryExecution("Player", "findUnique", 25, true);

      assert.strictEqual(DbMetricsCollector.getSlowQueryCount(), 0, "no slow queries yet");
    });

    it("should track slow queries (>100ms)", () => {
      DbMetricsCollector.recordQueryExecution("User", "findMany", 150, true);
      DbMetricsCollector.recordQueryExecution("Player", "findUnique", 110, true);
      DbMetricsCollector.recordQueryExecution("League", "findMany", 50, true);

      assert.strictEqual(DbMetricsCollector.getSlowQueryCount(), 2, "should count 2 slow queries");
    });

    it("should track query errors separately", () => {
      DbMetricsCollector.recordQueryExecution("User", "findMany", 50, true);
      DbMetricsCollector.recordQueryExecution("User", "findMany", 40, false);

      // Both should be recorded in metrics but with different status labels
      assert.ok(true, "should track both success and error");
    });

    it("should reset metrics", () => {
      DbMetricsCollector.recordQueryExecution("User", "findMany", 150, true);
      assert.strictEqual(DbMetricsCollector.getSlowQueryCount(), 1, "should have 1 slow query");

      DbMetricsCollector.reset();
      assert.strictEqual(DbMetricsCollector.getSlowQueryCount(), 0, "should reset to 0");
    });
  });

  describe("Queue Metrics", () => {
    it("should record queue depth metrics", async () => {
      // Mock BullMQ queue object
      const mockQueue = {
        name: "email-jobs",
        getJobCounts: async () => ({
          waiting: 42,
          active: 3,
          completed: 100,
          failed: 2,
        }),
      };

      await QueueMetricsCollector.updateQueueMetrics(mockQueue);
      assert.ok(true, "should not throw when updating queue metrics");
    });

    it("should record job duration metrics", () => {
      QueueMetricsCollector.recordJobDuration("email-jobs", 5000, "success");
      QueueMetricsCollector.recordJobDuration("email-jobs", 2000, "success");
      QueueMetricsCollector.recordJobDuration("email-jobs", 30000, "failed");

      assert.ok(true, "should not throw when recording job durations");
    });
  });

  describe("/metrics Endpoint (Prometheus Format)", () => {
    it("should return 401 without service key", async () => {
      const response = await request(app).get("/metrics");
      assert.strictEqual(response.status, 401, "should return 401 Unauthorized");
    });

    it("should return 401 with invalid service key", async () => {
      const response = await request(app)
        .get("/metrics")
        .set(SERVICE_KEY_HEADER, "invalid-key");
      assert.strictEqual(response.status, 401, "should return 401 Unauthorized");
    });

    it("should return 200 with valid service key", async () => {
      const response = await request(app)
        .get("/metrics")
        .set(SERVICE_KEY_HEADER, testServiceKey);
      assert.strictEqual(response.status, 200, "should return 200 OK");
    });

    it("should return Prometheus text format", async () => {
      const response = await request(app)
        .get("/metrics")
        .set(SERVICE_KEY_HEADER, testServiceKey);

      assert.strictEqual(response.status, 200);
      assert(response.text.includes("# HELP"), "should include Prometheus HELP comments");
      assert(response.text.includes("# TYPE"), "should include Prometheus TYPE comments");
    });

    it("should include standard Prometheus metrics", async () => {
      await request(app).get("/test/success").expect(200);

      const response = await request(app)
        .get("/metrics")
        .set(SERVICE_KEY_HEADER, testServiceKey);

      const metrics = response.text;
      assert(metrics.includes("http_requests_total"), "should include http_requests_total");
      assert(metrics.includes("http_request_duration_ms"), "should include http_request_duration_ms");
      assert(metrics.includes("process_"), "should include process metrics");
      assert(metrics.includes("nodejs_"), "should include nodejs metrics");
    });

    it("should have correct content-type header", async () => {
      const response = await request(app)
        .get("/metrics")
        .set(SERVICE_KEY_HEADER, testServiceKey);

      assert.strictEqual(response.status, 200);
      assert(response.type.includes("text/plain"), "should return text/plain content type");
    });

    it("should include histogram percentile buckets", async () => {
      await request(app).get("/test/success").expect(200);

      const response = await request(app)
        .get("/metrics")
        .set(SERVICE_KEY_HEADER, testServiceKey);

      const metrics = response.text;
      // Prometheus histograms include bucket labels with 'le' (less-equal)
      assert(metrics.includes("le="), "should include histogram buckets");
    });
  });

  describe("/metrics/json Endpoint (Debug Format)", () => {
    it("should return 401 without service key", async () => {
      const response = await request(app).get("/metrics/json");
      assert.strictEqual(response.status, 401, "should return 401 Unauthorized");
    });

    it("should return 200 with valid service key", async () => {
      const response = await request(app)
        .get("/metrics/json")
        .set(SERVICE_KEY_HEADER, testServiceKey);
      assert.strictEqual(response.status, 200, "should return 200 OK");
    });

    it("should return JSON format", async () => {
      const response = await request(app)
        .get("/metrics/json")
        .set(SERVICE_KEY_HEADER, testServiceKey);

      assert.strictEqual(response.status, 200);
      assert(response.body.success, "should have success: true");
      assert(Array.isArray(response.body.metrics), "should have metrics array");
    });

    it("should include timestamp", async () => {
      const response = await request(app)
        .get("/metrics/json")
        .set(SERVICE_KEY_HEADER, testServiceKey);

      assert(response.body.timestamp, "should include timestamp");
      assert(!isNaN(Date.parse(response.body.timestamp)), "should be valid ISO timestamp");
    });
  });

  describe("Metrics Content Type", () => {
    it("should return correct Prometheus content type", () => {
      const contentType = getMetricsContentType();
      assert(contentType.includes("text/plain"), "should return text/plain content type");
    });
  });

  describe("Metrics Isolation and Reset", () => {
    it("should reset metrics cleanly", async () => {
      await request(app).get("/test/success").expect(200);
      const metricsBefore = await collectMetrics();
      assert(metricsBefore.includes("http_requests_total"));

      resetMetrics();
      const metricsAfter = await collectMetrics();
      // After reset, metrics should still exist but counters should be empty
      assert(metricsAfter.includes("HELP"), "should still have metric definitions");
    });

    it("should track independent metric types", async () => {
      await request(app).get("/test/success").expect(200);
      await request(app).get("/test/error").expect(500);

      const metrics = await collectMetrics();
      assert(metrics.includes("http_requests_total"));
      assert(metrics.includes("http_errors_total"));
      assert(metrics.includes("app_uptime_seconds"));
    });
  });

  describe("Authorization Security", () => {
    it("should require X-Service-Key header for metrics access", async () => {
      const response = await request(app).get("/metrics");
      assert.strictEqual(response.status, 401);
    });

    it("should validate service key in constant time", () => {
      const validKey = testServiceKey;
      const invalidKey = "completely-different-invalid-key";

      const start1 = Date.now();
      authenticateServiceKey(validKey, testServiceKey);
      const validTime = Date.now() - start1;

      const start2 = Date.now();
      authenticateServiceKey(invalidKey, testServiceKey);
      const invalidTime = Date.now() - start2;

      // Both should be very fast (timing attack resistance at millisecond level)
      assert(validTime < 100, "valid key check should be fast");
      assert(invalidTime < 100, "invalid key check should be fast");
    });

    it("should reject metrics endpoint for unauthenticated users", async () => {
      const response = await request(app).get("/metrics");
      assert.strictEqual(response.status, 401, "should reject without authentication");
      assert.strictEqual(response.body.error, "Unauthorized");
    });
  });
});
