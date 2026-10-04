import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import {
  generateLinkTicket,
  generateOAuthState,
  sanitizeReturnTo,
  verifyLinkTicket,
  verifyOAuthState,
} from "../config/google.js";
import { verifyAccessToken } from "../config/jwt.js";

/**
 * Integration tests for the Google OAuth 2.0 flows (sign-in and account
 * linking) through the real Express routes. Only Google's token endpoint is
 * stubbed: the test decides which verified identity the authorization code
 * resolves to. Users live in an in-memory store.
 */

process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.FRONTEND_URL = "http://frontend.test";
// The auth rate limiter reads this when the routes module is first imported
process.env.AUTH_RATE_LIMIT_MAX = "1000";

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

function createUserStore() {
  const users: StoredUser[] = [];
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

describe("Google OAuth state, return paths and link tickets", () => {
  it("binds the state to the browser nonce", () => {
    const state = generateOAuthState({ nonce: "nonce-a" });
    assert.equal(verifyOAuthState(state, { browserNonce: "nonce-a" }).valid, true);
    assert.equal(verifyOAuthState(state, { browserNonce: "nonce-b" }).valid, false);
    assert.equal(verifyOAuthState(state, { browserNonce: null }).valid, false);
  });

  it("carries the link intent and the account to link", () => {
    const state = generateOAuthState({ intent: "link", userId: "usr_9", nonce: "n" });
    const check = verifyOAuthState(state, { browserNonce: "n" });
    assert.equal(check.intent, "link");
    assert.equal(check.userId, "usr_9");
    assert.throws(() => generateOAuthState({ intent: "link" }));
  });

  it("only allows same-site relative return paths", () => {
    assert.equal(sanitizeReturnTo("/leagues/abc?tab=1"), "/leagues/abc?tab=1");
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "", 42]) {
      assert.equal(sanitizeReturnTo(bad), "/", String(bad));
    }
    const state = generateOAuthState("https://evil.test/steal");
    assert.equal(verifyOAuthState(state).returnTo, "/");
  });

  it("accepts only genuine link tickets", () => {
    const ticket = generateLinkTicket("usr_1");
    assert.equal(verifyLinkTicket(ticket), "usr_1");
    assert.equal(verifyLinkTicket(ticket.slice(0, -3) + "abc"), null);
    assert.equal(verifyLinkTicket(generateOAuthState({ nonce: "n" })), null, "a state is not a ticket");
    assert.equal(verifyLinkTicket(undefined), null);
  });
});

describe("Google OAuth flows (integration)", () => {
  let server: Server;
  let base: string;
  let store: ReturnType<typeof createUserStore>;
  /** The Google identity the next authorization code resolves to. */
  let nextIdentity: { googleId: string; email: string; name?: string; emailVerified: boolean };

  before(async () => {
    const { default: authRoutes } = await import("../routes/auth.routes.js");
    const { googleAuthService } = await import("../services/auth/googleAuthService.js");
    const { authService } = await import("../services/auth/authService.js");

    googleAuthService.getAuthorizationUrl = (state: string) =>
      `https://accounts.google.test/o/oauth2/auth?state=${encodeURIComponent(state)}`;
    googleAuthService.verifyAuthorizationCode = async (code: string) => {
      assert.equal(code, "auth-code");
      return { ...nextIdentity, picture: null };
    };
    Object.defineProperty(authService, "db", { get: () => store });

    const app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRoutes);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    store = createUserStore();
    nextIdentity = { googleId: "google-1", email: "manager@gmail.com", name: "Manager", emailVerified: true };
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

  /** Follows our redirect to Google and returns the state plus the nonce cookie. */
  async function beginAtGoogle(path: string) {
    const res = await get(path);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.host, "accounts.google.test");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("fxi_oauth_nonce="));
    assert.ok(cookie, "nonce cookie is set");
    assert.match(cookie!, /HttpOnly/i);
    assert.match(cookie!, /SameSite=Lax/i);
    return { state: location.searchParams.get("state")!, cookie: cookie!.split(";")[0] };
  }

  async function completeAtCallback(state: string, cookie?: string) {
    const res = await get(
      `/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      cookie ? { Cookie: cookie } : {}
    );
    assert.equal(res.status, 302);
    return new URL(res.headers.get("location")!);
  }

  async function signInWithGoogle(returnTo?: string) {
    const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
    const { state, cookie } = await beginAtGoogle(`/api/v1/auth/google${query}`);
    return completeAtCallback(state, cookie);
  }

  async function me(token: string) {
    const res = await send("GET", "/api/v1/auth/me", undefined, token);
    return (await res.json()).data;
  }

  describe("sign-in", () => {
    it("creates an account and hands the JWT to the frontend in the URL fragment", async () => {
      const landing = await signInWithGoogle("/leagues");

      assert.equal(landing.origin, "http://frontend.test");
      assert.equal(landing.pathname, "/auth/callback");
      assert.equal(landing.search, "", "the token is never sent in the query string");
      const fragment = new URLSearchParams(landing.hash.slice(1));
      assert.equal(fragment.get("returnTo"), "/leagues");

      const payload = verifyAccessToken(fragment.get("token")!);
      assert.equal(store.users.length, 1);
      assert.equal(payload.userId, store.users[0].id);
      assert.deepEqual((await me(fragment.get("token")!)).authProviders, { password: false, google: true });
    });

    it("drops an off-site returnTo", async () => {
      const landing = await signInWithGoogle("https://evil.test/phish");
      assert.equal(new URLSearchParams(landing.hash.slice(1)).get("returnTo"), null);
    });

    it("rejects a callback without the nonce cookie of the browser that started it (login CSRF)", async () => {
      const { state } = await beginAtGoogle("/api/v1/auth/google");
      const landing = await completeAtCallback(state);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
      assert.equal(store.users.length, 0);
    });

    it("rejects a callback replayed in another browser", async () => {
      const attacker = await beginAtGoogle("/api/v1/auth/google");
      const victim = await beginAtGoogle("/api/v1/auth/google");
      const landing = await completeAtCallback(attacker.state, victim.cookie);
      assert.equal(landing.searchParams.get("error"), "oauth_state_invalid");
    });

    it("clears the single-use nonce cookie on callback", async () => {
      const { state, cookie } = await beginAtGoogle("/api/v1/auth/google");
      const res = await get(`/api/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`, { Cookie: cookie });
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith("fxi_oauth_nonce="));
      assert.ok(cleared && /Expires=Thu, 01 Jan 1970/i.test(cleared));
    });

    it("sends the user back to sign-in when they cancel at Google", async () => {
      const res = await get("/api/v1/auth/google/callback?error=access_denied");
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.pathname, "/login");
      assert.equal(landing.searchParams.get("error"), "google_denied");
    });

    it("rejects Google accounts with an unverified email", async () => {
      nextIdentity.emailVerified = false;
      const landing = await signInWithGoogle();
      assert.equal(landing.searchParams.get("error"), "google_email_unverified");
    });

    it("signs an existing email/password manager into the same account", async () => {
      const registered = await (await send("POST", "/api/v1/auth/register", {
        email: "manager@gmail.com",
        password: "correct-horse-battery",
      })).json();

      const landing = await signInWithGoogle();
      const token = new URLSearchParams(landing.hash.slice(1)).get("token")!;

      assert.equal(verifyAccessToken(token).userId, registered.data.user.id);
      assert.equal(store.users.length, 1);
      assert.deepEqual((await me(token)).authProviders, { password: true, google: true });
    });
  });

  describe("account linking", () => {
    async function register(email: string) {
      const res = await send("POST", "/api/v1/auth/register", { email, password: "correct-horse-battery" });
      return (await res.json()).data as { token: string; user: { id: string } };
    }

    async function linkGoogle(token: string) {
      const ticketRes = await send("POST", "/api/v1/auth/google/link", undefined, token);
      assert.equal(ticketRes.status, 200);
      const { url } = (await ticketRes.json()).data;
      const { state, cookie } = await beginAtGoogle(url);
      return completeAtCallback(state, cookie);
    }

    it("requires authentication to start linking", async () => {
      const res = await send("POST", "/api/v1/auth/google/link");
      assert.equal(res.status, 401);
    });

    it("links a Google account with a different email to the signed-in manager", async () => {
      const { token, user } = await register("work@example.com");
      nextIdentity = { googleId: "google-77", email: "personal@gmail.com", emailVerified: true };

      const landing = await linkGoogle(token);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linked"), "google");
      assert.equal(store.users[0].googleId, "google-77");
      assert.deepEqual((await me(token)).authProviders, { password: true, google: true });

      // Signing in with that Google account now opens the linked account
      const signIn = await signInWithGoogle();
      assert.equal(verifyAccessToken(new URLSearchParams(signIn.hash.slice(1)).get("token")!).userId, user.id);
      assert.equal(store.users.length, 1);
    });

    it("refuses to link a Google account that belongs to another manager", async () => {
      await signInWithGoogle(); // google-1 now owns an account
      const { token } = await register("second@example.com");

      const landing = await linkGoogle(token);
      assert.equal(landing.pathname, "/profile");
      assert.equal(landing.searchParams.get("linkError"), "google_account_conflict");
      assert.equal(store.users.find((u) => u.email === "second@example.com")!.googleId, null);
    });

    it("rejects forged or tampered link tickets", async () => {
      const res = await get("/api/v1/auth/google/link/start?ticket=forged.ticket");
      const landing = new URL(res.headers.get("location")!);
      assert.equal(landing.searchParams.get("linkError"), "link_ticket_invalid");
    });

    it("keeps Google linked until the manager has another way to sign in", async () => {
      const landing = await signInWithGoogle();
      const token = new URLSearchParams(landing.hash.slice(1)).get("token")!;

      const refused = await send("DELETE", "/api/v1/auth/google/link", undefined, token);
      assert.equal(refused.status, 409);

      const setPassword = await send("POST", "/api/v1/auth/password", { password: "new-password-123" }, token);
      assert.equal(setPassword.status, 200);
      assert.deepEqual((await setPassword.json()).data.authProviders, { password: true, google: true });

      const unlinked = await send("DELETE", "/api/v1/auth/google/link", undefined, token);
      assert.equal(unlinked.status, 200);
      assert.deepEqual((await unlinked.json()).data.authProviders, { password: true, google: false });

      const login = await send("POST", "/api/v1/auth/login", { email: "manager@gmail.com", password: "new-password-123" });
      assert.equal(login.status, 200);
    });

    it("requires the current password to change an existing password", async () => {
      const { token } = await register("pw@example.com");
      const wrong = await send("POST", "/api/v1/auth/password", { password: "another-pass-1", currentPassword: "nope" }, token);
      assert.equal(wrong.status, 401);
      const right = await send(
        "POST",
        "/api/v1/auth/password",
        { password: "another-pass-1", currentPassword: "correct-horse-battery" },
        token
      );
      assert.equal(right.status, 200);
    });
  });
});

describe("AuthService account linking rules", () => {
  it("asks the manager to unlink first when a different Google account is already linked", async () => {
    const { AuthService, AuthConflictError } = await import("../services/auth/authService.js");
    const store = createUserStore();
    const service = new AuthService(store);
    const { user } = await service.handleGoogleAuth({ googleId: "google-A", email: "a@gmail.com", emailVerified: true });

    await assert.rejects(
      () => service.linkGoogleAccount(user.id, { googleId: "google-B", email: "b@gmail.com", emailVerified: true }),
      (err: unknown) => err instanceof AuthConflictError && /unlink it first/i.test(err.message)
    );
    // Re-linking the same Google account is a harmless no-op
    const same = await service.linkGoogleAccount(user.id, { googleId: "google-A", email: "a@gmail.com", emailVerified: true });
    assert.equal(same.authProviders.google, true);
  });

  it("resolves a concurrent first sign-in with the same Google account to one user", async () => {
    const { AuthService } = await import("../services/auth/authService.js");
    const store = createUserStore();
    const service = new AuthService(store);
    const identity = { googleId: "google-race", email: "race@gmail.com", emailVerified: true };

    const [first, second] = await Promise.all([service.handleGoogleAuth(identity), service.handleGoogleAuth(identity)]);

    assert.equal(store.users.length, 1);
    assert.equal(first.user.id, second.user.id);
  });
});
