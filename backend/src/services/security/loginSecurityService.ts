/**
 * Login Security Service (issues #117, #331).
 *
 * Runs after the password has been verified and decides whether the login may
 * complete, building on the existing AuthService rather than replacing it:
 *  - Failed-login spikes (#117): a sliding-window counter per identifier (the
 *    normalized email, since brute-forcing targets an account regardless of
 *    which IP the attempts come from). Detection and alerting only.
 *  - Impossible travel (#331): the great-circle distance between this login's
 *    IP-derived location and the previous successful login's, divided by the
 *    time between them. A speed no traveller could reach blocks the login and
 *    alerts the owner.
 *  - Device fingerprinting (#331): a SHA-256 device ID derived from the
 *    browser's entropy fingerprint and user agent. A login from a device not
 *    seen before for the account must pass an email one-time-code challenge
 *    before a token is issued.
 *
 * Storage reuses the Redis instance added for #139 (same IRedisCacheClient
 * interface as fplClient.ts), with an in-memory fallback so behavior degrades
 * gracefully instead of failing login when Redis is unavailable. Per user it
 * keeps at most MAX_KNOWN_DEVICES device IDs plus the last successful login,
 * so space is O(1) per account and every check is O(MAX_KNOWN_DEVICES).
 */

import crypto from "crypto";
import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import { mailer as defaultMailer, Mailer } from "./mailer.js";
import {
  securityAnomalyLog as defaultAnomalyLog,
  SecurityAnomalyLog,
  SecurityAnomalyType,
} from "./securityAnomalyLog.js";
import { assessTravel, DEFAULT_TRAVEL_POLICY, GeoPoint, TravelPolicy } from "./geoVelocity.js";

export interface LoginSecurityOptions {
  redis?: IRedisCacheClient | null;
  mailer?: Mailer;
  anomalyLog?: SecurityAnomalyLog;
  /** Failed attempts within the window that count as a spike. Default 5. */
  failedLoginThreshold?: number;
  /** Sliding window for counting failed attempts, in ms. Default 10 minutes. */
  failedLoginWindowMs?: number;
  /** How long a known device and the last login are remembered, in seconds. Default 90 days. */
  knownDeviceTtlSeconds?: number;
  travelPolicy?: TravelPolicy;
  /** Lifetime of a step-up challenge, in seconds. Default 10 minutes. */
  challengeTtlSeconds?: number;
  now?: () => number;
}

export interface FailedLoginResult {
  spikeDetected: boolean;
  recentFailureCount: number;
}

/** A password-verified login attempt, with what the request revealed about the client. */
export interface LoginAttempt {
  userId: string;
  email: string;
  username: string;
  ip: string;
  userAgent?: string | null;
  /** Browser entropy hash sent by the frontend (see frontend/src/lib/deviceFingerprint.ts). */
  deviceFingerprint?: string | null;
  location?: GeoPoint | null;
}

export type LoginRiskAssessment =
  | { decision: "ALLOW" }
  | { decision: "CHALLENGE"; challengeId: string; expiresAt: Date }
  | { decision: "BLOCK"; reason: "IMPOSSIBLE_TRAVEL" };

export type ChallengeVerification =
  | { verified: true; userId: string }
  | { verified: false; attemptsRemaining: number };

interface KnownDevice {
  deviceId: string;
  firstSeenAt: string;
}

interface LastLogin {
  at: number;
  location: GeoPoint | null;
}

interface PendingChallenge {
  userId: string;
  email: string;
  deviceId: string;
  location: GeoPoint | null;
  codeHash: string;
  attempts: number;
  expiresAt: number;
}

const FAILED_LOGIN_PREFIX = "security:failed-login:";
// v2: entries are fingerprint-based device IDs; the v1 (ip, userAgent) pairs are not comparable
const KNOWN_DEVICE_PREFIX = "security:known-devices:v2:";
const LAST_LOGIN_PREFIX = "security:last-login:";
const CHALLENGE_PREFIX = "security:challenge:";
const MAX_KNOWN_DEVICES = 50;
const MAX_CHALLENGE_ATTEMPTS = 5;
export const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** SHA-256 of the client fingerprint and user agent; only this digest is stored. */
export function deriveDeviceId(fingerprint: string | null | undefined, userAgent: string | null | undefined): string {
  const entropy = fingerprint && FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : "";
  return crypto
    .createHash("sha256")
    .update(`${entropy}\n${userAgent?.trim() || "unknown"}`)
    .digest("hex");
}

function hashChallengeCode(challengeId: string, code: string): Buffer {
  return crypto.createHash("sha256").update(`${challengeId}:${code}`).digest();
}

export class LoginSecurityService {
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private redis: IRedisCacheClient | null;
  private mailerClient: Mailer;
  private anomalyLog: SecurityAnomalyLog;
  private failedLoginThreshold: number;
  private failedLoginWindowMs: number;
  private knownDeviceTtlSeconds: number;
  private travelPolicy: TravelPolicy;
  private challengeTtlSeconds: number;
  private now: () => number;

  constructor(options: LoginSecurityOptions = {}) {
    this.redis = options.redis !== undefined ? options.redis : getRedisClient();
    this.mailerClient = options.mailer ?? defaultMailer;
    this.anomalyLog = options.anomalyLog ?? defaultAnomalyLog;
    this.failedLoginThreshold = options.failedLoginThreshold ?? 5;
    this.failedLoginWindowMs = options.failedLoginWindowMs ?? 10 * 60 * 1000;
    this.knownDeviceTtlSeconds = options.knownDeviceTtlSeconds ?? 90 * 24 * 60 * 60;
    this.travelPolicy = options.travelPolicy ?? DEFAULT_TRAVEL_POLICY;
    this.challengeTtlSeconds = options.challengeTtlSeconds ?? 10 * 60;
    this.now = options.now ?? Date.now;
  }

  /** Allows injecting or replacing the Redis client (e.g. for testing). */
  public setRedisClient(client: IRedisCacheClient | null): void {
    this.redis = client;
  }

  private async readJson<T>(key: string): Promise<T | null> {
    if (this.redis) {
      try {
        // Redis is authoritative whenever it answers: a miss means another
        // node deleted or expired the key, so this node's in-memory mirror must
        // not resurrect it (that would let a used challenge code be replayed).
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
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
   * automated account freezing is explicitly out of scope for issue #117.
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
   * Decides whether a password-verified login may complete:
   *  - BLOCK when reaching here from the previous login's location would take
   *    an impossible speed (the owner is emailed; nothing is recorded, so the
   *    attacker's location never becomes the baseline);
   *  - CHALLENGE when the device is new for the account (an email code is sent);
   *  - ALLOW otherwise, recording the login as the new baseline.
   * The very first login recorded for an account is allowed: there is nothing
   * to compare it against yet.
   */
  public async assessLogin(attempt: LoginAttempt): Promise<LoginRiskAssessment> {
    const now = this.now();
    const deviceId = deriveDeviceId(attempt.deviceFingerprint, attempt.userAgent);
    const [knownDevices, lastLogin] = await Promise.all([
      this.readJson<KnownDevice[]>(`${KNOWN_DEVICE_PREFIX}${attempt.userId}`),
      this.readJson<LastLogin>(`${LAST_LOGIN_PREFIX}${attempt.userId}`),
    ]);
    const location = attempt.location ?? null;

    if (lastLogin?.location && location) {
      const travel = assessTravel(
        { point: lastLogin.location, at: lastLogin.at },
        { point: location, at: now },
        this.travelPolicy
      );
      if (travel.impossible) {
        this.anomalyLog.record({
          type: SecurityAnomalyType.IMPOSSIBLE_TRAVEL,
          userId: attempt.userId,
          identifier: attempt.email,
          ip: attempt.ip,
          userAgent: attempt.userAgent,
          detail: {
            distanceKm: Math.round(travel.distanceKm),
            elapsedMinutes: Math.round(travel.elapsedHours * 60),
          },
        });
        await this.sendMail(attempt.email, "We blocked a sign-in to your FantasyXI account",
          `Hi ${attempt.username},\n\n` +
            `We blocked a sign-in to your FantasyXI account from about ${Math.round(travel.distanceKm)} km away ` +
            `from your previous sign-in, ${Math.round(travel.elapsedHours * 60)} minutes earlier - faster than anyone could travel.\n\n` +
            `IP address: ${attempt.ip}\n` +
            `Device: ${attempt.userAgent ?? "unknown"}\n\n` +
            "If this was you (for example through a VPN), try again later from your usual connection. " +
            "If it wasn't, your password is known to someone else: change it immediately."
        );
        return { decision: "BLOCK", reason: "IMPOSSIBLE_TRAVEL" };
      }
    }

    const devices = knownDevices ?? [];
    if (devices.length > 0 && !devices.some((device) => device.deviceId === deviceId)) {
      this.anomalyLog.record({
        type: SecurityAnomalyType.NEW_DEVICE_LOGIN,
        userId: attempt.userId,
        identifier: attempt.email,
        ip: attempt.ip,
        userAgent: attempt.userAgent,
      });
      return this.createChallenge(attempt, deviceId, location);
    }

    await this.recordSuccessfulLogin(attempt.userId, attempt.email, deviceId, location);
    return { decision: "ALLOW" };
  }

  /**
   * Checks a step-up code. Codes are single-use; a challenge is discarded
   * after MAX_CHALLENGE_ATTEMPTS wrong codes or when it expires.
   */
  public async verifyChallenge(challengeId: string, code: string): Promise<ChallengeVerification> {
    const key = `${CHALLENGE_PREFIX}${challengeId}`;
    const challenge = await this.readJson<PendingChallenge>(key);
    const now = this.now();
    if (!challenge || now >= challenge.expiresAt) {
      return { verified: false, attemptsRemaining: 0 };
    }

    const expected = Buffer.from(challenge.codeHash, "hex");
    if (!crypto.timingSafeEqual(hashChallengeCode(challengeId, code), expected)) {
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
        await this.deleteKey(key);
        return { verified: false, attemptsRemaining: 0 };
      }
      const ttlSeconds = Math.max(1, Math.ceil((challenge.expiresAt - now) / 1000));
      await this.writeJson(key, { ...challenge, attempts }, ttlSeconds);
      return { verified: false, attemptsRemaining: MAX_CHALLENGE_ATTEMPTS - attempts };
    }

    await this.deleteKey(key);
    await this.recordSuccessfulLogin(challenge.userId, challenge.email, challenge.deviceId, challenge.location);
    return { verified: true, userId: challenge.userId };
  }

  private async createChallenge(
    attempt: LoginAttempt,
    deviceId: string,
    location: GeoPoint | null
  ): Promise<LoginRiskAssessment> {
    const challengeId = crypto.randomBytes(32).toString("base64url");
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = this.now() + this.challengeTtlSeconds * 1000;

    const challenge: PendingChallenge = {
      userId: attempt.userId,
      email: attempt.email,
      deviceId,
      location,
      codeHash: hashChallengeCode(challengeId, code).toString("hex"),
      attempts: 0,
      expiresAt,
    };
    await this.writeJson(`${CHALLENGE_PREFIX}${challengeId}`, challenge, this.challengeTtlSeconds);

    await this.sendMail(attempt.email, "Your FantasyXI sign-in code",
      `Hi ${attempt.username},\n\n` +
        "We noticed a sign-in to your FantasyXI account from a device we haven't seen before.\n\n" +
        `Your verification code is: ${code}\n` +
        `It expires in ${Math.round(this.challengeTtlSeconds / 60)} minutes.\n\n` +
        `IP address: ${attempt.ip}\n` +
        `Device: ${attempt.userAgent ?? "unknown"}\n\n` +
        "If this wasn't you, do not share this code and change your password immediately."
    );
    return { decision: "CHALLENGE", challengeId, expiresAt: new Date(expiresAt) };
  }

  /** Makes this device and location the account's baseline for future logins. */
  private async recordSuccessfulLogin(
    userId: string,
    email: string,
    deviceId: string,
    location: GeoPoint | null
  ): Promise<void> {
    const devicesKey = `${KNOWN_DEVICE_PREFIX}${userId}`;
    const devices = (await this.readJson<KnownDevice[]>(devicesKey)) ?? [];
    if (!devices.some((device) => device.deviceId === deviceId)) {
      devices.push({ deviceId, firstSeenAt: new Date(this.now()).toISOString() });
    }
    const lastLogin: LastLogin = { at: this.now(), location };
    await Promise.all([
      // Bounded so an account cannot grow the list without limit
      this.writeJson(devicesKey, devices.slice(-MAX_KNOWN_DEVICES), this.knownDeviceTtlSeconds),
      this.writeJson(`${LAST_LOGIN_PREFIX}${userId}`, lastLogin, this.knownDeviceTtlSeconds),
      this.resetFailedLogins(email),
    ]);
  }

  /**
   * A mailer failure is caught and logged, never thrown: an alert that fails
   * to send must not fail the request that triggered it.
   */
  private async sendMail(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.mailerClient.send({ to, subject, text });
    } catch (error) {
      console.error(`[security] Failed to send "${subject}" email:`, error);
    }
  }
}

export const loginSecurityService = new LoginSecurityService();
