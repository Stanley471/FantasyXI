import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import {
  generateOAuthNonce,
  generateOAuthState,
  generateLinkTicket,
  verifyOAuthState,
  verifyLinkTicket,
  OAUTH_NONCE_COOKIE,
  OAuthIntent,
} from "../config/google.js";
import { getJwtSecret, verifyAccessToken } from "../config/jwt.js";
import {
  AuthService,
  AuthValidationError,
  AuthConflictError,
  AuthUnauthorizedError,
  toSafeUser,
} from "../services/auth/authService.js";
import type { VerifiedGoogleUser } from "../services/auth/googleAuthService.js";

/**
 * Dedicated integration test suite covering Google OAuth callback error states:
 * - Invalid or expired state parameters (CSRF protection rejection)
 * - Mismatched or missing browser nonces
 * - User cancellation / access_denied from Google consent screen
 * - Missing query parameters (code, state)
 * - Provider token exchange / ID token verification failures (invalid_grant, etc.)
 * - Email collision when email already exists with password auth and unverified status
 * - Account linking collisions ensuring existing credentials are never overwritten without verification
 * - Link ticket expiration and forgery
 * - JSON and redirect error response assertions
 */

process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.FRONTEND_URL = "http://frontend.test";
process.env.AUTH_RATE_LIMIT_MAX = "10000";
process.env.REDIS_ENABLED = "false";

type StoredUser = {
  id: string;
  email: string;
  passwordHash: string | null;
  username: string;
  name: string | null;
  googleId: string | null;
  role: "USER";
  referrerId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function createUserStore(initialUsers: StoredUser[] = []) {
  const users: StoredUser[] = [...initialUsers];
  const unique = (field: "email" | "username" | "googleId", value: unknown, id?: string) => {
    if (value && users.some((u) => u[field] === value && u.id !== id)) {
      throw Object.assign(new Error(`Unique constraint failed on ${field}`), { code: "P2002" });
    }
  };
  return {
    users,
    user: {
      findUnique: async ({ where }: any) => {
        const [field, value] = Object.entries(where)[0] as [keyof StoredUser, unknown];
        return users.find((u) => value !== undefined && u[field] === value) ?? null;
      },
      create: async ({ data }: any) => {
        unique("email", data.email);
        unique("username", data.username);
        unique("googleId", data.googleId);
        const user: StoredUser = {
          id: `usr_${users.length + 1}`,
          passwordHash: null,
          name: null,
          googleId: null,
          role: "USER",
          referrerId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        users.push(user);
        return { ...user };
      },
      update: async ({ where, data }: any) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error("User not found");
        unique("googleId", data.googleId, user.id);
        Object.assign(user, data, { updatedAt: new Date() });
        return { ...user };
      },
    },
  };
}

/** Signs arbitrary OAuth state payloads for testing expired, future, or custom states. */
function createSignedOAuthState(payload: {
  nonce: string;
  timestamp: number;
  returnTo?: string;
  intent?: OAuthIntent;
  userId?: string;
}): string {
  const jsonPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getJwtSecret())
    .update(jsonPayload)
    .digest("base64url");
  return `${jsonPayload}.${signature}`;
}

describe("Google OAuth Callback Error States (Integration)", () => {
  let server: Server;
  let base: string;
  let store: ReturnType<typeof createUserStore>;
  let mockVerifyHandler: ((code: string) => Promise<VerifiedGoogleUser>) | null = null;
  let nextIdentity: VerifiedGoogleUser;

  before(async () => {
    const { default: authRoutes } = await import("../routes/auth.routes.js");
    const { googleAuthService } = await import("../services/auth/googleAuthService.js");
    const { authService } = await import("../services/auth/authService.js");

    googleAuthService.getAuthorizationUrl = (state: string) =>
      `https://accounts.google.test/o/oauth2/auth?state=${encodeURIComponent(state)}`;
    googleAuthService.verifyAuthorizationCode = async (code: string) => {
      if (mockVerifyHandler) {
        return mockVerifyHandler(code);
      }
      return { ...nextIdentity };
    };

    Object.defineProperty(authService, "db", { get: () => store, configurable: true });

    const app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRoutes);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    const { closeRedisClient } = await import("../config/redis.js");
    await closeRedisClient();
  });

  beforeEach(() => {
    store = createUserStore();
    mockVerifyHandler = null;
    nextIdentity = {
      googleId: "google-valid-user-1",
      email: "valid.user@example.com",
      name: "Valid User",
      picture: null,
      emailVerified: true,
    };
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", headers });

  const send = (method: string, path: string, body?: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  /** Initiates Google OAuth redirect to receive a valid nonce cookie and signed state. */
  async function beginAtGoogle(path: string = "/api/v1/auth/google") {
    const res = await get(path);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("fxi_oauth_nonce="));
    assert.ok(cookie, "fxi_oauth_nonce cookie must be set");
    return {
      state: location.searchParams.get("state")!,
      cookieHeader: cookie!.split(";")[0],
      nonce: cookie!.split(";")[0].replace("fxi_oauth_nonce=", ""),
    };
  }

  describe("Missing or Malformed Query Parameters", () => {
    it("redirects to /login with error=oauth_state_invalid when 'code' parameter is missing", async () => {
      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.origin, "http://frontend.test");
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("returns 400 Bad Request with code=oauth_state_invalid when 'code' is missing and client requests JSON", async () => {
      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader, Accept: "application/json" }
      );
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "oauth_state_invalid");
      assert.match(data.message, /missing authorization code or state parameter/i);
    });

    it("redirects to /login with error=oauth_state_invalid when 'state' parameter is missing", async () => {
      const { cookieHeader } = await beginAtGoogle();
      const res = await get(`/api/v1/auth/google/callback?code=valid-auth-code`, {
        Cookie: cookieHeader,
      });
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("returns 400 Bad Request when 'state' parameter is missing and client requests JSON", async () => {
      const { cookieHeader } = await beginAtGoogle();
      const res = await get(`/api/v1/auth/google/callback?code=valid-auth-code`, {
        Cookie: cookieHeader,
        Accept: "application/json",
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "oauth_state_invalid");
    });

    it("redirects to /login with error=oauth_state_invalid when both 'code' and 'state' are missing", async () => {
      const res = await get("/api/v1/auth/google/callback");
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("returns 400 Bad Request when both parameters are empty strings", async () => {
      const res = await get("/api/v1/auth/google/callback?code=&state=", {
        Accept: "application/json",
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "oauth_state_invalid");
    });

    it("clears the single-use nonce cookie when parameters are missing", async () => {
      const { cookieHeader } = await beginAtGoogle();
      const res = await get("/api/v1/auth/google/callback", { Cookie: cookieHeader });
      const clearedCookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith("fxi_oauth_nonce="));
      assert.ok(clearedCookie, "fxi_oauth_nonce cookie must be cleared");
      assert.match(clearedCookie!, /Expires=Thu, 01 Jan 1970/i);
    });
  });

  describe("Invalid, Expired, or Mismatched State Parameter (CSRF Protection)", () => {
    it("redirects to /login with error=oauth_state_invalid when state is expired (> 10 minutes)", async () => {
      const nonce = generateOAuthNonce();
      const expiredTimestamp = Date.now() - 15 * 60 * 1000; // 15 minutes ago
      const expiredState = createSignedOAuthState({
        nonce,
        timestamp: expiredTimestamp,
        returnTo: "/",
        intent: "login",
      });

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(expiredState)}`,
        { Cookie: `fxi_oauth_nonce=${nonce}` }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.ok(
        ["oauth_state_invalid", "state_mismatch"].includes(landing.searchParams.get("error")!),
        "Error query param should indicate invalid/mismatched state"
      );
      assert.equal(store.users.length, 0);
    });

    it("returns 400 Bad Request for expired state when client requests JSON", async () => {
      const nonce = generateOAuthNonce();
      const expiredTimestamp = Date.now() - 11 * 60 * 1000; // 11 minutes ago
      const expiredState = createSignedOAuthState({
        nonce,
        timestamp: expiredTimestamp,
        returnTo: "/",
        intent: "login",
      });

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(expiredState)}`,
        { Cookie: `fxi_oauth_nonce=${nonce}`, Accept: "application/json" }
      );
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(
        ["oauth_state_invalid", "state_mismatch"].includes(data.code),
        "JSON error code should indicate invalid/mismatched state"
      );
      assert.match(data.message, /invalid or expired oauth state parameter/i);
    });

    it("rejects state token issued with timestamp in future beyond clock skew", async () => {
      const nonce = generateOAuthNonce();
      const futureTimestamp = Date.now() + 5 * 60 * 1000; // 5 minutes in future
      const futureState = createSignedOAuthState({
        nonce,
        timestamp: futureTimestamp,
        returnTo: "/",
        intent: "login",
      });

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(futureState)}`,
        { Cookie: `fxi_oauth_nonce=${nonce}` }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("rejects state parameter when browser nonce cookie is mismatched (login CSRF)", async () => {
      const stateNonce = generateOAuthNonce();
      const cookieNonce = generateOAuthNonce();
      assert.notEqual(stateNonce, cookieNonce);

      const state = createSignedOAuthState({
        nonce: stateNonce,
        timestamp: Date.now(),
        returnTo: "/",
        intent: "login",
      });

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        { Cookie: `fxi_oauth_nonce=${cookieNonce}` }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.ok(
        ["oauth_state_invalid", "state_mismatch"].includes(landing.searchParams.get("error")!)
      );
      assert.equal(store.users.length, 0);
    });

    it("returns 400 Bad Request for mismatched nonce when client requests JSON", async () => {
      const stateNonce = generateOAuthNonce();
      const cookieNonce = generateOAuthNonce();

      const state = createSignedOAuthState({
        nonce: stateNonce,
        timestamp: Date.now(),
        returnTo: "/",
        intent: "login",
      });

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        { Cookie: `fxi_oauth_nonce=${cookieNonce}`, Accept: "application/json" }
      );
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "oauth_state_invalid");
    });

    it("rejects state parameter when browser nonce cookie is completely omitted", async () => {
      const { state } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(state)}`
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("rejects state parameter with tampered signature", async () => {
      const { state, cookieHeader } = await beginAtGoogle();
      const tamperedState = `${state.slice(0, -5)}XXXXX`;

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(tamperedState)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("rejects state parameter with tampered payload", async () => {
      const nonce = generateOAuthNonce();
      const legitState = createSignedOAuthState({
        nonce,
        timestamp: Date.now(),
        returnTo: "/safe",
        intent: "login",
      });
      const [, signature] = legitState.split(".");

      // Tamper the payload with different returnTo or nonce
      const tamperedPayload = Buffer.from(
        JSON.stringify({ nonce, timestamp: Date.now(), returnTo: "/evil", intent: "login" })
      ).toString("base64url");
      const forgedState = `${tamperedPayload}.${signature}`;

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(forgedState)}`,
        { Cookie: `fxi_oauth_nonce=${nonce}` }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("rejects completely malformed state strings", async () => {
      for (const badState of ["garbage-token", "not.enough.parts.here", "a.b", ""]) {
        const res = await get(
          `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(badState)}`
        );
        assert.equal(res.status, 302);
        const landing = new URL(res.headers.get("location")!);
        assert.equal(landing.pathname, "/login");
        assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
      }
    });

    it("prevents state replay by single-use cookie clearing", async () => {
      const { state, cookieHeader } = await beginAtGoogle();

      // First callback consumes and clears cookie
      const firstRes = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(firstRes.status, 302);

      // Subsequent attempt without the cookie fails
      const replayRes = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`
      );
      assert.equal(replayRes.status, 302);
      const replayLanding = new URL(replayRes.headers.get("location")!);
      assert.equal(replayLanding.pathname, "/login");
      assert.equal(replayLanding.searchParams.get("error"), "oauth_state_invalid");
    });

    it("rejects an account linking state that lacks a userId", async () => {
      const nonce = generateOAuthNonce();
      const stateWithoutUser = createSignedOAuthState({
        nonce,
        timestamp: Date.now(),
        intent: "link",
        // userId omitted
      });

      const res = await get(
        `/api/v1/auth/google/callback?code=valid-code&state=${encodeURIComponent(stateWithoutUser)}`,
        { Cookie: `fxi_oauth_nonce=${nonce}` }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });
  });

  describe("User Cancellation & Provider Error Responses from Google Consent Screen", () => {
    it("redirects to /login with error=google_denied when Google returns error=access_denied", async () => {
      const res = await get("/api/v1/auth/google/callback?error=access_denied");
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.origin, "http://frontend.test");
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "google_denied");
    });

    it("returns 400 Bad Request with code=google_denied when error=access_denied and client requests JSON", async () => {
      const res = await get("/api/v1/auth/google/callback?error=access_denied", {
        Accept: "application/json",
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "google_denied");
      assert.match(data.message, /google sign-in was cancelled or denied/i);
    });

    it("handles various Google OAuth error codes gracefully (e.g. interaction_required, unauthorized_client)", async () => {
      for (const errCode of ["interaction_required", "unauthorized_client", "server_error"]) {
        const res = await get(`/api/v1/auth/google/callback?error=${errCode}`);
        assert.equal(res.status, 302);
        const landing = new URL(res.headers.get("location")!);
        assert.equal(landing.pathname, "/login");
        assert.equal(landing.searchParams.get("error"), "google_denied");
      }
    });

    it("redirects to /profile with linkError=google_denied when consent is denied during linking flow", async () => {
      const nonce = generateOAuthNonce();
      const linkState = createSignedOAuthState({
        nonce,
        timestamp: Date.now(),
        intent: "link",
        userId: "usr_existing_1",
        returnTo: "/profile",
      });

      const res = await get(
        `/api/v1/auth/google/callback?error=access_denied&state=${encodeURIComponent(linkState)}`,
        { Cookie: `fxi_oauth_nonce=${nonce}` }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linkError"), "google_denied");
    });

    it("clears the nonce cookie when Google returns an error response", async () => {
      const { cookieHeader } = await beginAtGoogle();
      const res = await get("/api/v1/auth/google/callback?error=access_denied", {
        Cookie: cookieHeader,
      });
      const clearedCookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith("fxi_oauth_nonce="));
      assert.ok(clearedCookie);
      assert.match(clearedCookie!, /Expires=Thu, 01 Jan 1970/i);
    });
  });

  describe("Provider Token Exchange & Verification Failures", () => {
    it("redirects to /login with error=google_auth_failed on token exchange failure (e.g. invalid_grant)", async () => {
      mockVerifyHandler = async () => {
        throw new AuthUnauthorizedError("Failed to verify Google authentication");
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=bad-grant-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "google_auth_failed");
    });

    it("returns 401 Unauthorized with code=google_auth_failed when token exchange fails and client requests JSON", async () => {
      mockVerifyHandler = async () => {
        throw new AuthUnauthorizedError("Failed to verify Google authentication");
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=bad-grant-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader, Accept: "application/json" }
      );
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "google_auth_failed");
    });

    it("redirects with error=google_auth_failed when Google does not return an ID token", async () => {
      mockVerifyHandler = async () => {
        throw new AuthUnauthorizedError("Google did not return an OpenID Connect ID token");
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=code-no-id-token&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "google_auth_failed");
    });

    it("redirects with error=google_auth_failed when Google ID token has incomplete payload", async () => {
      mockVerifyHandler = async () => {
        throw new AuthUnauthorizedError("Invalid or incomplete Google ID token payload");
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=code-bad-payload&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "google_auth_failed");
    });
  });

  describe("Account Linking Collisions & Existing Credentials Preservation", () => {
    it("preserves existing password auth credentials when Google email matches but emailVerified is false", async () => {
      // 1. Existing user registers with password authentication
      const regRes = await send("POST", "/api/v1/auth/register", {
        email: "victim@example.com",
        password: "SuperSecretPassword123!",
      });
      assert.equal(regRes.status, 201);
      const existingUser = store.users.find((u) => u.email === "victim@example.com");
      assert.ok(existingUser, "Existing user must exist in database");
      assert.ok(existingUser.passwordHash, "Existing user must have password hash");
      assert.equal(existingUser.googleId, null, "Existing user googleId should initially be null");
      const originalPasswordHash = existingUser.passwordHash;

      // 2. An unverified Google OAuth callback arrives for the same email
      nextIdentity = {
        googleId: "google-attacker-sub-999",
        email: "victim@example.com",
        name: "Attacker Impostor",
        picture: null,
        emailVerified: false, // NOT verified by Google!
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );

      // 3. Assert graceful redirect to /login with error=google_email_unverified
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.origin, "http://frontend.test");
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "google_email_unverified");

      // 4. Assert existing user credentials in database were NOT overwritten or modified
      const userAfterAttempt = store.users.find((u) => u.email === "victim@example.com")!;
      assert.equal(
        userAfterAttempt.passwordHash,
        originalPasswordHash,
        "Password hash must remain intact"
      );
      assert.equal(
        userAfterAttempt.googleId,
        null,
        "googleId must NOT be linked without verification"
      );
      assert.equal(store.users.length, 1, "No duplicate user record should be created");

      // 5. Assert the legitimate user can still log in successfully with their original password
      const loginRes = await send("POST", "/api/v1/auth/login", {
        email: "victim@example.com",
        password: "SuperSecretPassword123!",
      });
      assert.equal(loginRes.status, 200, "Original user must still be able to sign in with password");
    });

    it("returns 400 Bad Request with code=google_email_unverified when unverified email hits JSON endpoint", async () => {
      // Existing user with password
      await send("POST", "/api/v1/auth/register", {
        email: "unverified.json@example.com",
        password: "MyValidPassword123!",
      });

      nextIdentity = {
        googleId: "google-sub-unverified",
        email: "unverified.json@example.com",
        emailVerified: false,
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader, Accept: "application/json" }
      );
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "google_email_unverified");
      assert.match(data.message, /not verified/i);
    });

    it("rejects sign-in when email is already linked to a different Google account (account conflict)", async () => {
      // User registered and already linked to Google ID "google-legit-owner"
      store.users.push({
        id: "usr_linked_1",
        email: "already.linked@example.com",
        username: "alreadylinked",
        name: "Already Linked",
        googleId: "google-legit-owner",
        passwordHash: null,
        role: "USER",
        referrerId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Different Google account tries to log in with the same email
      nextIdentity = {
        googleId: "google-impostor-id",
        email: "already.linked@example.com",
        name: "Impostor",
        emailVerified: true,
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "google_account_conflict");

      // Verify the existing user record's googleId was not overwritten
      const existing = store.users.find((u) => u.email === "already.linked@example.com")!;
      assert.equal(existing.googleId, "google-legit-owner");
    });

    it("returns 409 Conflict with code=google_account_conflict when account conflict hits JSON endpoint", async () => {
      store.users.push({
        id: "usr_linked_2",
        email: "conflict.json@example.com",
        username: "conflictjson",
        name: "Conflict JSON",
        googleId: "google-owner-1",
        passwordHash: null,
        role: "USER",
        referrerId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      nextIdentity = {
        googleId: "google-owner-2",
        email: "conflict.json@example.com",
        emailVerified: true,
      };

      const { state, cookieHeader } = await beginAtGoogle();
      const res = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader, Accept: "application/json" }
      );
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.code, "google_account_conflict");
    });

    it("refuses to link a Google account that is already linked to another manager", async () => {
      // User A (signed in)
      const regA = await send("POST", "/api/v1/auth/register", {
        email: "usera@example.com",
        password: "UserAPassword123!",
      });
      const tokenA = (await regA.json()).data.token;

      // User B already linked to Google ID "google-b-unique"
      store.users.push({
        id: "usr_userB",
        email: "userb@example.com",
        username: "userb",
        name: "User B",
        googleId: "google-b-unique",
        passwordHash: "hash-b",
        role: "USER",
        referrerId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // User A attempts to link the Google ID owned by User B
      nextIdentity = {
        googleId: "google-b-unique",
        email: "different.google@example.com",
        name: "User B Google",
        picture: null,
        emailVerified: true,
      };

      const ticketRes = await send("POST", "/api/v1/auth/google/link", undefined, tokenA);
      assert.equal(ticketRes.status, 200);
      const { url } = (await ticketRes.json()).data;
      const { state, cookieHeader } = await beginAtGoogle(url);

      const callbackRes = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(callbackRes.status, 302);
      const landing = new URL(callbackRes.headers.get("location")!);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linkError"), "google_account_conflict");

      // Verify User A was not linked
      const userA = store.users.find((u) => u.email === "usera@example.com")!;
      assert.equal(userA.googleId, null);
      // Verify User B still owns the Google ID
      const userB = store.users.find((u) => u.email === "userb@example.com")!;
      assert.equal(userB.googleId, "google-b-unique");
    });

    it("refuses to link Google account when Google email is unverified during link flow", async () => {
      const regRes = await send("POST", "/api/v1/auth/register", {
        email: "linker@example.com",
        password: "LinkerPassword123!",
      });
      const token = (await regRes.json()).data.token;

      nextIdentity = {
        googleId: "google-unverified-link",
        email: "unverified.link@example.com",
        emailVerified: false,
      };

      const ticketRes = await send("POST", "/api/v1/auth/google/link", undefined, token);
      const { url } = (await ticketRes.json()).data;
      const { state, cookieHeader } = await beginAtGoogle(url);

      const callbackRes = await get(
        `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
        { Cookie: cookieHeader }
      );
      assert.equal(callbackRes.status, 302);
      const landing = new URL(callbackRes.headers.get("location")!);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linkError"), "google_email_unverified");

      const linker = store.users.find((u) => u.email === "linker@example.com")!;
      assert.equal(linker.googleId, null);
    });
  });

  describe("Link Ticket Validation & Account Unlink Safeguards", () => {
    it("redirects to /profile with linkError=link_ticket_invalid when link start ticket is missing", async () => {
      const res = await get("/api/v1/auth/google/link/start");
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linkError"), "link_ticket_invalid");
    });

    it("redirects to /profile with linkError=link_ticket_invalid when ticket is forged or tampered", async () => {
      const res = await get("/api/v1/auth/google/link/start?ticket=forged.invalid.ticket");
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linkError"), "link_ticket_invalid");
    });

    it("redirects to /profile with linkError=link_ticket_invalid when ticket is expired (> 2 minutes)", async () => {
      // Craft expired link ticket (2 minutes TTL)
      const expiredTimestamp = Date.now() - 5 * 60 * 1000;
      const payload = Buffer.from(
        JSON.stringify({ purpose: "google-link", userId: "usr_1", timestamp: expiredTimestamp })
      ).toString("base64url");
      const signature = crypto
        .createHmac("sha256", getJwtSecret())
        .update(`google-link:${payload}`)
        .digest("base64url");
      const expiredTicket = `${payload}.${signature}`;

      const res = await get(
        `/api/v1/auth/google/link/start?ticket=${encodeURIComponent(expiredTicket)}`
      );
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linkError"), "link_ticket_invalid");
    });

    it("returns 401 Unauthorized when creating a link ticket without Bearer token", async () => {
      const res = await send("POST", "/api/v1/auth/google/link");
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /authentication required/i);
    });

    it("prevents unlinking Google when user has no password configured (409 Conflict)", async () => {
      // Create user with Google only (passwordHash: null)
      store.users.push({
        id: "usr_google_only",
        email: "googleonly@example.com",
        username: "googleonly",
        name: "Google Only User",
        googleId: "google-only-id",
        passwordHash: null,
        role: "USER",
        referrerId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const { signAccessToken } = await import("../config/jwt.js");
      const token = signAccessToken({
        userId: "usr_google_only",
        email: "googleonly@example.com",
        username: "googleonly",
        role: "USER",
      });

      const unlinkRes = await send("DELETE", "/api/v1/auth/google/link", undefined, token);
      assert.equal(unlinkRes.status, 409);
      const data = await unlinkRes.json();
      assert.equal(data.success, false);
      assert.match(data.message, /password/i);

      // Verify Google is still linked
      const user = store.users.find((u) => u.id === "usr_google_only")!;
      assert.equal(user.googleId, "google-only-id");
    });
  });
});
