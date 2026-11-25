import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AuthService,
  AuthValidationError,
  AuthConflictError,
  AuthUnauthorizedError,
} from "../services/auth/authService.js";
import {
  generateOAuthState,
  verifyOAuthState,
} from "../config/google.js";
import { verifyAccessToken } from "../config/jwt.js";

/**
 * Creates an in-memory mock database client for Google Auth unit testing.
 */
function createMockGoogleAuthDb() {
  const users: Array<{
    id: string;
    email: string;
    passwordHash: string | null;
    username: string;
    name: string | null;
    googleId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  return {
    users,
    user: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; email?: string; username?: string; googleId?: string };
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
        if (where.googleId) {
          return users.find((u) => u.googleId === where.googleId) || null;
        }
        return null;
      },
      create: async ({
        data,
      }: {
        data: {
          email: string;
          passwordHash: string | null;
          username: string;
          name: string | null;
          googleId: string | null;
        };
      }) => {
        const record = {
          id: `usr_${users.length + 1}`,
          email: data.email,
          passwordHash: data.passwordHash,
          username: data.username,
          name: data.name,
          googleId: data.googleId ?? null,
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
        data: Partial<{
          googleId: string | null;
          name: string | null;
        }>;
      }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error("User not found");
        if (data.googleId !== undefined) user.googleId = data.googleId;
        if (data.name !== undefined && user.name === null) user.name = data.name;
        user.updatedAt = new Date();
        return user;
      },
    },
  };
}

describe("Google OAuth 2.0 / OpenID Connect Authentication", () => {
  it("should create a new user on first-time Google authentication with passwordHash null", async () => {
    const mockDb = createMockGoogleAuthDb();
    const service = new AuthService(mockDb);

    const result = await service.handleGoogleAuth({
      googleId: "google_sub_101",
      email: "stanley@gmail.com",
      name: "Stanley G",
      emailVerified: true,
    });

    // 1. Safe user returned
    assert.equal(result.user.email, "stanley@gmail.com");
    assert.equal(result.user.name, "Stanley G");
    assert.ok(result.user.id);
    assert.ok(result.user.username);

    // 2. Database user record verified
    const saved = mockDb.users[0];
    assert.equal(saved.googleId, "google_sub_101");
    assert.equal(saved.passwordHash, null);

    // 3. FantasyXI JWT is issued and valid
    assert.ok(result.token);
    const decoded = verifyAccessToken(result.token);
    assert.equal(decoded.userId, result.user.id);
    assert.equal(decoded.email, "stanley@gmail.com");
  });

  it("should authenticate existing Google user without creating duplicates", async () => {
    const mockDb = createMockGoogleAuthDb();
    const service = new AuthService(mockDb);

    // First login
    const firstLogin = await service.handleGoogleAuth({
      googleId: "google_sub_101",
      email: "stanley@gmail.com",
      name: "Stanley G",
      emailVerified: true,
    });

    assert.equal(mockDb.users.length, 1);

    // Second login with same Google account
    const secondLogin = await service.handleGoogleAuth({
      googleId: "google_sub_101",
      email: "stanley@gmail.com",
      name: "Stanley G",
      emailVerified: true,
    });

    assert.equal(mockDb.users.length, 1);
    assert.equal(secondLogin.user.id, firstLogin.user.id);
    assert.equal(secondLogin.user.email, "stanley@gmail.com");
  });

  it("should safely link Google identity to existing email/password user preserving existing password hash", async () => {
    const mockDb = createMockGoogleAuthDb();
    const service = new AuthService(mockDb);

    // User initially registered with email and password
    const emailSignup = await service.register({
      email: "stanley@example.com",
      password: "Existing_secure_password_123",
      name: "Stanley",
    });

    const userBeforeLinking = mockDb.users[0];
    const originalPasswordHash = userBeforeLinking.passwordHash;
    assert.ok(originalPasswordHash);
    assert.equal(userBeforeLinking.googleId, null);

    // Later, user signs in with verified Google account matching that email
    const googleLogin = await service.handleGoogleAuth({
      googleId: "google_sub_202",
      email: "stanley@example.com",
      name: "Stanley",
      emailVerified: true,
    });

    // 1. Same user ID
    assert.equal(googleLogin.user.id, emailSignup.user.id);

    // 2. googleId linked
    const userAfterLinking = mockDb.users[0];
    assert.equal(userAfterLinking.googleId, "google_sub_202");

    // 3. Original password hash is PRESERVED intact
    assert.equal(userAfterLinking.passwordHash, originalPasswordHash);

    // 4. User can still log in using their original password
    const pwdLogin = await service.login({
      email: "stanley@example.com",
      password: "Existing_secure_password_123",
    });
    assert.equal(pwdLogin.user.id, emailSignup.user.id);
  });

  it("should reject Google authentication if email is not verified by Google", async () => {
    const mockDb = createMockGoogleAuthDb();
    const service = new AuthService(mockDb);

    await assert.rejects(
      async () => {
        await service.handleGoogleAuth({
          googleId: "google_unverified",
          email: "unverified@example.com",
          name: "Unverified User",
          emailVerified: false,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /not verified/i);
        return true;
      }
    );
  });

  it("should reject linking if existing account is already linked to a different Google account", async () => {
    const mockDb = createMockGoogleAuthDb();
    const service = new AuthService(mockDb);

    // Create user linked to Google Account A
    await service.handleGoogleAuth({
      googleId: "google_account_A",
      email: "shared@example.com",
      name: "User One",
      emailVerified: true,
    });

    // Attempt to authenticate with Google Account B using same email
    await assert.rejects(
      async () => {
        await service.handleGoogleAuth({
          googleId: "google_account_B",
          email: "shared@example.com",
          name: "User Two",
          emailVerified: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthConflictError);
        assert.match(err.message, /different google account/i);
        return true;
      }
    );
  });

  it("should prevent password login for Google-only users with null passwordHash", async () => {
    const mockDb = createMockGoogleAuthDb();
    const service = new AuthService(mockDb);

    await service.handleGoogleAuth({
      googleId: "google_sub_303",
      email: "googleonly@example.com",
      name: "Google Only User",
      emailVerified: true,
    });

    await assert.rejects(
      async () => {
        await service.login({
          email: "googleonly@example.com",
          password: "any_password",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthUnauthorizedError);
        assert.equal(err.message, "Invalid email or password");
        return true;
      }
    );
  });

  describe("OAuth State CSRF Protection", () => {
    it("should generate and verify valid cryptographic state parameter", () => {
      const state = generateOAuthState("/leagues/join/abc");
      assert.ok(state);

      const check = verifyOAuthState(state);
      assert.equal(check.valid, true);
      assert.equal(check.returnTo, "/leagues/join/abc");
    });

    it("should reject tampered state parameter", () => {
      const state = generateOAuthState();
      const tampered = state.slice(0, -4) + "XXXX";

      const check = verifyOAuthState(tampered);
      assert.equal(check.valid, false);
    });

    it("should reject malformed state strings", () => {
      assert.equal(verifyOAuthState("").valid, false);
      assert.equal(verifyOAuthState("invalid-state").valid, false);
      assert.equal(verifyOAuthState("part1.part2.part3").valid, false);
    });
  });
});
