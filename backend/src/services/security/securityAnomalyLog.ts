/**
 * Security Anomaly Log — in-memory record of suspicious auth activity, for
 * admin review (issue #117).
 *
 * Modeled after services/audit/financialAuditLog.ts: `record()` never throws
 * and never awaits I/O, so logging an anomaly adds no latency to the login
 * request that triggered it. Unlike the financial audit log, this is kept
 * in-memory only (a bounded ring buffer) rather than persisted to Postgres -
 * a real deployment would want a durable table (and likely a SIEM export),
 * but that needs a schema migration against a live database, which is out of
 * scope for this sandboxed environment. The in-memory buffer is still fully
 * functional for the admin-review requirement within a running process.
 */

export enum SecurityAnomalyType {
  FAILED_LOGIN_SPIKE = "FAILED_LOGIN_SPIKE",
  NEW_DEVICE_LOGIN = "NEW_DEVICE_LOGIN",
}

export interface SecurityAnomalyInput {
  type: SecurityAnomalyType;
  userId?: string | null;
  identifier: string;
  ip: string;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

export interface SecurityAnomalyEntry extends SecurityAnomalyInput {
  createdAt: Date;
}

export interface SecurityAnomalyQuery {
  type?: SecurityAnomalyType;
  userId?: string;
  limit?: number;
}

export class SecurityAnomalyLog {
  private readonly maxEntries: number;
  private entries: SecurityAnomalyEntry[] = [];

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
  }

  /** Records an anomaly. Never throws. */
  public record(input: SecurityAnomalyInput): SecurityAnomalyEntry {
    const entry: SecurityAnomalyEntry = { ...input, createdAt: new Date() };
    try {
      this.entries.push(entry);
      const overflow = this.entries.length - this.maxEntries;
      if (overflow > 0) {
        this.entries.splice(0, overflow);
      }
      console.warn(
        `[security] Anomaly detected: ${input.type} identifier=${input.identifier} ip=${input.ip}` +
          (input.userId ? ` userId=${input.userId}` : "")
      );
    } catch (error) {
      console.error("[security] Failed to record anomaly entry:", error);
    }
    return entry;
  }

  /** Reads recorded anomalies, newest first, for an admin dashboard/endpoint. */
  public query(filters: SecurityAnomalyQuery = {}): SecurityAnomalyEntry[] {
    let results = this.entries;
    if (filters.type) results = results.filter((e) => e.type === filters.type);
    if (filters.userId) results = results.filter((e) => e.userId === filters.userId);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), this.maxEntries);
    return [...results].reverse().slice(0, limit);
  }

  /** Test/ops helper. */
  public clear(): void {
    this.entries = [];
  }
}

export const securityAnomalyLog = new SecurityAnomalyLog();
