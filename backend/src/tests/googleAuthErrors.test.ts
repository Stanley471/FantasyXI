import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import request, { type Response } from "supertest";
import type { OAuth2Client } from "google-auth-library";
import { generateOAuthState, OAUTH_NONCE_COOKIE } from "../config/google.js";

const FRONTEND_URL = "http://frontend.test";
const CALLBACK = "/api/v1/auth/google/callback";
const NONCE = "oauth-error-test-browser-nonce";

function passwordUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "password-user",
    email: "manager@example.com",
    username: "manager",
    name: "Existing manager",
    passwordHash: "existing-password-hash-must-not-change",
    googleId: null as string | null,
    role: "USER",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function userStore() {
  const users: ReturnType<typeof passwordUser>[] = [];
  return {
    users,
    user: {
      findUnique: mock.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const [field, value] = Object.entries(where)[0];
        return users.find((user) => user[field as keyof typeof user] === value) ?? null;
      }),
      create: mock.fn(async () => {
        throw new Error("An error callback must not create an account");
      }),
      update: mock.fn(async () => {
        throw new Error("An error callback must not update an account");
      }),
    },
  };
}

function googleClient() {
  return {
    getToken: mock.fn(async (_code: string) => ({ tokens: { id_token: "mock-id-token" } })),
    verifyIdToken: mock.fn(async (_options: unknown) => ({
      getPayload: () => ({
        sub: "google-new",
        email: "manager@example.com",
        email_verified: true,
      }),
    })),
  };
}

/** Exercise the real router, callback, state verifier and auth services.
 * Only Google's client and persistence are replaced; no Google or database
 * connection is needed, including for the expired-state cases.
 */
describe("Google OAuth callback error states (integration)", { concurrency: false }, () => {
  let app: express.Express;
  let db: ReturnType<typeof userStore>;
  let client: ReturnType<typeof googleClient>;
  let restoreServices: () => void;
  const environment = {
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    FRONTEND_URL,
    REDIS_ENABLED: "false",
  };
  const previousEnvironment = new Map<string, string | undefined>();

  before(async () => {
    for (const [key, value] of Object.entries(environment)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }

    const { default: authRoutes } = await import("../routes/auth.routes.js");
    const { authService } = await import("../services/auth/authService.js");
    const { GoogleAuthService, googleAuthService } = await import("../services/auth/googleAuthService.js");

    const originalDb = Object.getOwnPropertyDescriptor(authService, "db")!;
    Object.defineProperty(authService, "db", { configurable: true, get: () => db });
    const verifyCode = mock.method(googleAuthService, "verifyAuthorizationCode", (code: string) => {
      const service = new GoogleAuthService(client as unknown as OAuth2Client);
      return service.verifyAuthorizationCode(code);
    });
    restoreServices = () => {
      verifyCode.mock.restore();
      Object.defineProperty(authService, "db", originalDb);
    };

    app = express();
    app.use("/api/v1/auth", authRoutes);
  });

  after(() => {
    restoreServices?.();
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    db = userStore();
    client = googleClient();
  });

  function state() {
    return generateOAuthState({ nonce: NONCE, returnTo: "/leagues" });
  }

  function callback(query: Record<string, unknown>, nonce: string | null = NONCE) {
    const pending = request(app).get(CALLBACK).query(query);
    return nonce === null ? pending : pending.set("Cookie", `${OAUTH_NONCE_COOKIE}=${nonce}`);
  }

  function assertRedirect(response: Response, error: string, linking = false) {
    assert.equal(response.status, 302);
    const location = new URL(response.headers.location);
    assert.equal(location.origin, FRONTEND_URL);
    assert.equal(location.pathname, linking ? "/profile" : "/login");
    assert.equal(location.search, `?${linking ? "linkError" : "error"}=${error}`);
    assert.equal(location.hash, "", "failed callbacks must not issue an access token");
    const cookies = response.headers["set-cookie"];
    assert.ok(Array.isArray(cookies) && cookies.some((cookie) =>
      cookie.startsWith(`${OAUTH_NONCE_COOKIE}=;`) && /Expires=Thu, 01 Jan 1970/.test(cookie)
    ), "clear the browser nonce even when the callback fails");
  }

  function assertNoWrites() {
    assert.equal(db.user.create.mock.callCount(), 0);
    assert.equal(db.user.update.mock.callCount(), 0);
  }

  function assertRejectedBeforeGoogle() {
    assert.equal(client.getToken.mock.callCount(), 0);
    assert.equal(client.verifyIdToken.mock.callCount(), 0);
    assert.equal(db.user.findUnique.mock.callCount(), 0);
    assertNoWrites();
  }

  for (const missing of ["both", "code", "state", "empty code", "empty state"]) {
    it(`redirects safely when the callback is missing ${missing}`, async () => {
      const query: Record<string, unknown> = { code: "auth-code", state: state() };
      if (missing === "both" || missing === "code") delete query.code;
      if (missing === "both" || missing === "state") delete query.state;
      if (missing === "empty code") query.code = "";
      if (missing === "empty state") query.state = "";

      assertRedirect(await callback(query), "oauth_state_invalid");
      assertRejectedBeforeGoogle();
    });
  }

  it("rejects a tampered signed state before exchanging a code", async () => {
    const signed = state();
    const [payload, signature] = signed.split(".");
    const tampered = `${payload}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    assertRedirect(await callback({ code: "auth-code", state: tampered }), "oauth_state_invalid");
    assertRejectedBeforeGoogle();
  });

  it("rejects an expired but correctly signed state without waiting for a timeout", async () => {
    const issuedAt = Date.now() - 11 * 60 * 1000;
    const clock = mock.method(Date, "now", () => issuedAt);
    let expired: string;
    try {
      expired = state();
    } finally {
      clock.mock.restore();
    }

    assertRedirect(await callback({ code: "auth-code", state: expired }), "oauth_state_invalid");
    assertRejectedBeforeGoogle();
  });

  for (const nonce of [null, "a-different-browser"]) {
    it(`rejects a valid state with a ${nonce === null ? "missing" : "mismatched"} nonce cookie`, async () => {
      assertRedirect(await callback({ code: "auth-code", state: state() }, nonce), "oauth_state_invalid");
      assertRejectedBeforeGoogle();
    });
  }

  it("returns a 400 JSON error for invalid state when JSON is requested", async () => {
    const response = await callback({ code: "auth-code", state: "forged.state" })
      .set("Accept", "application/json");
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.code, "oauth_state_invalid");
    assert.match(response.body.message, /invalid or expired/i);
    assert.equal(response.headers.location, undefined);
    assertRejectedBeforeGoogle();
  });

  it("handles cancellation without exposing Google's error description", async () => {
    const response = await callback({
      error: "access_denied",
      error_description: "private provider details",
      state: state(),
    });
    assertRedirect(response, "google_denied");
    assertRejectedBeforeGoogle();
  });

  it("handles invalid_grant from the token endpoint without exposing provider details", async () => {
    client.getToken.mock.mockImplementation(async () => {
      throw Object.assign(new Error("private token endpoint failure"), {
        response: { data: { error: "invalid_grant" } },
      });
    });
    assertRedirect(await callback({ code: "expired-code", state: state() }), "google_auth_failed");
    assert.equal(client.getToken.mock.callCount(), 1);
    assert.equal(client.verifyIdToken.mock.callCount(), 0);
    assert.equal(db.user.findUnique.mock.callCount(), 0);
    assertNoWrites();
  });

  it("rejects an invalid ID token without accessing user records", async () => {
    client.verifyIdToken.mock.mockImplementation(async () => {
      throw new Error("Token used too late");
    });
    assertRedirect(await callback({ code: "auth-code", state: state() }), "google_auth_failed");
    assert.equal(client.verifyIdToken.mock.callCount(), 1);
    assert.equal(db.user.findUnique.mock.callCount(), 0);
    assertNoWrites();
  });

  it("does not link an unverified Google email to an existing password account", async () => {
    const existing = passwordUser();
    db.users.push(existing);
    const snapshot = structuredClone(existing);
    client.verifyIdToken.mock.mockImplementation(async () => ({
      getPayload: () => ({ sub: "google-new", email: existing.email, email_verified: false }),
    }));

    assertRedirect(await callback({ code: "auth-code", state: state() }), "google_email_unverified");
    assert.deepEqual(db.users, [snapshot]);
    assert.equal(db.user.findUnique.mock.callCount(), 0);
    assertNoWrites();
  });

  it("preserves credentials when an email belongs to a different Google account", async () => {
    const existing = passwordUser({ googleId: "google-original" });
    db.users.push(existing);
    const snapshot = structuredClone(existing);

    assertRedirect(await callback({ code: "auth-code", state: state() }), "google_account_conflict");
    assert.equal(client.getToken.mock.callCount(), 1);
    assert.deepEqual(db.users, [snapshot]);
    assertNoWrites();
  });

  it("does not attach a Google identity already owned by another account", async () => {
    db.users.push(passwordUser(), passwordUser({
      id: "google-owner",
      email: "another@example.com",
      username: "another-manager",
      googleId: "google-new",
    }));
    const snapshot = structuredClone(db.users);
    const linkingState = generateOAuthState({ nonce: NONCE, intent: "link", userId: "password-user" });

    assertRedirect(await callback({ code: "auth-code", state: linkingState }), "google_account_conflict", true);
    assert.deepEqual(db.users, snapshot);
    assertNoWrites();
  });

  it("still signs in with a valid state and verified existing Google identity", async () => {
    db.users.push(passwordUser({ googleId: "google-new" }));
    const response = await callback({ code: "auth-code", state: state() });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.location);
    assert.equal(location.origin, FRONTEND_URL);
    assert.equal(location.pathname, "/auth/callback");
    assert.equal(location.search, "");
    assert.ok(new URLSearchParams(location.hash.slice(1)).get("token"));
    assert.equal(client.getToken.mock.callCount(), 1);
    assert.equal(client.verifyIdToken.mock.callCount(), 1);
    assertNoWrites();
  });
});
