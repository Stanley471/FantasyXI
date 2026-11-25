/**
 * Secret-exposure quarantine tripwire and redaction audit trail (issue #456).
 *
 * When a secret reaches a trust boundary unredacted — a log record, an API
 * response, or an error trace — the scanner flags it, the log/response path
 * redacts it, and this module decides what else must happen:
 *
 *   1. The redaction is written to the audit trail (pattern type, location,
 *      timestamp, action). Audit entries never contain raw secret material:
 *      only a SHA-256 fingerprint of the matched value.
 *   2. If the match is a *verified* secret (see secretScanner.ts) and the
 *      process runs in production, the rotation hook fires: for a JWT that
 *      names a signing key, the existing JWT key rotation service revokes
 *      that key and installs a replacement. Other secret types have no
 *      in-code rotation provider, so the hook reports that and the entry
 *      records that manual revocation is required.
 *   3. Outside production the same path runs as a dry run: the event is
 *      recorded and the hook is NOT invoked, so tests and staging can prove
 *      the trigger works without ever revoking a live secret.
 *
 * Rotation is deduplicated per fingerprint (one rotation per secret per
 * cooldown window) so a secret repeated across many log lines cannot cause
 * a rotation storm. The tripwire never throws and never blocks the caller:
 * `handleUnredactedSecret` is fire-and-forget from the logger hook, and
 * `quarantineValue` is the awaitable form used by tests and explicit scans.
 *
 * No live production secret is ever revoked by this codebase on its own:
 * the only automated revocation is the JWT signing-key revocation through
 * the existing rotation service, and only for a verified JWT match in
 * production. Everything else is recorded for an operator to revoke.
 */

import crypto from "crypto";
import type { SecretDetection, SecretPatternType } from "./secretScanner.js";
import { sanitizeValue } from "./secretScanner.js";

export type QuarantineAction =
  | "REDACTED"
  | "QUARANTINED"
  | "QUARANTINE_DRY_RUN"
  | "ROTATION_FAILED";

export interface RedactionAuditEntry {
  id: string;
  /** ISO-8601 timestamp of the redaction / quarantine event. */
  timestamp: string;
  patternType: SecretPatternType;
  /** Where the secret was found, e.g. `$.err.stack` or `log:info[0].msg`. */
  location: string;
  action: QuarantineAction;
  /** SHA-256 fingerprint of the matched value. Never the value itself. */
  fingerprint: string;
  verified: boolean;
  environment: string;
  /** Sanitized detail, e.g. the rotation outcome. Never secret material. */
  detail?: string;
}

export interface RedactionAuditQuery {
  type?: SecretPatternType;
  action?: QuarantineAction;
  limit?: number;
}

/**
 * Bounded in-memory audit trail, modeled on SecurityAnomalyLog: `record()`
 * never throws and never awaits I/O, so auditing a redaction adds no
 * latency to the request or log call that produced it.
 */
export class SecretRedactionAuditLog {
  private readonly maxEntries: number;
  private entries: RedactionAuditEntry[] = [];

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
  }

  /** Records an entry. Never throws. */
  public record(input: Omit<RedactionAuditEntry, "id" | "timestamp">): RedactionAuditEntry {
    const entry: RedactionAuditEntry = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    try {
      this.entries.push(entry);
      const overflow = this.entries.length - this.maxEntries;
      if (overflow > 0) this.entries.splice(0, overflow);
    } catch (error) {
      console.error("[secret-quarantine] Failed to record audit entry:", error);
    }
    return entry;
  }

  /** Reads recorded entries, newest first. */
  public query(filters: RedactionAuditQuery = {}): RedactionAuditEntry[] {
    let results = this.entries;
    if (filters.type) results = results.filter((e) => e.patternType === filters.type);
    if (filters.action) results = results.filter((e) => e.action === filters.action);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), this.maxEntries);
    return [...results].reverse().slice(0, limit);
  }

  /** Test/ops helper. */
  public clear(): void {
    this.entries = [];
  }
}

export const secretRedactionAuditLog = new SecretRedactionAuditLog();

/* ------------------------------------------------------------------ */
/* Rotation hook                                                       */
/* ------------------------------------------------------------------ */

export interface RotationOutcome {
  rotated: boolean;
  detail: string;
}

export interface SecretRotationHook {
  rotate(detection: SecretDetection, context: QuarantineContext): Promise<RotationOutcome>;
}

export interface QuarantineContext {
  location: string;
  /**
   * Raw secret material, when the caller already holds it (e.g. the logger
   * hook extracted a JWT from the very log line being written). Held in
   * memory only, passed to the rotation hook so a JWT's `kid` can be
   * resolved, and never logged, stored, or written to an audit entry.
   */
  rawSecret?: string;
}

/**
 * Default rotation hook. A verified JWT match triggers revocation of the
 * signing key it names through the existing JWT key rotation service
 * (jwtKeyRotationService.revoke), which also installs a replacement key.
 * The key is identified from the raw token's `kid` header, so rotation
 * needs the token itself (passed via `context.rawSecret`); a fingerprint
 * alone cannot identify a key. Every other secret type has no automated
 * rotation provider in this codebase: the outcome says so explicitly and
 * the audit entry records that manual revocation is required.
 *
 * The rotation service is imported lazily so this module stays free of the
 * Prisma/Redis import chain for the log path and for tests, which inject a
 * fake revoker instead.
 */
export class JwtKeyRotationHook implements SecretRotationHook {
  private readonly revokeKey: (
    kid: string,
    reason: string
  ) => Promise<{ kid: string; replacementKid: string | null } | null>;

  constructor(
    revokeKey?: (kid: string, reason: string) => Promise<{ kid: string; replacementKid: string | null } | null>
  ) {
    this.revokeKey =
      revokeKey ??
      (async (kid, reason) => {
        const { jwtKeyRotationService } = await import("../auth/jwtKeyRotationService.js");
        return jwtKeyRotationService.revoke(kid, reason);
      });
  }

  /**
   * Rotates based on a detection. For a JWT, the raw token must be supplied
   * via `context.rawSecret` so its `kid` can be resolved (see
   * `rotateFromToken`); without it the hook reports that the key cannot be
   * identified from a fingerprint.
   */
  public async rotate(detection: SecretDetection, context: QuarantineContext): Promise<RotationOutcome> {
    if (detection.type !== "jwt") {
      return {
        rotated: false,
        detail: `no automated rotation provider for ${detection.type}; manual revocation required`,
      };
    }
    if (!context.rawSecret) {
      return {
        rotated: false,
        detail: "jwt kid is not recoverable from a fingerprint; rotate via rotateFromToken with the raw token",
      };
    }
    return this.rotateFromToken(context.rawSecret, `exposed in ${context.location}`);
  }

  /**
   * Revokes the signing key named by a raw JWT's `kid` header through the
   * existing rotation service. Callers must only pass a token that was
   * already verified as a genuine JWT match, and must never log the token.
   */
  public async rotateFromToken(token: string, reason: string): Promise<RotationOutcome> {
    let kid: string | undefined;
    try {
      const headerSegment = token.split(".")[0];
      const header = JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as {
        kid?: unknown;
      };
      if (typeof header.kid === "string" && header.kid.length > 0) kid = header.kid;
    } catch {
      kid = undefined;
    }
    if (!kid) {
      return { rotated: false, detail: "jwt carries no kid; cannot identify the signing key to revoke" };
    }
    const result = await this.revokeKey(kid, reason);
    if (!result) {
      return { rotated: false, detail: `signing key ${kid} not found; nothing revoked` };
    }
    return {
      rotated: true,
      detail: `revoked signing key ${kid}; replacement ${result.replacementKid ?? "none"}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tripwire                                                            */
/* ------------------------------------------------------------------ */

export interface QuarantineResult {
  quarantined: boolean;
  /** True when the event was recorded but rotation was skipped (not production). */
  dryRun: boolean;
  rotationAttempted: boolean;
  rotated: boolean;
  detail: string;
}

export interface SecretQuarantineTripwireOptions {
  auditLog?: SecretRedactionAuditLog;
  rotationHook?: SecretRotationHook;
  /** Cooldown per secret fingerprint before rotation may fire again. */
  cooldownMs?: number;
  now?: () => number;
  isProduction?: () => boolean;
}

const DEFAULT_COOLDOWN_MS = 60_000;

export class SecretQuarantineTripwire {
  private readonly auditLog: SecretRedactionAuditLog;
  private readonly rotationHook: SecretRotationHook;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly isProduction: () => boolean;
  /** fingerprint -> epoch ms of the last rotation attempt. */
  private readonly lastRotationByFingerprint = new Map<string, number>();

  constructor(options: SecretQuarantineTripwireOptions = {}) {
    this.auditLog = options.auditLog ?? secretRedactionAuditLog;
    this.rotationHook = options.rotationHook ?? new JwtKeyRotationHook();
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.isProduction = options.isProduction ?? (() => process.env.NODE_ENV === "production");
  }

  /** Records REDACTED audit entries for detections that were redacted. */
  public recordRedactions(detections: SecretDetection[], location: string): void {
    for (const detection of detections) {
      this.auditLog.record({
        patternType: detection.type,
        location: detection.location || location,
        action: "REDACTED",
        fingerprint: detection.fingerprint,
        verified: detection.verified,
        environment: process.env.NODE_ENV ?? "unknown",
      });
    }
  }

  /**
   * Handles one secret that reached a trust boundary before redaction.
   * Never throws. Unverified matches are recorded as redactions only.
   * Verified matches in production invoke the rotation hook (once per
   * fingerprint per cooldown window); elsewhere they are dry-run entries.
   */
  public async handleUnredactedSecret(
    detection: SecretDetection,
    context: QuarantineContext
  ): Promise<QuarantineResult> {
    const environment = process.env.NODE_ENV ?? "unknown";
    try {
      if (!detection.verified) {
        this.auditLog.record({
          patternType: detection.type,
          location: context.location,
          action: "REDACTED",
          fingerprint: detection.fingerprint,
          verified: false,
          environment,
          detail: "unverified match: redacted only, rotation not triggered",
        });
        return {
          quarantined: false,
          dryRun: false,
          rotationAttempted: false,
          rotated: false,
          detail: "unverified match: redacted only",
        };
      }

      if (!this.isProduction()) {
        this.auditLog.record({
          patternType: detection.type,
          location: context.location,
          action: "QUARANTINE_DRY_RUN",
          fingerprint: detection.fingerprint,
          verified: true,
          environment,
          detail: "verified secret in non-production: rotation hook not invoked",
        });
        this.emitQuarantineEvent(detection, context, "QUARANTINE_DRY_RUN");
        return {
          quarantined: false,
          dryRun: true,
          rotationAttempted: false,
          rotated: false,
          detail: "verified secret outside production: dry run only",
        };
      }

      const nowMs = this.now();
      const lastAttempt = this.lastRotationByFingerprint.get(detection.fingerprint);
      if (lastAttempt !== undefined && nowMs - lastAttempt < this.cooldownMs) {
        return {
          quarantined: true,
          dryRun: false,
          rotationAttempted: false,
          rotated: false,
          detail: "rotation already attempted for this secret inside the cooldown window",
        };
      }
      this.lastRotationByFingerprint.set(detection.fingerprint, nowMs);

      let outcome: RotationOutcome;
      try {
        outcome = await this.rotationHook.rotate(detection, context);
      } catch (error) {
        outcome = {
          rotated: false,
          detail: `rotation hook failed: ${error instanceof Error ? error.message : "unknown error"}`,
        };
      }

      const action: QuarantineAction = outcome.rotated ? "QUARANTINED" : "ROTATION_FAILED";
      this.auditLog.record({
        patternType: detection.type,
        location: context.location,
        action,
        fingerprint: detection.fingerprint,
        verified: true,
        environment,
        detail: outcome.detail,
      });
      this.emitQuarantineEvent(detection, context, action, outcome.detail);
      return {
        quarantined: true,
        dryRun: false,
        rotationAttempted: true,
        rotated: outcome.rotated,
        detail: outcome.detail,
      };
    } catch (error) {
      console.error("[secret-quarantine] Tripwire failed:", error);
      return {
        quarantined: false,
        dryRun: false,
        rotationAttempted: false,
        rotated: false,
        detail: "tripwire failed; secret was still redacted at the sink",
      };
    }
  }

  /**
   * Scans `value`, returns the redacted copy plus detections, records the
   * redactions, and runs the tripwire for every verified detection.
   * Awaitable form; the logger hook uses the same steps fire-and-forget.
   */
  public async quarantineValue<T>(
    value: T,
    context: QuarantineContext
  ): Promise<{ value: T; detections: SecretDetection[]; results: QuarantineResult[] }> {
    const { value: redacted, detections } = sanitizeValue(value, context.location);
    this.recordRedactions(detections, context.location);
    const results: QuarantineResult[] = [];
    for (const detection of detections) {
      if (detection.verified) {
        results.push(await this.handleUnredactedSecret(detection, context));
      }
    }
    return { value: redacted as T, detections, results };
  }

  /** Structured quarantine event on stderr-free console.warn (no logger recursion). */
  private emitQuarantineEvent(
    detection: SecretDetection,
    context: QuarantineContext,
    action: QuarantineAction,
    detail?: string
  ): void {
    console.warn(
      JSON.stringify({
        event: "secret_exposure_quarantine",
        action,
        patternType: detection.type,
        fingerprint: detection.fingerprint,
        location: context.location,
        verified: detection.verified,
        environment: process.env.NODE_ENV ?? "unknown",
        ...(detail ? { detail } : {}),
      })
    );
  }
}

export const secretQuarantineTripwire = new SecretQuarantineTripwire();
