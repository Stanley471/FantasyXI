import { createHash } from "node:crypto";

export interface SlowQueryEvent {
  query: string;
  duration: number;
}

/** One aggregated record per normalized query fingerprint (#435). */
interface FingerprintStats {
  fingerprint: string;
  operation: string;
  sample: string; // parameter-sanitized sample query
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  /** Ring buffer of the last MAX_SAMPLES durations for percentile calc. */
  durations: number[];
}

interface SlowQueryTelemetryOptions {
  thresholdMs?: number;
  windowMs?: number;
  /** Max durations kept per fingerprint for percentile calculation (#435). */
  maxSamplesPerFingerprint?: number;
  /** Max distinct fingerprints tracked — bounds memory usage (#435). */
  maxFingerprints?: number;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

/** Strip literals and parameters to produce a comparable query fingerprint (#435). */
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

/** Approximate percentile over a sorted array (#435). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

export class SlowQueryTelemetry {
  private readonly rollingTimes: number[] = [];
  private readonly stats = new Map<string, FingerprintStats>();
  private readonly thresholdMs: number;
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly maxFingerprints: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;

  constructor(options: SlowQueryTelemetryOptions = {}) {
    this.thresholdMs = options.thresholdMs ?? 200;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxSamples = options.maxSamplesPerFingerprint ?? 1_000;
    this.maxFingerprints = options.maxFingerprints ?? 500;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  observe(event: SlowQueryEvent): void {
    if (!Number.isFinite(event.duration) || event.duration <= this.thresholdMs)
      return;

    const now = this.now();
    this.pruneRolling(now);
    this.rollingTimes.push(now);

    const normalized = normalizeQuery(event.query);
    const operation =
      normalized.match(/^[a-z]+/)?.[0]?.toUpperCase() ?? "OTHER";
    const fp = createHash("sha256")
      .update(normalized)
      .digest("hex")
      .slice(0, 16);

    // Bounded fingerprint map — evict the least-called entry when full (#435)
    if (!this.stats.has(fp) && this.stats.size >= this.maxFingerprints) {
      let minCount = Infinity;
      let evictKey = "";
      for (const [k, v] of this.stats) {
        if (v.count < minCount) {
          minCount = v.count;
          evictKey = k;
        }
      }
      if (evictKey) this.stats.delete(evictKey);
    }

    const entry = this.stats.get(fp) ?? {
      fingerprint: fp,
      operation,
      sample: normalized.slice(0, 200),
      count: 0,
      totalMs: 0,
      minMs: Infinity,
      maxMs: -Infinity,
      durations: [],
    };

    entry.count += 1;
    entry.totalMs += event.duration;
    if (event.duration < entry.minMs) entry.minMs = event.duration;
    if (event.duration > entry.maxMs) entry.maxMs = event.duration;

    // Ring buffer: drop oldest when full (#435)
    entry.durations.push(event.duration);
    if (entry.durations.length > this.maxSamples) entry.durations.shift();

    this.stats.set(fp, entry);

    this.logger.warn(
      JSON.stringify({
        type: "slow_database_query",
        operation,
        queryFingerprint: fp,
        durationMs: event.duration,
        slowQueriesLastMinute: this.rollingTimes.length,
      }),
    );
  }

  getRollingCount(): number {
    this.pruneRolling(this.now());
    return this.rollingTimes.length;
  }

  /**
   * Generate a structured daily digest highlighting top slow queries (#435).
   * Returns the top 5 by p99 latency and top 5 by call frequency.
   */
  generateDigest(): {
    topByLatency: DigestEntry[];
    topByFrequency: DigestEntry[];
    totalSlowQueries: number;
  } {
    const entries = Array.from(this.stats.values()).map(toDigestEntry);
    const byLatency = [...entries]
      .sort((a, b) => b.p99Ms - a.p99Ms)
      .slice(0, 5);
    const byFrequency = [...entries]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return {
      topByLatency: byLatency,
      topByFrequency: byFrequency,
      totalSlowQueries: entries.reduce((s, e) => s + e.count, 0),
    };
  }

  /** Reset all aggregated stats (useful for tests). */
  reset(): void {
    this.rollingTimes.length = 0;
    this.stats.clear();
  }

  private pruneRolling(now: number): void {
    while (
      this.rollingTimes.length > 0 &&
      now - this.rollingTimes[0]! >= this.windowMs
    ) {
      this.rollingTimes.shift();
    }
  }
}

export interface DigestEntry {
  fingerprint: string;
  operation: string;
  sample: string;
  count: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  p99Ms: number;
}

function toDigestEntry(s: FingerprintStats): DigestEntry {
  const sorted = [...s.durations].sort((a, b) => a - b);
  return {
    fingerprint: s.fingerprint,
    operation: s.operation,
    sample: s.sample,
    count: s.count,
    meanMs: s.count > 0 ? Math.round(s.totalMs / s.count) : 0,
    minMs: s.minMs === Infinity ? 0 : s.minMs,
    maxMs: s.maxMs === -Infinity ? 0 : s.maxMs,
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  };
}

export const slowQueryTelemetry = new SlowQueryTelemetry();
