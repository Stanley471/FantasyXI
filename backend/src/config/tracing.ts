import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "async_hooks";

/**
 * OpenTelemetry W3C Distributed Tracing Infrastructure (Issue 159)
 * Specification: W3C Trace Context (traceparent header)
 * Format: 00-${traceId}-${spanId}-${traceFlags}
 */

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  durationMs?: number;
  attributes: Record<string, unknown>;
  status: "OK" | "ERROR";
  error?: string;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

const SENSITIVE_ATTRIBUTE_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "jwt",
  "key",
  "bearer",
]);

/**
 * Sanitizes attributes to ensure no sensitive PII or authentication tokens are logged.
 */
export function sanitizeSpanAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_ATTRIBUTE_KEYS.has(lowerKey) || lowerKey.includes("password") || lowerKey.includes("token")) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex"); // 32 hex characters
}

export function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex"); // 16 hex characters
}

/**
 * Parses W3C traceparent header: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
export function parseTraceparent(header?: string | null): TraceContext | null {
  if (!header) return null;
  const parts = header.trim().split("-");
  if (parts.length !== 4) return null;

  const [version, traceId, spanId, flags] = parts;
  if (version !== "00") return null;
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === "00000000000000000000000000000000") return null;
  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === "0000000000000000") return null;

  return {
    traceId,
    spanId,
    sampled: flags === "01",
  };
}

export function formatTraceparent(context: TraceContext): string {
  const flags = context.sampled ? "01" : "00";
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

export class InMemoryTraceCollector {
  private spans: Span[] = [];

  public emitSpan(span: Span): void {
    this.spans.push(span);
  }

  public getSpansByTraceId(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  public clear(): void {
    this.spans = [];
  }

  public getAllSpans(): Span[] {
    return [...this.spans];
  }
}

export const traceCollector = new InMemoryTraceCollector();

/**
 * Express middleware to propagate W3C traceparent and trace HTTP route performance.
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingHeader = req.headers["traceparent"] as string | undefined;
  const parsed = parseTraceparent(incomingHeader);

  const traceId = parsed?.traceId || generateTraceId();
  const serverSpanId = generateSpanId();
  const parentSpanId = parsed?.spanId;

  const context: TraceContext = {
    traceId,
    spanId: serverSpanId,
    sampled: parsed ? parsed.sampled : true,
  };

  res.setHeader("X-Trace-Id", traceId);
  res.setHeader("traceparent", formatTraceparent(context));

  const startTime = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const sanitizedHeaders = sanitizeSpanAttributes(req.headers as any);

    const span: Span = {
      name: `HTTP ${req.method} ${req.route?.path || req.path}`,
      traceId,
      spanId: serverSpanId,
      parentSpanId,
      startTime,
      durationMs,
      attributes: {
        "http.method": req.method,
        "http.route": req.route?.path || req.path,
        "http.status_code": res.statusCode,
        "http.headers": sanitizedHeaders,
      },
      status: res.statusCode >= 500 ? "ERROR" : "OK",
    };

    traceCollector.emitSpan(span);
  });

  traceStorage.run(context, () => next());
}

/**
 * Instrument DB operations linking to current active trace context.
 */
export async function traceDbQuery<T>(
  model: string,
  operation: string,
  queryFn: () => Promise<T>,
  metadata: Record<string, unknown> = {}
): Promise<T> {
  const parentContext = traceStorage.getStore();
  const traceId = parentContext?.traceId || generateTraceId();
  const spanId = generateSpanId();
  const parentSpanId = parentContext?.spanId;
  const startTime = Date.now();

  try {
    const result = await queryFn();
    const durationMs = Date.now() - startTime;

    traceCollector.emitSpan({
      name: `DB ${model}.${operation}`,
      traceId,
      spanId,
      parentSpanId,
      startTime,
      durationMs,
      attributes: sanitizeSpanAttributes({
        "db.system": "postgresql",
        "db.model": model,
        "db.operation": operation,
        ...metadata,
      }),
      status: "OK",
    });

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;

    traceCollector.emitSpan({
      name: `DB ${model}.${operation}`,
      traceId,
      spanId,
      parentSpanId,
      startTime,
      durationMs,
      attributes: sanitizeSpanAttributes({
        "db.system": "postgresql",
        "db.model": model,
        "db.operation": operation,
        ...metadata,
      }),
      status: "ERROR",
      error: error.message,
    });

    throw error;
  }
}
