import jwt from "jsonwebtoken";
import { getRedisClient, IRedisCacheClient } from "../../config/redis.js";
import { getTokenRemainingTtlSeconds, JwtPayload } from "../../config/jwt.js";

/**
 * Active Session & Redis Token Blacklisting Service (Issue #227).
 *
 * Tracks active device sessions under `user:sessions:{userId}` and maintains a
 * fast lookup blacklist for revoked token `jti` claims under `blacklist:jti:{jti}`
 * with a TTL matching the token's remaining lifetime.
 */

export const USER_SESSIONS_KEY_PREFIX = "user:sessions:";
export const BLACKLIST_JTI_KEY_PREFIX = "blacklist:jti:";
export const USER_REVOKED_BEFORE_KEY_PREFIX = "user:revoked_before:";

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface ActiveSessionMetadata {
  jti: string;
  userId: string;
  device: string;
  ip: string;
  userAgent: string;
  issuedAt: string;
  expiresAt: string;
}

export interface RedisPipelineLike {
  get(key: string): RedisPipelineLike;
  set(key: string, value: string, mode?: string, duration?: number): RedisPipelineLike;
  del(...keys: string[]): RedisPipelineLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface SessionRedisClient extends IRedisCacheClient {
  pipeline?(): RedisPipelineLike;
}

export function deriveDeviceName(userAgent?: string | null, explicitDevice?: string): string {
  if (explicitDevice && explicitDevice.trim().length > 0) {
    return explicitDevice.trim();
  }
  if (!userAgent || userAgent.trim().length === 0) {
    return "Unknown Device";
  }
  const ua = userAgent.trim();
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android Device";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Linux/i.test(ua)) return "Linux";
  return ua.slice(0, 64);
}

export class SessionService {
  private redis: SessionRedisClient | null;
  private customRedisInjected = false;

  // In-memory mirror for sub-millisecond synchronous checks and Redis-offline fallback
  private sessionsCache = new Map<string, { sessions: ActiveSessionMetadata[]; expiresAt: number }>();
  private blacklistCache = new Map<string, number>(); // jti -> expiresAtMs
  private userRevokedBeforeCache = new Map<string, { revokedBeforeSec: number; expiresAt: number }>();

  constructor(redisClient?: SessionRedisClient | null) {
    if (redisClient !== undefined) {
      this.redis = redisClient;
      this.customRedisInjected = redisClient !== null;
    } else {
      this.redis = getRedisClient() as SessionRedisClient | null;
    }
  }

  public setRedisClient(client: SessionRedisClient | null): void {
    this.redis = client;
    this.customRedisInjected = client !== null;
  }

  /**
   * Returns true if a live/ready or explicitly injected Redis client is active.
   */
  public hasActiveRedisConnection(): boolean {
    if (!this.redis) return false;
    if (this.customRedisInjected) return true;
    return this.redis.status === "ready";
  }

  public static userSessionsKey(userId: string): string {
    return `${USER_SESSIONS_KEY_PREFIX}${userId}`;
  }

  public static blacklistJtiKey(jti: string): string {
    return `${BLACKLIST_JTI_KEY_PREFIX}${jti}`;
  }

  public static userRevokedBeforeKey(userId: string): string {
    return `${USER_REVOKED_BEFORE_KEY_PREFIX}${userId}`;
  }

  /**
   * Records a newly issued JWT session under `user:sessions:{userId}`.
   */
  public async recordSession(params: {
    userId: string;
    token: string;
    ip?: string;
    userAgent?: string | null;
    device?: string;
  }): Promise<ActiveSessionMetadata | null> {
    const decoded = jwt.decode(params.token) as JwtPayload | null;
    if (!decoded || !decoded.jti) {
      return null;
    }

    const nowMs = Date.now();
    const issuedAtSec = typeof decoded.iat === "number" ? decoded.iat : Math.floor(nowMs / 1000);
    const ttlSeconds = Math.max(1, getTokenRemainingTtlSeconds(decoded, nowMs));
    const expiresAtSec =
      typeof decoded.exp === "number" ? decoded.exp : issuedAtSec + ttlSeconds;

    const session: ActiveSessionMetadata = {
      jti: decoded.jti,
      userId: params.userId,
      device: deriveDeviceName(params.userAgent, params.device),
      ip: params.ip || "unknown",
      userAgent: params.userAgent?.trim() || "unknown",
      issuedAt: new Date(issuedAtSec * 1000).toISOString(),
      expiresAt: new Date(expiresAtSec * 1000).toISOString(),
    };

    const existing = await this.listActiveSessions(params.userId);
    const updated = [
      session,
      ...existing.filter((s) => s.jti !== session.jti),
    ].slice(0, 25);

    await this.writeSessions(params.userId, updated, ttlSeconds);
    return session;
  }

  /**
   * Lists active (non-expired, non-blacklisted) sessions for a user from
   * `user:sessions:{userId}`.
   */
  public async listActiveSessions(userId: string): Promise<ActiveSessionMetadata[]> {
    const key = SessionService.userSessionsKey(userId);
    const nowMs = Date.now();
    let sessions: ActiveSessionMetadata[] = [];

    if (this.hasActiveRedisConnection() && this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          sessions = JSON.parse(raw) as ActiveSessionMetadata[];
        }
      } catch {
        sessions = this.readCachedSessions(userId, nowMs);
      }
    } else {
      sessions = this.readCachedSessions(userId, nowMs);
    }

    return sessions.filter((s) => {
      const expMs = new Date(s.expiresAt).getTime();
      if (expMs <= nowMs) return false;
      const issuedSec = Math.floor(new Date(s.issuedAt).getTime() / 1000);
      if (this.isJtiBlacklistedSync(s.jti, nowMs)) return false;
      if (this.isRevokedByUserCutoffSync(userId, issuedSec, nowMs)) return false;
      return true;
    });
  }

  /**
   * Blacklists a single `jti` in Redis with TTL matching its remaining lifetime
   * and removes it from `user:sessions:{userId}`.
   */
  public async revokeSession(
    userId: string,
    jti: string,
    ttlSeconds?: number
  ): Promise<boolean> {
    const nowMs = Date.now();
    const sessions = await this.listActiveSessions(userId);
    const target = sessions.find((s) => s.jti === jti);

    let effectiveTtl = ttlSeconds;
    if (effectiveTtl === undefined) {
      if (target) {
        const expMs = new Date(target.expiresAt).getTime();
        effectiveTtl = Math.max(0, Math.ceil((expMs - nowMs) / 1000));
      } else {
        effectiveTtl = DEFAULT_SESSION_TTL_SECONDS;
      }
    }

    await this.blacklistJti(jti, effectiveTtl, nowMs);

    const remaining = sessions.filter((s) => s.jti !== jti);
    await this.writeSessions(userId, remaining, DEFAULT_SESSION_TTL_SECONDS);
    return Boolean(target);
  }

  /**
   * Blacklists a raw JWT string or decoded payload using its `jti` and `exp`.
   */
  public async revokeToken(tokenOrPayload: string | JwtPayload): Promise<void> {
    const payload =
      typeof tokenOrPayload === "string"
        ? (jwt.decode(tokenOrPayload) as JwtPayload | null)
        : tokenOrPayload;

    if (!payload || !payload.jti) return;

    const nowMs = Date.now();
    const ttlSeconds = getTokenRemainingTtlSeconds(payload, nowMs);
    await this.blacklistJti(payload.jti, ttlSeconds, nowMs);

    if (payload.userId) {
      const sessions = await this.listActiveSessions(payload.userId);
      const remaining = sessions.filter((s) => s.jti !== payload.jti);
      await this.writeSessions(payload.userId, remaining, DEFAULT_SESSION_TTL_SECONDS);
    }
  }

  /**
   * Revokes all active sessions for `userId` (used on `POST /api/v1/auth/logout-all`
   * and on password changes). Blacklists every known active `jti` with its remaining
   * TTL, records a user-level revocation cutoff for any untracked tokens issued at or
   * before this moment, and clears `user:sessions:{userId}` in a single Redis pipeline.
   */
  public async revokeAllUserSessions(
    userId: string,
    currentTokenOrPayload?: string | JwtPayload
  ): Promise<{ revokedCount: number; revokedJtis: string[] }> {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const sessions = await this.listActiveSessions(userId);
    const jtiTtls = new Map<string, number>();

    for (const s of sessions) {
      const expMs = new Date(s.expiresAt).getTime();
      const ttl = Math.max(1, Math.ceil((expMs - nowMs) / 1000));
      jtiTtls.set(s.jti, ttl);
    }

    if (currentTokenOrPayload) {
      const payload =
        typeof currentTokenOrPayload === "string"
          ? (jwt.decode(currentTokenOrPayload) as JwtPayload | null)
          : currentTokenOrPayload;
      if (payload?.jti) {
        const ttl = Math.max(1, getTokenRemainingTtlSeconds(payload, nowMs));
        jtiTtls.set(payload.jti, ttl);
      }
    }

    // Update in-memory caches immediately
    for (const [jti, ttl] of jtiTtls.entries()) {
      this.blacklistCache.set(jti, nowMs + ttl * 1000);
    }
    this.userRevokedBeforeCache.set(userId, {
      revokedBeforeSec: nowSec,
      expiresAt: nowMs + DEFAULT_SESSION_TTL_SECONDS * 1000,
    });
    this.sessionsCache.delete(SessionService.userSessionsKey(userId));

    // Execute atomic/pipelined Redis updates
    const sessionsKey = SessionService.userSessionsKey(userId);
    const cutoffKey = SessionService.userRevokedBeforeKey(userId);

    if (this.hasActiveRedisConnection() && this.redis) {
      try {
        if (typeof this.redis.pipeline === "function") {
          const pipe = this.redis.pipeline();
          for (const [jti, ttl] of jtiTtls.entries()) {
            pipe.set(SessionService.blacklistJtiKey(jti), "revoked", "EX", ttl);
          }
          pipe.set(cutoffKey, String(nowSec), "EX", DEFAULT_SESSION_TTL_SECONDS);
          pipe.del(sessionsKey);
          await pipe.exec();
        } else {
          for (const [jti, ttl] of jtiTtls.entries()) {
            await this.redis.set(SessionService.blacklistJtiKey(jti), "revoked", "EX", ttl);
          }
          await this.redis.set(cutoffKey, String(nowSec), "EX", DEFAULT_SESSION_TTL_SECONDS);
          await this.redis.del(sessionsKey);
        }
      } catch {
        // In-memory fallback already updated above
      }
    }

    return {
      revokedCount: jtiTtls.size,
      revokedJtis: [...jtiTtls.keys()],
    };
  }

  /**
   * Synchronous sub-millisecond check against the in-memory blacklist mirror.
   */
  public isTokenRevokedSync(payload: JwtPayload, nowMs: number = Date.now()): boolean {
    if (payload.jti && this.isJtiBlacklistedSync(payload.jti, nowMs)) {
      return true;
    }
    if (payload.userId) {
      const issuedSec = typeof payload.iat === "number" ? payload.iat : 0;
      if (this.isRevokedByUserCutoffSync(payload.userId, issuedSec, nowMs)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks whether `payload` is blacklisted using Redis pipelining (`< 2ms` single
   * round-trip fetching both `blacklist:jti:{jti}` and `user:revoked_before:{userId}`).
   */
  public async checkTokenBlacklistPipelined(
    payload: JwtPayload,
    nowMs: number = Date.now()
  ): Promise<{ revoked: boolean; latencyMs: number }> {
    const start = performance.now();

    if (this.isTokenRevokedSync(payload, nowMs)) {
      return { revoked: true, latencyMs: performance.now() - start };
    }

    if (!this.hasActiveRedisConnection() || !this.redis) {
      return { revoked: false, latencyMs: performance.now() - start };
    }

    const jtiKey = payload.jti ? SessionService.blacklistJtiKey(payload.jti) : null;
    const cutoffKey = payload.userId
      ? SessionService.userRevokedBeforeKey(payload.userId)
      : null;

    try {
      if (typeof this.redis.pipeline === "function") {
        const pipe = this.redis.pipeline();
        if (jtiKey) pipe.get(jtiKey);
        if (cutoffKey) pipe.get(cutoffKey);
        const results = await pipe.exec();

        let idx = 0;
        const jtiVal = jtiKey && results ? (results[idx++]?.[1] as string | null) : null;
        const cutoffVal = cutoffKey && results ? (results[idx]?.[1] as string | null) : null;

        if (jtiVal) {
          return { revoked: true, latencyMs: performance.now() - start };
        }
        if (cutoffVal) {
          const cutoffSec = Number(cutoffVal);
          const issuedSec = typeof payload.iat === "number" ? payload.iat : 0;
          if (Number.isFinite(cutoffSec) && issuedSec <= cutoffSec) {
            return { revoked: true, latencyMs: performance.now() - start };
          }
        }
      } else {
        const [jtiVal, cutoffVal] = await Promise.all([
          jtiKey ? this.redis.get(jtiKey) : Promise.resolve(null),
          cutoffKey ? this.redis.get(cutoffKey) : Promise.resolve(null),
        ]);
        if (jtiVal) {
          return { revoked: true, latencyMs: performance.now() - start };
        }
        if (cutoffVal) {
          const cutoffSec = Number(cutoffVal);
          const issuedSec = typeof payload.iat === "number" ? payload.iat : 0;
          if (Number.isFinite(cutoffSec) && issuedSec <= cutoffSec) {
            return { revoked: true, latencyMs: performance.now() - start };
          }
        }
      }
    } catch {
      // Fallback to in-memory result on Redis error
    }

    return { revoked: false, latencyMs: performance.now() - start };
  }

  public async blacklistJti(
    jti: string,
    ttlSeconds: number,
    nowMs: number = Date.now()
  ): Promise<void> {
    if (ttlSeconds <= 0) {
      this.blacklistCache.delete(jti);
      if (this.hasActiveRedisConnection() && this.redis) {
        try {
          await this.redis.del(SessionService.blacklistJtiKey(jti));
        } catch {
          // ignore
        }
      }
      return;
    }

    this.blacklistCache.set(jti, nowMs + ttlSeconds * 1000);
    if (this.hasActiveRedisConnection() && this.redis) {
      try {
        await this.redis.set(
          SessionService.blacklistJtiKey(jti),
          "revoked",
          "EX",
          ttlSeconds
        );
      } catch {
        // ignore
      }
    }
  }

  /** Test helper to reset in-memory caches between tests. */
  public reset(): void {
    this.sessionsCache.clear();
    this.blacklistCache.clear();
    this.userRevokedBeforeCache.clear();
  }

  private isJtiBlacklistedSync(jti: string, nowMs: number): boolean {
    const expiresAt = this.blacklistCache.get(jti);
    if (expiresAt === undefined) return false;
    if (nowMs >= expiresAt) {
      this.blacklistCache.delete(jti);
      return false;
    }
    return true;
  }

  private isRevokedByUserCutoffSync(
    userId: string,
    issuedAtSec: number,
    nowMs: number
  ): boolean {
    const cutoff = this.userRevokedBeforeCache.get(userId);
    if (!cutoff) return false;
    if (nowMs >= cutoff.expiresAt) {
      this.userRevokedBeforeCache.delete(userId);
      return false;
    }
    return issuedAtSec <= cutoff.revokedBeforeSec;
  }

  private readCachedSessions(userId: string, nowMs: number): ActiveSessionMetadata[] {
    const key = SessionService.userSessionsKey(userId);
    const cached = this.sessionsCache.get(key);
    if (!cached) return [];
    if (nowMs >= cached.expiresAt) {
      this.sessionsCache.delete(key);
      return [];
    }
    return [...cached.sessions];
  }

  private async writeSessions(
    userId: string,
    sessions: ActiveSessionMetadata[],
    ttlSeconds: number
  ): Promise<void> {
    const key = SessionService.userSessionsKey(userId);
    const nowMs = Date.now();

    if (sessions.length === 0) {
      this.sessionsCache.delete(key);
      if (this.hasActiveRedisConnection() && this.redis) {
        try {
          await this.redis.del(key);
        } catch {
          // ignore
        }
      }
      return;
    }

    this.sessionsCache.set(key, {
      sessions,
      expiresAt: nowMs + ttlSeconds * 1000,
    });

    if (this.hasActiveRedisConnection() && this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(sessions), "EX", ttlSeconds);
      } catch {
        // ignore
      }
    }
  }
}

export const sessionService = new SessionService();
