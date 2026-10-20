import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { requireAuth, optionalAuth } from "../middleware/authMiddleware.js";
import {
  signAccessToken,
  verifyAccessToken,
  getJwtSecret,
  getTokenRemainingTtlSeconds,
} from "../config/jwt.js";
import {
  SessionService,
  sessionService,
  SessionRedisClient,
  RedisPipelineLike,
} from "../services/auth/sessionService.js";
import { AuthService } from "../services/auth/authService.js";
import { LoginSecurityService } from "../services/security/loginSecurityService.js";
import {
  getActiveSessions,
  revokeActiveSession,
  logoutAll,
} from "../controllers/auth.controller.js";

/**
 * Creates mock Express Request and Response objects.
 */
function createMockReqRes(authHeader?: string) {
  let statusCode = 200;
  let jsonResponse: unknown = null;
  let nextCalled = false;

  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    user: undefined,
  } as unknown as Request;

  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      jsonResponse = payload;
      return res;
    },
  } as unknown as Response;

  const next: NextFunction = () => {
    nextCalled = true;
  };

  return {
    req,
    res,
    next,
    getStatusCode: () => statusCode,
    getJsonResponse: () => jsonResponse as { success: boolean; message: string },
    wasNextCalled: () => nextCalled,
  };
}

describe("JWT Authentication Middleware", () => {
  it("should authenticate request with valid Bearer token and attach req.user", () => {
    const token = signAccessToken({
      userId: "usr_12345",
      email: "stanley@example.com",
      username: "stanley",
    });

    const { req, res, next, wasNextCalled } = createMockReqRes(`Bearer ${token}`);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), true);
    assert.ok(req.user);
    assert.equal(req.user?.id, "usr_12345");
    assert.equal(req.user?.email, "stanley@example.com");
    assert.equal(req.user?.username, "stanley");
  });

  it("should reject request with missing Authorization header (401)", () => {
    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes(undefined);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.equal(getJsonResponse().success, false);
    assert.match(getJsonResponse().message, /missing/i);
  });

  it("should reject request with malformed Authorization header (missing Bearer prefix)", () => {
    const token = signAccessToken({
      userId: "usr_12345",
      email: "stanley@example.com",
      username: "stanley",
    });

    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes(`Token ${token}`);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.match(getJsonResponse().message, /expected bearer/i);
  });

  it("should reject request with invalid signature / corrupted token (401)", () => {
    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes("Bearer corrupted.invalid.token");

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.match(getJsonResponse().message, /invalid authentication token/i);
  });

  it("should reject expired token with clear 401 expiration message", () => {
    // Generate a token that expired 10 seconds ago
    const secret = getJwtSecret();
    const expiredToken = jwt.sign(
      {
        userId: "usr_expired",
        email: "expired@example.com",
        username: "expired",
      },
      secret,
      { expiresIn: "-10s" }
    );

    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes(`Bearer ${expiredToken}`);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.match(getJsonResponse().message, /expired/i);
  });

  it("optionalAuth should attach user when valid token present", () => {
    const token = signAccessToken({
      userId: "usr_guest",
      email: "guest@example.com",
      username: "guest",
    });

    const { req, res, next, wasNextCalled } = createMockReqRes(`Bearer ${token}`);

    optionalAuth(req, res, next);

    assert.equal(wasNextCalled(), true);
    assert.equal(req.user?.id, "usr_guest");
  });

  it("optionalAuth should continue without error when token is absent", () => {
    const { req, res, next, wasNextCalled } = createMockReqRes(undefined);

    optionalAuth(req, res, next);

    assert.equal(wasNextCalled(), true);
    assert.equal(req.user, undefined);
  });
});

/**
 * In-memory fake Redis client with pipeline support and TTL tracking for
 * verifying Redis session management and `< 2ms` pipelined blacklist checks.
 */
function createMockSessionRedis() {
  const store = new Map<string, { value: string; expiresAtMs: number | null; ttlSeconds: number | null }>();
  let pipelineCalls = 0;

  const client: SessionRedisClient & {
    store: typeof store;
    getPipelineCalls: () => number;
  } = {
    status: "ready",
    store,
    getPipelineCalls: () => pipelineCalls,
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, mode?: string, duration?: number) {
      const ttl = mode === "EX" && typeof duration === "number" ? duration : null;
      store.set(key, {
        value,
        ttlSeconds: ttl,
        expiresAtMs: ttl !== null ? Date.now() + ttl * 1000 : null,
      });
      return "OK";
    },
    async del(...keys: string[]) {
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted++;
      }
      return deleted;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, "");
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    pipeline(): RedisPipelineLike {
      pipelineCalls++;
      const ops: Array<() => Promise<[Error | null, unknown]>> = [];
      const pipe: RedisPipelineLike = {
        get(key: string) {
          ops.push(async () => [null, await client.get(key)]);
          return pipe;
        },
        set(key: string, value: string, mode?: string, duration?: number) {
          ops.push(async () => [null, await client.set(key, value, mode, duration)]);
          return pipe;
        },
        del(...keys: string[]) {
          ops.push(async () => [null, await client.del(...keys)]);
          return pipe;
        },
        async exec() {
          return Promise.all(ops.map((fn) => fn()));
        },
      };
      return pipe;
    },
  };

  return client;
}

describe("Session Revocation, Device Management & Redis Token Blacklisting (Issue #227)", () => {
  beforeEach(() => {
    sessionService.reset();
    sessionService.setRedisClient(null);
  });

  it("includes a unique jti claim on all generated JWT access tokens", () => {
    const tokenA = signAccessToken({
      userId: "usr_1",
      email: "a@example.com",
      username: "alice",
    });
    const tokenB = signAccessToken({
      userId: "usr_1",
      email: "a@example.com",
      username: "alice",
    });

    const decodedA = verifyAccessToken(tokenA);
    const decodedB = verifyAccessToken(tokenB);

    assert.ok(typeof decodedA.jti === "string" && decodedA.jti.length > 0);
    assert.ok(typeof decodedB.jti === "string" && decodedB.jti.length > 0);
    assert.notEqual(decodedA.jti, decodedB.jti);
  });

  it("stores active device sessions under user:sessions:{userId} and lists them", async () => {
    const mockRedis = createMockSessionRedis();
    sessionService.setRedisClient(mockRedis);

    const token1 = signAccessToken({ userId: "usr_42", email: "u@example.com", username: "user42" });
    const token2 = signAccessToken({ userId: "usr_42", email: "u@example.com", username: "user42" });

    await sessionService.recordSession({
      userId: "usr_42",
      token: token1,
      ip: "203.0.113.10",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    await sessionService.recordSession({
      userId: "usr_42",
      token: token2,
      ip: "198.51.100.22",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });

    const rawStored = await mockRedis.get("user:sessions:usr_42");
    assert.ok(rawStored);

    const sessions = await sessionService.listActiveSessions("usr_42");
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].device, "iPhone");
    assert.equal(sessions[0].ip, "198.51.100.22");
    assert.equal(sessions[1].device, "Mac");
    assert.equal(sessions[1].ip, "203.0.113.10");
  });

  it("rejects blacklisted tokens in authMiddleware with 401 in under 2ms using Redis pipelining", async () => {
    const mockRedis = createMockSessionRedis();
    sessionService.setRedisClient(mockRedis);

    const token = signAccessToken({
      userId: "usr_99",
      email: "revoked@example.com",
      username: "revoked_user",
    });
    const decoded = verifyAccessToken(token);
    const remainingTtl = getTokenRemainingTtlSeconds(decoded);

    await sessionService.recordSession({
      userId: "usr_99",
      token,
      ip: "10.0.0.1",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    });

    // Revoke only in Redis (and clear in-memory mirror to force pipelined Redis lookup)
    await sessionService.revokeSession("usr_99", decoded.jti!);
    const blacklistEntry = mockRedis.store.get(`blacklist:jti:${decoded.jti}`);
    assert.ok(blacklistEntry);
    assert.ok(
      blacklistEntry.ttlSeconds! > 0 && blacklistEntry.ttlSeconds! <= remainingTtl + 1,
      "Blacklist entry TTL must match token remaining lifetime"
    );

    sessionService.reset(); // clear local cache so checkTokenBlacklistPipelined hits Redis pipeline

    const startMs = performance.now();
    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes(`Bearer ${token}`);

    await requireAuth(req, res, next);
    const elapsedMs = performance.now() - startMs;

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.match(getJsonResponse().message, /revoked/i);
    assert.ok(mockRedis.getPipelineCalls() >= 1, "Expected Redis pipeline to be executed");
    assert.ok(elapsedMs < 2, `Expected blacklist check under 2ms, took ${elapsedMs.toFixed(3)}ms`);
  });

  it("automatically expires blacklisted jti entries once their TTL elapses", async () => {
    const localSessionService = new SessionService(null);
    const token = signAccessToken({
      userId: "usr_ttl",
      email: "ttl@example.com",
      username: "ttl_user",
    });
    const decoded = verifyAccessToken(token);

    const nowMs = Date.now();
    await localSessionService.blacklistJti(decoded.jti!, 5, nowMs);

    assert.equal(localSessionService.isTokenRevokedSync(decoded, nowMs + 2000), true);
    assert.equal(localSessionService.isTokenRevokedSync(decoded, nowMs + 6000), false);
  });

  it("revokes all active sessions via logout-all endpoint and rejects subsequent requests", async () => {
    const mockRedis = createMockSessionRedis();
    sessionService.setRedisClient(mockRedis);

    const tokenDesktop = signAccessToken({
      userId: "usr_multi",
      email: "multi@example.com",
      username: "multi",
    });
    const tokenMobile = signAccessToken({
      userId: "usr_multi",
      email: "multi@example.com",
      username: "multi",
    });

    await sessionService.recordSession({
      userId: "usr_multi",
      token: tokenDesktop,
      ip: "192.0.2.1",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    await sessionService.recordSession({
      userId: "usr_multi",
      token: tokenMobile,
      ip: "192.0.2.2",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });

    // Call logoutAll controller
    const logoutMock = createMockReqRes(`Bearer ${tokenDesktop}`);
    await requireAuth(logoutMock.req, logoutMock.res, logoutMock.next);
    assert.equal(logoutMock.wasNextCalled(), true);

    await logoutAll(logoutMock.req, logoutMock.res, logoutMock.next);
    const logoutPayload = logoutMock.getJsonResponse() as unknown as {
      success: boolean;
      data: { revokedCount: number };
    };
    assert.equal(logoutPayload.success, true);
    assert.equal(logoutPayload.data.revokedCount, 2);

    // Both desktop and mobile tokens must now be rejected with 401
    const checkDesktop = createMockReqRes(`Bearer ${tokenDesktop}`);
    await requireAuth(checkDesktop.req, checkDesktop.res, checkDesktop.next);
    assert.equal(checkDesktop.wasNextCalled(), false);
    assert.equal(checkDesktop.getStatusCode(), 401);

    const checkMobile = createMockReqRes(`Bearer ${tokenMobile}`);
    await requireAuth(checkMobile.req, checkMobile.res, checkMobile.next);
    assert.equal(checkMobile.wasNextCalled(), false);
    assert.equal(checkMobile.getStatusCode(), 401);

    assert.deepEqual(await sessionService.listActiveSessions("usr_multi"), []);
  });

  it("lists and revokes individual sessions via controller handlers", async () => {
    const token1 = signAccessToken({ userId: "usr_dev", email: "d@example.com", username: "dev" });
    const token2 = signAccessToken({ userId: "usr_dev", email: "d@example.com", username: "dev" });
    const decoded2 = verifyAccessToken(token2);

    await sessionService.recordSession({ userId: "usr_dev", token: token1, ip: "1.1.1.1", userAgent: "Mac" });
    await sessionService.recordSession({ userId: "usr_dev", token: token2, ip: "2.2.2.2", userAgent: "iPhone" });

    const listMock = createMockReqRes(`Bearer ${token1}`);
    requireAuth(listMock.req, listMock.res, listMock.next);
    await getActiveSessions(listMock.req, listMock.res, listMock.next);
    const listed = listMock.getJsonResponse() as unknown as {
      success: boolean;
      data: { sessions: Array<{ jti: string }>; currentJti: string };
    };
    assert.equal(listed.success, true);
    assert.equal(listed.data.sessions.length, 2);

    // Revoke token2 specifically
    const revokeMock = createMockReqRes(`Bearer ${token1}`);
    requireAuth(revokeMock.req, revokeMock.res, revokeMock.next);
    revokeMock.req.params = { jti: decoded2.jti! };
    await revokeActiveSession(revokeMock.req, revokeMock.res, revokeMock.next);

    // token1 remains valid, token2 is rejected
    const check1 = createMockReqRes(`Bearer ${token1}`);
    requireAuth(check1.req, check1.res, check1.next);
    assert.equal(check1.wasNextCalled(), true);

    const check2 = createMockReqRes(`Bearer ${token2}`);
    requireAuth(check2.req, check2.res, check2.next);
    assert.equal(check2.wasNextCalled(), false);
    assert.equal(check2.getStatusCode(), 401);
  });

  it("automatically invalidates all prior sessions when user changes their password", async () => {
    const users: any[] = [];
    const mockDb = {
      user: {
        findUnique: async ({ where }: any) =>
          users.find((u) => u.id === where.id || u.email === where.email || u.username === where.username) ?? null,
        create: async ({ data }: any) => {
          const u = { id: "usr_pw", ...data, createdAt: new Date(), updatedAt: new Date() };
          users.push(u);
          return u;
        },
        update: async ({ where, data }: any) => {
          const u = users.find((item) => item.id === where.id);
          Object.assign(u, data, { updatedAt: new Date() });
          return u;
        },
      },
    };

    const service = new AuthService(
      mockDb,
      undefined,
      new LoginSecurityService({ redis: null })
    );
    const reg = await service.register({
      email: "pwchange@example.com",
      password: "oldPassword123",
    });
    const login2 = await service.login(
      { email: "pwchange@example.com", password: "oldPassword123" },
      { ip: "10.0.0.9", userAgent: "iPad" }
    );

    assert.equal((await service.listSessions(reg.user.id)).length, 2);

    // Change password -> should invalidate all prior sessions
    await service.setPassword(reg.user.id, {
      currentPassword: "oldPassword123",
      password: "newPassword456",
    });

    assert.equal((await service.listSessions(reg.user.id)).length, 0);

    // Both old tokens must now be rejected by requireAuth
    for (const oldToken of [reg.token, login2.token]) {
      const check = createMockReqRes(`Bearer ${oldToken}`);
      requireAuth(check.req, check.res, check.next);
      assert.equal(check.wasNextCalled(), false);
      assert.equal(check.getStatusCode(), 401);
    }
  });
});
