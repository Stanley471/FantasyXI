/**
 * Login Security Service (issue #117).
 *
 * Detects two classes of suspicious authentication activity, building on the
 * existing AuthService rather than replacing it:
 *  - Failed-login spikes: a sliding-window counter per identifier (the
 *    normalized email, since brute-forcing targets an account regardless of
 *    which IP the attempts come from).
 *  - New-device / new-IP logins: a per-user set of previously seen
 *    (ip, userAgent) pairs. A successful login from a pair never seen before
 *    triggers an email alert to the account owner and is logged for admin
 *    review.
 *
 * Automated account freezing is explicitly out of scope (see issue #117) -
 * this service only detects and alerts.
 *
 * Storage reuses the Redis instance added for #139 (same IRedisCacheClient
 * interface as fplClient.ts), with the identical in-memory fallback pattern
 * so behavior degrades gracefully instead of failing login when Redis is
 * unavailable. Redis TTLs mean known-device history eventually expires; a
 * production deployment would likely want a durable Postgres table for this
 * (so the history survives a Redis flush and admins can audit it
 * indefinitely), but that requires a schema migration against a live
 * database, out of scope for this sandboxed environment.
 */

import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import { mailer as defaultMailer, Mailer } from "./mailer.js";
import {
  securityAnomalyLog as defaultAnomalyLog,
  SecurityAnomalyLog,
  SecurityAnomalyType,
} from "./securityAnomalyLog.js";

export interface LoginSecurityOptions {
  redis?: IRedisCacheClient | null;
  mailer?: Mailer;
  anomalyLog?: SecurityAnomalyLog;
  /** Failed attempts within the window that count as a spike. Default 5. */
  failedLoginThreshold?: number;
  /** Sliding window for counting failed attempts, in ms. Default 10 minutes. */
  failedLoginWindowMs?: number;
  /** How long a known device/IP is remembered, in seconds. Default 90 days. */
  knownDeviceTtlSeconds?: number;
}

export interface FailedLoginResult {
  spikeDetected: boolean;
  recentFailureCount: number;
}

export interface NewDeviceLoginResult {
  isNewDevice: boolean;
  knownDeviceCount: number;
}

interface KnownDevice {
  ip: string;
  userAgent: string;
  firstSeenAt: string;
}

const FAILED_LOGIN_PREFIX = "security:failed-login:";
const KNOWN_DEVICE_PREFIX = "security:known-devices:";

export class LoginSecurityService {
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private redis: IRedisCacheClient | null;
  private mailerClient: Mailer;
  private anomalyLog: SecurityAnomalyLog;
  private failedLoginThreshold: number;
  private failedLoginWindowMs: number;
  private knownDeviceTtlSeconds: number;

  constructor(options: LoginSecurityOptions = {}) {
    this.redis = options.redis !== undefined ? options.redis : getRedisClient();
    this.mailerClient = options.mailer ?? defaultMailer;
    this.anomalyLog = options.anomalyLog ?? defaultAnomalyLog;
    this.failedLoginThreshold = options.failedLoginThreshold ?? 5;
    this.failedLoginWindowMs = options.failedLoginWindowMs ?? 10 * 60 * 1000;
    this.knownDeviceTtlSeconds = options.knownDeviceTtlSeconds ?? 90 * 24 * 60 * 60;
  }

  /** Allows injecting or replacing the Redis client (e.g. for testing). */
  public setRedisClient(client: IRedisCacheClient | null): void {
    this.redis = client;
  }

  private async readJson<T>(key: string): Promise<T | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw) return JSON.parse(raw) as T;
      } catch (err) {
        console.warn(
          `[security] Redis GET error for ${key}, falling back to memory:`,
          (err as Error).message
        );
      }
    }
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return JSON.parse(cached.value) as T;
    }
    return null;
  }

  private async writeJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (this.redis) {
      try {
        await this.redis.set(key, serialized, "EX", ttlSeconds);
      } catch (err) {
        console.warn(
          `[security] Redis SET error for ${key}, falling back to memory:`,
          (err as Error).message
        );
      }
    }
    // Always mirror into the in-memory fallback, so a mid-window Redis outage
    // does not lose recently-written state.
    this.cache.set(key, { value: serialized, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  private async deleteKey(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch (err) {
        console.warn(`[security] Redis DEL error for ${key}:`, (err as Error).message);
      }
    }
    this.cache.delete(key);
  }

  /**
   * Records a failed login attempt for `identifier` (the normalized email).
   * Returns whether this attempt tipped a sliding-window spike. A detected
   * spike is logged for admin review but never blocks the login flow itself -
   * automated account freezing is explicitly out of scope for this issue.
   */
  public async recordFailedLogin(identifier: string, ip: string): Promise<FailedLoginResult> {
    const key = `${FAILED_LOGIN_PREFIX}${identifier}`;
    const now = Date.now();
    const existing = (await this.readJson<number[]>(key)) ?? [];
    const withinWindow = existing.filter((ts) => now - ts < this.failedLoginWindowMs);
    withinWindow.push(now);

    const ttlSeconds = Math.max(1, Math.ceil(this.failedLoginWindowMs / 1000));
    await this.writeJson(key, withinWindow, ttlSeconds);

    const spikeDetected = withinWindow.length >= this.failedLoginThreshold;
    if (spikeDetected) {
      this.anomalyLog.record({
        type: SecurityAnomalyType.FAILED_LOGIN_SPIKE,
        identifier,
        ip,
        detail: { recentFailureCount: withinWindow.length, windowMs: this.failedLoginWindowMs },
      });
    }

    return { spikeDetected, recentFailureCount: withinWindow.length };
  }

  /** Clears the failed-login counter for `identifier`; called after a successful login. */
  public async resetFailedLogins(identifier: string): Promise<void> {
    await this.deleteKey(`${FAILED_LOGIN_PREFIX}${identifier}`);
  }

  /**
   * Evaluates whether `ip`/`userAgent` is a device/location already known for
   * `userId`, and records it as known afterward regardless of the outcome (so
   * a genuine new device is only flagged once). The very first login ever
   * recorded for a user is treated as known, not new - there is nothing yet
   * to compare it against, matching the sign-up/first-login flow where every
   * device is trivially "the first one seen".
   */
  public async evaluateDeviceNovelty(
    userId: string,
    ip: string,
    userAgent: string | null | undefined
  ): Promise<NewDeviceLoginResult> {
    const key = `${KNOWN_DEVICE_PREFIX}${userId}`;
    const normalizedUserAgent = userAgent?.trim() || "unknown";
    const knownDevices = (await this.readJson<KnownDevice[]>(key)) ?? [];

    const alreadyKnown = knownDevices.some(
      (device) => device.ip === ip && device.userAgent === normalizedUserAgent
    );
    const isNewDevice = knownDevices.length > 0 && !alreadyKnown;

    if (!alreadyKnown) {
      const updated: KnownDevice[] = [
        ...knownDevices,
        { ip, userAgent: normalizedUserAgent, firstSeenAt: new Date().toISOString() },
      ];
      // Bound the list so an account with rotating IPs cannot grow it unbounded.
      const trimmed = updated.slice(-50);
      await this.writeJson(key, trimmed, this.knownDeviceTtlSeconds);
    }

    return { isNewDevice, knownDeviceCount: knownDevices.length };
  }

  /**
   * Full post-authentication security check: clears the failed-login
   * counter, evaluates device novelty, and - if this is a new device/IP for
   * the user - logs the anomaly and sends an email alert. A mailer failure is
   * caught and logged, never thrown: an alert that fails to send must not
   * fail the login that triggered it.
   */
  public async handleSuccessfulLogin(params: {
    userId: string;
    email: string;
    username: string;
    ip: string;
    userAgent?: string | null;
  }): Promise<NewDeviceLoginResult> {
    await this.resetFailedLogins(params.email);

    const novelty = await this.evaluateDeviceNovelty(params.userId, params.ip, params.userAgent);

    if (novelty.isNewDevice) {
      this.anomalyLog.record({
        type: SecurityAnomalyType.NEW_DEVICE_LOGIN,
        userId: params.userId,
        identifier: params.email,
        ip: params.ip,
        userAgent: params.userAgent,
      });

      try {
        await this.mailerClient.send({
          to: params.email,
          subject: "New sign-in to your FantasyXI account",
          text:
            `Hi ${params.username},\n\n` +
            "We noticed a new sign-in to your FantasyXI account from a device or location we haven't seen before.\n\n" +
            `IP address: ${params.ip}\n` +
            `Device: ${params.userAgent ?? "unknown"}\n\n` +
            "If this was you, no action is needed. If you don't recognize this activity, please change your password immediately.",
        });
      } catch (error) {
        console.error("[security] Failed to send new-device login alert email:", error);
      }
    }

    return novelty;
  }
}

export const loginSecurityService = new LoginSecurityService();
