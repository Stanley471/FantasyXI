import { createHash } from "node:crypto";
import { logger as defaultLogger } from "../../config/logger.js";

const MAX_EVENTS = 50;
const MAX_STRING = 1_000;
const SENSITIVE_KEY = /authorization|cookie|password|token|secret|email|phone|address|name/i;
const SENSITIVE_VALUE = /(bearer\s+[\w.-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d[ -]*?){13,19}\b)/gi;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return value.slice(0, MAX_STRING).replace(SENSITIVE_VALUE, "[REDACTED]");
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(entry, depth + 1)])
    );
  }
  return undefined;
}

export interface AcceptedClientTelemetry {
  type: string;
  name: string;
  timestamp: number;
  count: number;
  fingerprint: string;
  value?: number;
  rating?: string;
  metadata?: Record<string, unknown>;
}

export class ClientTelemetryService {
  constructor(private readonly logger: Pick<typeof defaultLogger, "info"> = defaultLogger) {}

  public ingest(body: unknown, context: { ip: string; userAgent?: string | null }): AcceptedClientTelemetry[] {
    const rawEvents =
      typeof body === "object" && body && Array.isArray((body as { events?: unknown }).events)
        ? (body as { events: unknown[] }).events.slice(0, MAX_EVENTS)
        : [];
    const accepted: AcceptedClientTelemetry[] = [];
    for (const raw of rawEvents) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Record<string, unknown>;
      if (typeof event.type !== "string" || typeof event.name !== "string") continue;
      const name = event.name.slice(0, 120);
      const metadata = redact(event.metadata) as Record<string, unknown> | undefined;
      const fingerprint = createHash("sha256")
        .update(`${event.type}:${name}:${String(metadata?.stack ?? metadata?.url ?? "")}`)
        .digest("hex")
        .slice(0, 24);
      accepted.push({
        type: event.type.slice(0, 40),
        name,
        timestamp: Number.isFinite(event.timestamp) ? Number(event.timestamp) : Date.now(),
        count: Math.max(1, Math.min(1_000, Number(event.count) || 1)),
        fingerprint,
        ...(Number.isFinite(event.value) ? { value: Number(event.value) } : {}),
        ...(typeof event.rating === "string" ? { rating: event.rating.slice(0, 40) } : {}),
        ...(metadata ? { metadata } : {}),
      });
    }
    if (accepted.length > 0) {
      const clientHash = createHash("sha256").update(context.ip).digest("hex").slice(0, 16);
      this.logger.info(
        { component: "clientTelemetry", clientHash, events: accepted },
        "Client telemetry batch"
      );
    }
    return accepted;
  }
}

export const clientTelemetryService = new ClientTelemetryService();
