import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseTraceparent,
  formatTraceparent,
  generateTraceId,
  generateSpanId,
  sanitizeSpanAttributes,
  traceStorage,
  traceCollector,
  traceDbQuery,
  tracingMiddleware,
} from "../config/tracing.js";
import {
  createTraceparentHeader,
  fetchWithTracing,
} from "../services/tracing/frontend_tracing.js";

describe("OpenTelemetry Distributed Tracing & W3C Trace Context (Issue 159)", () => {
  it("should correctly parse and format standard W3C traceparent headers", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const header = `00-${traceId}-${spanId}-01`;

    const parsed = parseTraceparent(header);
    assert.ok(parsed !== null);
    assert.strictEqual(parsed.traceId, traceId);
    assert.strictEqual(parsed.spanId, spanId);
    assert.strictEqual(parsed.sampled, true);

    const formatted = formatTraceparent(parsed);
    assert.strictEqual(formatted, header);
  });

  it("should gracefully reject malformed traceparent headers", () => {
    assert.strictEqual(parseTraceparent("invalid-header"), null);
    assert.strictEqual(parseTraceparent("01-abc-123-01"), null); // Invalid version
    assert.strictEqual(parseTraceparent("00-shorttrace-shortspan-01"), null);
    assert.strictEqual(parseTraceparent(""), null);
  });

  it("should sanitize PII, passwords, and authorization tokens from span attributes", () => {
    const rawAttributes = {
      "http.url": "/api/auth/login",
      authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      password: "SuperSecretPassword123!",
      refreshToken: "token-secret-xyz",
      userId: "user_456",
    };

    const sanitized = sanitizeSpanAttributes(rawAttributes);

    assert.strictEqual(sanitized["http.url"], "/api/auth/login");
    assert.strictEqual(sanitized["userId"], "user_456");
    assert.strictEqual(sanitized["authorization"], "[REDACTED]");
    assert.strictEqual(sanitized["password"], "[REDACTED]");
    assert.strictEqual(sanitized["refreshToken"], "[REDACTED]");
  });

  it("should propagate single trace ID from incoming request to downstream DB queries", async () => {
    traceCollector.clear();

    const clientTraceId = generateTraceId();
    const clientSpanId = generateSpanId();
    const incomingTraceparent = `00-${clientTraceId}-${clientSpanId}-01`;

    const mockReq: any = {
      method: "GET",
      path: "/api/leagues/123",
      headers: { traceparent: incomingTraceparent },
    };

    let setHeaders: Record<string, string> = {};
    let finishHandler: (() => void) | undefined;

    const mockRes: any = {
      setHeader: (k: string, v: string) => {
        setHeaders[k] = v;
      },
      on: (event: string, handler: () => void) => {
        if (event === "finish") finishHandler = handler;
      },
      statusCode: 200,
    };

    // Run request through tracingMiddleware
    let middlewareCompleted = false;
    tracingMiddleware(mockReq, mockRes, async () => {
      middlewareCompleted = true;

      // Inside request handler, execute a simulated DB query
      await traceDbQuery("League", "findUnique", async () => {
        return { id: "123", name: "Premier League Elite" };
      });

      if (finishHandler) finishHandler();
    });

    assert.strictEqual(middlewareCompleted, true);
    assert.strictEqual(setHeaders["X-Trace-Id"], clientTraceId);

    const spans = traceCollector.getSpansByTraceId(clientTraceId);
    assert.strictEqual(spans.length, 2);

    const httpSpan = spans.find((s) => s.name.startsWith("HTTP"));
    const dbSpan = spans.find((s) => s.name.startsWith("DB"));

    assert.ok(httpSpan, "Should record HTTP span");
    assert.ok(dbSpan, "Should record DB span");

    assert.strictEqual(httpSpan?.traceId, clientTraceId);
    assert.strictEqual(dbSpan?.traceId, clientTraceId);
    assert.strictEqual(dbSpan?.parentSpanId, httpSpan?.spanId);
  });

  it("should attach valid W3C traceparent headers to outgoing frontend fetch requests", async () => {
    let interceptedHeaders: Headers | undefined;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input: any, init?: any) => {
      interceptedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    try {
      const explicitTraceId = generateTraceId();
      await fetchWithTracing("https://api.fantasyxi.app/api/players", {}, explicitTraceId);

      assert.ok(interceptedHeaders !== undefined);
      const traceparent = interceptedHeaders?.get("traceparent");
      assert.ok(traceparent !== null);
      assert.ok(traceparent?.startsWith(`00-${explicitTraceId}-`));

      const parsed = parseTraceparent(traceparent);
      assert.strictEqual(parsed?.traceId, explicitTraceId);
      assert.strictEqual(parsed?.sampled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
