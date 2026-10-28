/**
 * Active Session Registry & Device Fingerprinting Service
 *
 * Implements:
 * 1. Device fingerprinting from request headers (OS, Browser, Device Type, IP).
 * 2. Active session registry with fast revocation checking.
 * 3. Cross-tab and multi-device real-time invalidation dispatch.
 */

import crypto from "crypto";
import { EventEmitter } from "events";

export interface DeviceInfo {
  browser: string;
  os: string;
  deviceType: "desktop" | "mobile" | "tablet" | "unknown";
  ip: string;
  userAgent: string;
  fingerprintHash: string;
}

export interface UserSession {
  id: string; // Session ID (UUID)
  userId: string;
  device: DeviceInfo;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  isRevoked: boolean;
  revokedAt?: Date;
  revocationReason?: string;
}

export interface SessionRevocationEvent {
  userId: string;
  revokedSessionId?: string;
  revokedAllExcept?: string;
  reason?: string;
  timestamp: Date;
}

export class SessionRegistryService {
  private static instance: SessionRegistryService;
  private sessions = new Map<string, UserSession>();
  private userSessionsIndex = new Map<string, Set<string>>(); // userId -> Set<sessionId>
  private revokedSessionIds = new Set<string>();
  private eventEmitter = new EventEmitter();

  constructor() {
    this.eventEmitter.setMaxListeners(500);
  }

  public static getInstance(): SessionRegistryService {
    if (!SessionRegistryService.instance) {
      SessionRegistryService.instance = new SessionRegistryService();
    }
    return SessionRegistryService.instance;
  }

  /**
   * Parses DeviceInfo from IP and User-Agent headers.
   */
  public parseDeviceInfo(ip: string, userAgent: string = ""): DeviceInfo {
    const cleanIp = ip.replace(/^.*:/, "") || "127.0.0.1";
    const ua = userAgent || "Unknown Client";

    let browser = "Other";
    if (ua.includes("Firefox/")) browser = "Firefox";
    else if (ua.includes("Edg/")) browser = "Edge";
    else if (ua.includes("Chrome/") && !ua.includes("Edg/")) browser = "Chrome";
    else if (ua.includes("Safari/") && !ua.includes("Chrome/")) browser = "Safari";

    let os = "Unknown";
    if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
    else if (ua.includes("Android")) os = "Android";
    else if (ua.includes("Mac OS X") || ua.includes("Macintosh")) os = "macOS";
    else if (ua.includes("Windows NT")) os = "Windows";
    else if (ua.includes("Linux")) os = "Linux";

    let deviceType: DeviceInfo["deviceType"] = "desktop";
    if (ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone")) {
      deviceType = "mobile";
    } else if (ua.includes("iPad") || ua.includes("Tablet")) {
      deviceType = "tablet";
    }

    const fingerprintHash = crypto
      .createHash("sha256")
      .update(`${cleanIp}::${ua}`)
      .digest("hex");

    return {
      browser,
      os,
      deviceType,
      ip: cleanIp,
      userAgent: ua,
      fingerprintHash,
    };
  }

  /**
   * Registers a new session upon login or refresh.
   */
  public async createSession(
    userId: string,
    reqContext: { ip: string; userAgent?: string | null },
    ttlSeconds: number = 7 * 24 * 3600 // 7 days
  ): Promise<UserSession> {
    const sessionId = crypto.randomUUID();
    const device = this.parseDeviceInfo(reqContext.ip, reqContext.userAgent || "");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const session: UserSession = {
      id: sessionId,
      userId,
      device,
      createdAt: now,
      lastActiveAt: now,
      expiresAt,
      isRevoked: false,
    };

    this.sessions.set(sessionId, session);

    if (!this.userSessionsIndex.has(userId)) {
      this.userSessionsIndex.set(userId, new Set());
    }
    this.userSessionsIndex.get(userId)!.add(sessionId);

    return session;
  }

  public async getSession(sessionId: string): Promise<UserSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Lists all non-revoked active sessions for a user.
   */
  public async listUserSessions(userId: string): Promise<UserSession[]> {
    const sessionIds = this.userSessionsIndex.get(userId);
    if (!sessionIds) return [];

    const now = new Date();
    const result: UserSession[] = [];

    for (const id of sessionIds) {
      const session = this.sessions.get(id);
      if (session && !session.isRevoked && session.expiresAt > now) {
        result.push(session);
      }
    }

    // Sort newest first
    return result.reverse().sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
  }

  /**
   * Checks whether a session ID is currently valid (not revoked and not expired).
   */
  public async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
    if (this.revokedSessionIds.has(sessionId)) {
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (session.userId !== userId || session.isRevoked) {
      return false;
    }

    if (session.expiresAt < new Date()) {
      return false;
    }

    // Update lastActiveAt periodically (e.g. at most once every 5 mins)
    const now = new Date();
    if (now.getTime() - session.lastActiveAt.getTime() > 300_000) {
      session.lastActiveAt = now;
    }

    return true;
  }

  /**
   * Revokes an individual session immediately.
   */
  public async revokeSession(sessionId: string, reason: string = "User logged out"): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.revokedSessionIds.add(sessionId);
      return false;
    }

    session.isRevoked = true;
    session.revokedAt = new Date();
    session.revocationReason = reason;
    this.revokedSessionIds.add(sessionId);

    this.dispatchRevocationEvent({
      userId: session.userId,
      revokedSessionId: sessionId,
      reason,
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Revokes all sessions for a user, optionally preserving one (e.g. current device).
   */
  public async revokeAllUserSessions(
    userId: string,
    exceptSessionId?: string,
    reason: string = "Logged out other devices"
  ): Promise<number> {
    const sessionIds = this.userSessionsIndex.get(userId);
    if (!sessionIds) return 0;

    let revokedCount = 0;
    const now = new Date();

    for (const id of sessionIds) {
      if (exceptSessionId && id === exceptSessionId) {
        continue;
      }

      const session = this.sessions.get(id);
      if (session && !session.isRevoked) {
        session.isRevoked = true;
        session.revokedAt = now;
        session.revocationReason = reason;
        this.revokedSessionIds.add(id);
        revokedCount++;
      } else {
        this.revokedSessionIds.add(id);
      }
    }

    this.dispatchRevocationEvent({
      userId,
      revokedAllExcept: exceptSessionId,
      reason,
      timestamp: now,
    });

    return revokedCount;
  }

  /**
   * Real-time listener subscription for SSE or WebSocket streaming.
   */
  public onRevocation(listener: (event: SessionRevocationEvent) => void): () => void {
    this.eventEmitter.on("revocation", listener);
    return () => this.eventEmitter.off("revocation", listener);
  }

  private dispatchRevocationEvent(event: SessionRevocationEvent): void {
    this.eventEmitter.emit("revocation", event);
  }

  public clearAll(): void {
    this.sessions.clear();
    this.userSessionsIndex.clear();
    this.revokedSessionIds.clear();
  }
}

export const sessionRegistryService = SessionRegistryService.getInstance();
