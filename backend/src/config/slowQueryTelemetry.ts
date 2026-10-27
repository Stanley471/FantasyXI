import { createHash } from "node:crypto";

export interface SlowQueryEvent {
  query: string;
  duration: number;
}

interface SlowQueryTelemetryOptions {
  thresholdMs?: number;
  windowMs?: number;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

function normalizeQuery(query: string): string {
  return query
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|\\.|[^'])*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export class SlowQueryTelemetry {
  private readonly slowQueryTimes: number[] = [];
  private readonly thresholdMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;

  constructor(options: SlowQueryTelemetryOptions = {}) {
    this.thresholdMs = options.thresholdMs ?? 200;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  observe(event: SlowQueryEvent): void {
    if (!Number.isFinite(event.duration) || event.duration <= this.thresholdMs) return;

    const now = this.now();
    this.prune(now);
    this.slowQueryTimes.push(now);

    const normalizedQuery = normalizeQuery(event.query);
    const operation = normalizedQuery.match(/^[a-z]+/)?.[0]?.toUpperCase() ?? "OTHER";
    const queryFingerprint = createHash("sha256")
      .update(normalizedQuery)
      .digest("hex")
      .slice(0, 16);

    this.logger.warn(
      JSON.stringify({
        type: "slow_database_query",
        operation,
        queryFingerprint,
        durationMs: event.duration,
        slowQueriesLastMinute: this.slowQueryTimes.length,
      }),
    );
  }

  getRollingCount(): number {
    this.prune(this.now());
    return this.slowQueryTimes.length;
  }

  private prune(now: number): void {
    while (
      this.slowQueryTimes.length > 0 &&
      now - this.slowQueryTimes[0] >= this.windowMs
    ) {
      this.slowQueryTimes.shift();
    }
  }
}

export const slowQueryTelemetry = new SlowQueryTelemetry();
