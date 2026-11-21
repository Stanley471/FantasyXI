import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
  AuthService,
  AuthValidationError,
  AuthConflictError,
  AuthUnauthorizedError,
} from "../services/auth/authService.js";
import { verifyAccessToken } from "../config/jwt.js";
import { sessionRegistryService } from "../services/auth/sessionRegistryService.js";

/**
 * Creates an in-memory mock database client for AuthService testing.
 * Allows pure unit testing without external database dependencies.
 */
function createMockAuthDb() {
  const users: Array<{
    id: string;
    email: string;
    passwordHash: string;
    username: string;
    name: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  return {
    users,
    user: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; email?: string; username?: string };
      }) => {
        if (where.id) {
          return users.find((u) => u.id === where.id) || null;
        }
        if (where.email) {
          return users.find((u) => u.email === where.email) || null;
        }
        if (where.username) {
          return users.find((u) => u.username === where.username) || null;
        }
        return null;
      },
      create: async ({
        data,
      }: {
        data: {
          email: string;
          passwordHash: string;
          username: string;
          name: string | null;
        };
      }) => {
        const record = {
          id: `usr_${users.length + 1}_${crypto.randomUUID()}`,
          email: data.email,
          passwordHash: data.passwordHash,
          username: data.username,
          name: data.name,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.push(record);
        return record;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error("User not found");
        Object.assign(user, data);
        return user;
      },
    },
  };
}

/** Adds an in-memory `refreshToken` table to a mock auth db, for issue #501. */
function withMockRefreshTokens(db: ReturnType<typeof createMockAuthDb>) {
  const refreshTokens: Array<{
    id: string;
    userId: string;
    familyId: string;
    tokenHash: string;
    revokedAt: Date | null;
    expiresAt: Date;
  }> = [];

  return {
    ...db,
    refreshTokens,
    refreshToken: {
      create: async ({ data }: { data: any }) => {
        const record = { id: `rt_${refreshTokens.length + 1}`, revokedAt: null, ...data };
        refreshTokens.push(record);
        return record;
      },
      findUnique: async ({ where }: { where: any }) => {
        const token = refreshTokens.find((t) => t.tokenHash === where.tokenHash);
        if (!token) return null;
        const user = (db as any).users.find((u: any) => u.id === token.userId);
        return { ...token, user };
      },
      updateMany: async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const token of refreshTokens) {
          const matchesId = where.id === undefined || token.id === where.id;
          const matchesUser = where.userId === undefined || token.userId === where.userId;
          const matchesFamily = where.familyId === undefined || token.familyId === where.familyId;
          const matchesRevoked = where.revokedAt === undefined || token.revokedAt === where.revokedAt;
          const matchesExpiry =
            where.expiresAt?.gt === undefined || token.expiresAt > where.expiresAt.gt;
          if (matchesId && matchesUser && matchesFamily && matchesRevoked && matchesExpiry) {
            Object.assign(token, data);
            count++;
          }
        }
        return { count };
      },
    },
  };
}

describe("AuthService Registration & Login Domain Rules", () => {
  it("should register a user with bcrypt hashed password and return safe user with token", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    const result = await service.register({
      email: "stanley@example.com",
      password: "password123",
      name: "Stanley",
    });

    // 1. Safe user returned
    assert.equal(result.user.email, "stanley@example.com");
    assert.equal(result.user.name, "Stanley");
    assert.ok(result.user.id);
    assert.ok(result.user.username);

    // 2. Password hash must NEVER be present in the returned user object
    // @ts-expect-error - testing absence of passwordHash
    assert.equal(result.user.passwordHash, undefined);

    // 3. Password was hashed in the database
    const saved = mockDb.users[0];
    assert.notEqual(saved.passwordHash, "password123");
    const isMatch = await bcrypt.compare("password123", saved.passwordHash);
    assert.equal(isMatch, true);

    // 4. Token is valid JWT
    assert.ok(result.token);
    const decoded = verifyAccessToken(result.token);
    assert.equal(decoded.userId, result.user.id);
    assert.equal(decoded.email, "stanley@example.com");
  });

  it("should normalize email to lowercase during registration and login", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "  Stanley.Test@EXAMPLE.COM  ",
      password: "password123",
    });

    const saved = mockDb.users[0];
    assert.equal(saved.email, "stanley.test@example.com");

    // Login with mixed case should also succeed
    const loginResult = await service.login({
      email: "STANLEY.TEST@example.com",
      password: "password123",
    });

    assert.equal(loginResult.user.email, "stanley.test@example.com");
  });

  it("should reject registration with invalid email format", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await assert.rejects(
      async () => {
        await service.register({
          email: "not-an-email",
          password: "password123",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /invalid email/i);
        return true;
      }
    );
  });

  it("should reject registration with password shorter than 8 characters", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await assert.rejects(
      async () => {
        await service.register({
          email: "valid@example.com",
          password: "short",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /at least 8 characters/i);
        return true;
      }
    );
  });

  it("should reject duplicate email registration with AuthConflictError", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "user@example.com",
      password: "password123",
    });

    await assert.rejects(
      async () => {
        await service.register({
          email: "USER@example.com",
          password: "anotherPassword123",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthConflictError);
        assert.match(err.message, /already exists/i);
        return true;
      }
    );
  });

  it("should authenticate valid user on login and return safe user + token", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "user@example.com",
      password: "correct_password",
      name: "Player 1",
    });

    const loginResult = await service.login({
      email: "user@example.com",
      password: "correct_password",
    });

    assert.equal(loginResult.user.email, "user@example.com");
    // @ts-expect-error - testing absence of passwordHash
    assert.equal(loginResult.user.passwordHash, undefined);
    assert.ok(loginResult.token);

    const decoded = verifyAccessToken(loginResult.token);
    assert.equal(decoded.userId, loginResult.user.id);
  });

  it("should reject login with wrong password using generic error", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "user@example.com",
      password: "correct_password",
    });

    await assert.rejects(
      async () => {
        await service.login({
          email: "user@example.com",
          password: "wrong_password",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthUnauthorizedError);
        // Generic error prevents credential enumeration
        assert.equal(err.message, "Invalid email or password");
        return true;
      }
    );
  });

  it("should reject login for nonexistent account with identical generic error", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await assert.rejects(
      async () => {
        await service.login({
          email: "nonexistent@example.com",
          password: "password123",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthUnauthorizedError);
        assert.equal(err.message, "Invalid email or password");
        return true;
      }
    );
  });

  it("should retrieve safe user via getMe", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    const { user } = await service.register({
      email: "user@example.com",
      password: "password123",
      name: "Stanley S",
    });

    const me = await service.getMe(user.id);
    assert.equal(me.id, user.id);
    assert.equal(me.email, "user@example.com");
    assert.equal(me.name, "Stanley S");
    // @ts-expect-error - testing absence of passwordHash
    assert.equal(me.passwordHash, undefined);
  });
});

describe("AuthService.setPassword password change & session revocation (issue #501)", () => {
  it("rejects the change when the current password does not match", async () => {
    const mockDb = withMockRefreshTokens(createMockAuthDb());
    const service = new AuthService(mockDb);
    const { user } = await service.register({
      email: "user@example.com",
      password: "original-pass-1",
      name: "User One",
    });

    await assert.rejects(
      () =>
        service.setPassword(user.id, {
          currentPassword: "wrong-password",
          password: "new-password-1",
        }),
      (err: unknown) => {
        assert.ok(err instanceof AuthUnauthorizedError);
        assert.equal(err.message, "Current password is incorrect");
        return true;
      }
    );
  });

  it("updates the password hash once the current password is verified", async () => {
    const mockDb = withMockRefreshTokens(createMockAuthDb());
    const service = new AuthService(mockDb);
    const { user } = await service.register({
      email: "user@example.com",
      password: "original-pass-1",
      name: "User One",
    });

    const { user: updated, revokedSessions } = await service.setPassword(user.id, {
      currentPassword: "original-pass-1",
      password: "new-password-1",
    });

    assert.equal(updated.id, user.id);
    assert.equal(revokedSessions, 0);
    const stored = mockDb.users.find((u) => u.id === user.id)!;
    assert.ok(await bcrypt.compare("new-password-1", stored.passwordHash));
  });

  it("leaves refresh tokens and sessions untouched when revocation is not requested", async () => {
    const mockDb = withMockRefreshTokens(createMockAuthDb());
    const service = new AuthService(mockDb);
    const { user } = await service.register({
      email: "user@example.com",
      password: "original-pass-1",
      name: "User One",
    });
    await mockDb.refreshToken.create({ data: { userId: user.id, familyId: "fam-1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + 1000) } });
    const session = await sessionRegistryService.createSession(user.id, { ip: "1.2.3.4" });

    await service.setPassword(user.id, {
      currentPassword: "original-pass-1",
      password: "new-password-1",
    });

    assert.equal(mockDb.refreshTokens[0].revokedAt, null);
    assert.equal(await sessionRegistryService.isSessionValid(session.id, user.id), true);
  });

  it("revokes every refresh token and active session when revokeOtherSessions is true", async () => {
    const mockDb = withMockRefreshTokens(createMockAuthDb());
    const service = new AuthService(mockDb);
    const { user } = await service.register({
      email: "user@example.com",
      password: "original-pass-1",
      name: "User One",
    });
    await mockDb.refreshToken.create({ data: { userId: user.id, familyId: "fam-1", tokenHash: "hash-1", expiresAt: new Date(Date.now() + 1000) } });
    await mockDb.refreshToken.create({ data: { userId: user.id, familyId: "fam-2", tokenHash: "hash-2", expiresAt: new Date(Date.now() + 1000) } });
    const sessionA = await sessionRegistryService.createSession(user.id, { ip: "1.2.3.4" });
    const sessionB = await sessionRegistryService.createSession(user.id, { ip: "5.6.7.8" });

    const { revokedSessions } = await service.setPassword(user.id, {
      currentPassword: "original-pass-1",
      password: "new-password-1",
      revokeOtherSessions: true,
    });

    // register() itself opens a session, so this user has 3 active sessions
    // (the registration session plus A and B) before the password change.
    assert.equal(revokedSessions, 3);
    assert.ok(mockDb.refreshTokens.every((t) => t.revokedAt !== null));
    assert.equal(await sessionRegistryService.isSessionValid(sessionA.id, user.id), false);
    assert.equal(await sessionRegistryService.isSessionValid(sessionB.id, user.id), false);
  });

  it("a revoked refresh token immediately fails the rotate/refresh flow", async () => {
    const mockDb = withMockRefreshTokens(createMockAuthDb());
    const service = new AuthService(mockDb);
    const { user } = await service.register({
      email: "user@example.com",
      password: "original-pass-1",
      name: "User One",
    });
    const { RefreshTokenService, RefreshTokenUnauthorizedError } = await import(
      "../services/auth/refreshTokenService.js"
    );
    const refreshTokenService = new RefreshTokenService(mockDb as any);
    const issued = await refreshTokenService.issue(user);

    await service.setPassword(user.id, {
      currentPassword: "original-pass-1",
      password: "new-password-1",
      revokeOtherSessions: true,
    });

    await assert.rejects(
      () => refreshTokenService.rotate(issued.refreshToken),
      RefreshTokenUnauthorizedError
    );
  });
});
