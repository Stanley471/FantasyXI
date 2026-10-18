import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import bcrypt from "bcryptjs";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { signAccessToken, signPurposeToken, verifyAccessToken } from "../config/jwt.js";
import { PASSKEY_MFA_PURPOSE } from "../config/webauthn.js";
import {
  WebAuthnConflictError,
  WebAuthnService,
  WebAuthnVerificationError,
} from "../services/auth/webauthnService.js";
import { AuthService, PasskeyMfaRequiredError } from "../services/auth/authService.js";
import { createInMemoryPrisma } from "./helpers/inMemoryPrisma.js";
import { SoftAuthenticator } from "./helpers/softAuthenticator.js";

const ORIGIN = "https://fantasyxi.test";
const RP_ID = "fantasyxi.test";
const config = { rpID: RP_ID, rpName: "FantasyXI", origins: [ORIGIN], challengeTtlMs: 60_000 };
const noSecurity = { handleSuccessfulLogin: async () => undefined, recordFailedLogin: async () => undefined } as any;

async function passkeyDb() {
  const db = createInMemoryPrisma({
    uniques: {
      user: [["email"], ["username"]],
      passkeyCredential: [["credentialId"]],
      webAuthnChallenge: [["challenge"]],
    },
    defaults: {
      passkeyCredential: () => ({ createdAt: new Date(), lastUsedAt: null, name: null }),
      webAuthnChallenge: () => ({ consumedAt: null, createdAt: new Date() }),
    },
  });
  const passwordHash = await bcrypt.hash("correct horse", 4);
  const now = new Date();
  db.$seed("user", [
    { id: "alice", email: "alice@example.com", username: "alice", name: "Alice", role: "USER", passwordHash, googleId: null, passkeyMfaEnabled: false, createdAt: now, updatedAt: now },
    { id: "bob", email: "bob@example.com", username: "bob", name: "Bob", role: "USER", passwordHash, googleId: null, passkeyMfaEnabled: false, createdAt: now, updatedAt: now },
  ]);
  return db;
}

async function registerPasskey(service: WebAuthnService, device: SoftAuthenticator, userId: string, name?: string) {
  const options = await service.startRegistration(userId);
  const { credential, response } = device.register(options);
  const summary = await service.finishRegistration(userId, response as any, name);
  return { credential, summary, options };
}

describe("WebAuthnService: registration", () => {
  it("registers multiple passkeys per user (phone and security key)", async () => {
    const db = await passkeyDb();
    const service = new WebAuthnService(db, config, noSecurity);
    const phone = new SoftAuthenticator(ORIGIN, RP_ID, ["internal", "hybrid"]);
    const key = new SoftAuthenticator(ORIGIN, RP_ID, ["usb", "nfc"]);

    const first = await registerPasskey(service, phone, "alice", "My phone");
    const second = await registerPasskey(service, key, "alice", "YubiKey");
    assert.equal(first.summary.name, "My phone");
    assert.deepEqual(second.summary.transports, ["usb", "nfc"]);

    // The second ceremony told the browser not to re-register the first credential
    assert.deepEqual(second.options.excludeCredentials?.map((c) => c.id), [first.credential.id.toString("base64url")]);
    assert.equal((await service.listPasskeys("alice")).length, 2);

    const stored = db.$tables().passkeyCredential[0];
    assert.ok(Buffer.isBuffer(stored.publicKey), "only the public key is stored");
    assert.equal(typeof stored.counter, "bigint");
  });

  it("binds a registration challenge to the account that requested it", async () => {
    const db = await passkeyDb();
    const service = new WebAuthnService(db, config, noSecurity);
    const options = await service.startRegistration("alice");
    const { response } = new SoftAuthenticator(ORIGIN, RP_ID).register(options);
    await assert.rejects(service.finishRegistration("bob", response as any), WebAuthnVerificationError);
  });

  it("rejects a registration from another origin, and replays of the same response", async () => {
    const db = await passkeyDb();
    const service = new WebAuthnService(db, config, noSecurity);

    const phishing = new SoftAuthenticator("https://fantasyxi.evil", RP_ID);
    const options = await service.startRegistration("alice");
    await assert.rejects(service.finishRegistration("alice", phishing.register(options).response as any), WebAuthnVerificationError);

    const device = new SoftAuthenticator(ORIGIN, RP_ID);
    const fresh = await service.startRegistration("alice");
    const { response } = device.register(fresh);
    await service.finishRegistration("alice", response as any);
    await assert.rejects(service.finishRegistration("alice", response as any), /already used/);
  });

  it("reports a credential registered twice as a conflict", async () => {
    const db = await passkeyDb();
    const service = new WebAuthnService(db, config, noSecurity);
    const device = new SoftAuthenticator(ORIGIN, RP_ID);
    const { response } = device.register(await service.startRegistration("alice"));
    await service.finishRegistration("alice", response as any);

    // Same credential presented again under a new challenge
    const again = await service.startRegistration("alice");
    const replayed = JSON.parse(JSON.stringify(response));
    const clientData = JSON.parse(Buffer.from(replayed.response.clientDataJSON, "base64url").toString());
    clientData.challenge = again.challenge;
    replayed.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString("base64url");
    await assert.rejects(service.finishRegistration("alice", replayed), WebAuthnConflictError);
  });
});

describe("WebAuthnService: passwordless login and assertion security", () => {
  async function setup() {
    const db = await passkeyDb();
    const service = new WebAuthnService(db, config, noSecurity);
    const device = new SoftAuthenticator(ORIGIN, RP_ID);
    const { credential } = await registerPasskey(service, device, "alice");
    return { db, service, device, credential };
  }

  it("signs in with a discoverable passkey and no password", async () => {
    const { db, service, device, credential } = await setup();
    const options = await service.startAuthentication();
    assert.deepEqual(options.allowCredentials, []);
    assert.equal(options.userVerification, "required");

    const result = await service.finishAuthentication(device.assert(options.challenge, credential) as any);
    assert.equal(result.user.id, "alice");
    assert.equal(verifyAccessToken(result.token).userId, "alice");
    assert.equal(db.$tables().passkeyCredential[0].counter, 1n, "counter advanced");
    assert.ok(db.$tables().passkeyCredential[0].lastUsedAt instanceof Date);
  });

  it("lists the account's passkeys for an email, without revealing unknown emails", async () => {
    const { service, credential } = await setup();
    const known = await service.startAuthentication("Alice@Example.com");
    assert.deepEqual(known.allowCredentials?.map((c) => c.id), [credential.id.toString("base64url")]);
    const unknown = await service.startAuthentication("nobody@example.com");
    assert.deepEqual(Object.keys(unknown).sort(), Object.keys(known).sort());
    assert.deepEqual(unknown.allowCredentials, []);
  });

  it("rejects a replayed assertion", async () => {
    const { service, device, credential } = await setup();
    const options = await service.startAuthentication();
    const assertion = device.assert(options.challenge, credential);
    await service.finishAuthentication(assertion as any);
    await assert.rejects(service.finishAuthentication(assertion as any), /already used/);
  });

  for (const tamper of ["signature", "authenticatorData", "clientData"] as const) {
    it(`rejects an assertion with tampered ${tamper}`, async () => {
      const { db, service, device, credential } = await setup();
      const options = await service.startAuthentication();
      await assert.rejects(
        service.finishAuthentication(device.assert(options.challenge, credential, { tamper }) as any),
        WebAuthnVerificationError
      );
      assert.equal(db.$tables().passkeyCredential[0].counter, 0n, "nothing is updated");
    });
  }

  it("rejects a counter that does not advance (cloned authenticator)", async () => {
    const { db, service, device, credential } = await setup();
    const first = await service.startAuthentication();
    await service.finishAuthentication(device.assert(first.challenge, credential, { counter: 10 }) as any);

    const second = await service.startAuthentication();
    await assert.rejects(
      service.finishAuthentication(device.assert(second.challenge, credential, { counter: 5 }) as any),
      WebAuthnVerificationError
    );
    const third = await service.startAuthentication();
    await assert.rejects(
      service.finishAuthentication(device.assert(third.challenge, credential, { counter: 10 }) as any),
      WebAuthnVerificationError,
      "an equal counter is a regression too"
    );
    assert.equal(db.$tables().passkeyCredential[0].counter, 10n);
  });

  it("rejects assertions for another origin or relying party", async () => {
    const { service, device, credential } = await setup();
    const a = await service.startAuthentication();
    await assert.rejects(service.finishAuthentication(device.assert(a.challenge, credential, { origin: "https://evil.test" }) as any), WebAuthnVerificationError);
    const b = await service.startAuthentication();
    await assert.rejects(service.finishAuthentication(device.assert(b.challenge, credential, { rpId: "evil.test" }) as any), WebAuthnVerificationError);
  });

  it("requires user verification for passwordless login", async () => {
    const { service, device, credential } = await setup();
    const options = await service.startAuthentication();
    await assert.rejects(
      service.finishAuthentication(device.assert(options.challenge, credential, { userVerified: false }) as any),
      WebAuthnVerificationError
    );
  });

  it("rejects expired challenges and challenges signed for another ceremony", async () => {
    const { db, service, device, credential } = await setup();
    const options = await service.startAuthentication();
    db.$tables().webAuthnChallenge.find((c: any) => c.challenge === options.challenge).expiresAt = new Date(Date.now() - 1000);
    await assert.rejects(service.finishAuthentication(device.assert(options.challenge, credential) as any), /expired/);

    const registration = await service.startRegistration("alice");
    await assert.rejects(
      service.finishAuthentication(device.assert(registration.challenge, credential) as any),
      WebAuthnVerificationError
    );
  });

  it("only accepts the requested account's passkey when the login named an email", async () => {
    const { service } = await setup();
    const bobsPhone = new SoftAuthenticator(ORIGIN, RP_ID);
    const { credential: bobKey } = await registerPasskey(service, bobsPhone, "bob");
    const options = await service.startAuthentication("alice@example.com");
    await assert.rejects(service.finishAuthentication(bobsPhone.assert(options.challenge, bobKey) as any), WebAuthnVerificationError);
  });

  it("rejects unknown credentials and malformed responses", async () => {
    const { service } = await setup();
    const stranger = new SoftAuthenticator(ORIGIN, RP_ID);
    const { credential } = stranger.register({ challenge: "x", rp: { id: RP_ID } });
    const options = await service.startAuthentication();
    await assert.rejects(service.finishAuthentication(stranger.assert(options.challenge, credential) as any), WebAuthnVerificationError);
    await assert.rejects(service.finishAuthentication({ id: "abc" } as any), /Invalid WebAuthn response/);
  });
});

describe("WebAuthnService: step-up MFA after password login", () => {
  async function setup() {
    const db = await passkeyDb();
    const service = new WebAuthnService(db, config, noSecurity);
    const auth = new AuthService(db, { publish: async () => undefined } as any, noSecurity);
    const device = new SoftAuthenticator(ORIGIN, RP_ID);
    const { credential, summary } = await registerPasskey(service, device, "alice");
    return { db, service, auth, device, credential, summary };
  }

  it("requires the current password and a registered passkey to enable", async () => {
    const { service } = await setup();
    await assert.rejects(service.setMfaEnabled("alice", true, "wrong"), /Current password is incorrect/);
    await assert.rejects(service.setMfaEnabled("bob", true, "correct horse"), /Register a passkey/);
    assert.deepEqual(await service.setMfaEnabled("alice", true, "correct horse"), { passkeyMfaEnabled: true });
  });

  it("withholds the session until a passkey assertion completes the login", async () => {
    const { service, auth, device, credential } = await setup();
    await service.setMfaEnabled("alice", true, "correct horse");

    let ticket = "";
    await assert.rejects(auth.login({ email: "alice@example.com", password: "correct horse" }), (error: unknown) => {
      assert.ok(error instanceof PasskeyMfaRequiredError);
      ticket = error.mfaToken;
      assert.deepEqual(error.toResult().methods, ["passkey"]);
      return true;
    });
    assert.throws(() => verifyAccessToken(ticket), /not an access token/, "the MFA ticket is not a session");

    const options = await service.startMfa(ticket);
    assert.equal(options.allowCredentials?.length, 1);
    const result = await service.finishMfa(ticket, device.assert(options.challenge, credential) as any);
    assert.equal(result.user.id, "alice");
    assert.equal(verifyAccessToken(result.token).userId, "alice");
  });

  it("does not let another user's passkey or a forged ticket complete the step-up", async () => {
    const { service } = await setup();
    const bobsKey = new SoftAuthenticator(ORIGIN, RP_ID);
    const { credential } = await registerPasskey(service, bobsKey, "bob");

    const ticket = signPurposeToken("alice", PASSKEY_MFA_PURPOSE, "5m");
    const options = await service.startMfa(ticket);
    await assert.rejects(service.finishMfa(ticket, bobsKey.assert(options.challenge, credential) as any), WebAuthnVerificationError);

    await assert.rejects(service.startMfa(signAccessToken({ userId: "alice" })), /sign-in session expired/);
    await assert.rejects(service.startMfa("garbage"), /sign-in session expired/);
    await assert.rejects(service.startMfa(signPurposeToken("alice", "other_purpose", "5m")), /sign-in session expired/);
  });

  it("keeps the last passkey while step-up is on", async () => {
    const { service, summary } = await setup();
    await service.setMfaEnabled("alice", true, "correct horse");
    await assert.rejects(service.deletePasskey("alice", summary.id), WebAuthnConflictError);
    await service.setMfaEnabled("alice", false, "correct horse");
    await service.deletePasskey("alice", summary.id);
    assert.equal((await service.listPasskeys("alice")).length, 0);
  });

  it("does not let a user delete someone else's passkey", async () => {
    const { service, summary } = await setup();
    await assert.rejects(service.deletePasskey("bob", summary.id), /Passkey not found/);
  });
});

// ============================================================
// API integration: full ceremonies through the Express routes
// ============================================================

// The auth rate limiter reads this when the routes module is first imported
process.env.AUTH_RATE_LIMIT_MAX = "1000";

describe("Passkey API (registration and authentication ceremonies over HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let db: any;

  before(async () => {
    db = await passkeyDb();
    const { default: authRoutes } = await import("../routes/auth.routes.js");
    const { webauthnService } = await import("../services/auth/webauthnService.js");
    const { authService } = await import("../services/auth/authService.js");
    Object.defineProperty(webauthnService, "db", { get: () => db });
    Object.defineProperty(webauthnService, "config", { get: () => config });
    Object.defineProperty(webauthnService, "security", { get: () => noSecurity });
    Object.defineProperty(authService, "db", { get: () => db });
    Object.defineProperty(authService, "security", { get: () => noSecurity });

    const app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRoutes);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/auth`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function call(path: string, body?: unknown, token?: string, method = "POST") {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("registers a passkey, signs in without a password, then enforces step-up on password login", async () => {
    const aliceToken = signAccessToken({ userId: "alice", email: "alice@example.com", username: "alice", role: "USER" });
    const device = new SoftAuthenticator(ORIGIN, RP_ID);

    // Registration ceremony
    assert.equal((await call("/passkeys/register/options")).status, 401, "registration needs a session");
    const regOptions = await call("/passkeys/register/options", {}, aliceToken);
    assert.equal(regOptions.status, 200);
    assert.equal(regOptions.body.data.rp.id, "fantasyxi.test");
    const { credential, response } = device.register(regOptions.body.data);
    const registered = await call("/passkeys/register/verify", { response, name: "Laptop" }, aliceToken);
    assert.equal(registered.status, 201);
    assert.equal(registered.body.data.name, "Laptop");

    const list = await call("/passkeys", undefined, aliceToken, "GET");
    assert.equal(list.body.data.length, 1);

    // Passwordless authentication ceremony
    const loginOptions = await call("/passkeys/login/options", {});
    const assertion = device.assert(loginOptions.body.data.challenge, credential);
    const login = await call("/passkeys/login/verify", { response: assertion });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.id, "alice");
    assert.equal(verifyAccessToken(login.body.data.token).userId, "alice");

    const replay = await call("/passkeys/login/verify", { response: assertion });
    assert.equal(replay.status, 401, "replayed assertion rejected");

    // Turn on step-up, then a password login only yields an MFA ticket
    const enable = await call("/passkeys/mfa", { enabled: true, currentPassword: "correct horse" }, aliceToken, "PUT");
    assert.equal(enable.status, 200);
    const passwordLogin = await call("/login", { email: "alice@example.com", password: "correct horse" });
    assert.equal(passwordLogin.status, 200);
    assert.equal(passwordLogin.body.data.mfaRequired, true);
    assert.equal(passwordLogin.body.data.token, undefined, "no session before the passkey");

    const ticket = passwordLogin.body.data.mfaToken;
    assert.equal((await call("/passkeys", undefined, ticket, "GET")).status, 401, "ticket is not an access token");

    const mfaOptions = await call("/passkeys/mfa/options", { mfaToken: ticket });
    const mfa = await call("/passkeys/mfa/verify", {
      mfaToken: ticket,
      response: device.assert(mfaOptions.body.data.challenge, credential),
    });
    assert.equal(mfa.status, 200);
    assert.equal(verifyAccessToken(mfa.body.data.token).userId, "alice");

    // Wrong password never reaches the passkey step
    assert.equal((await call("/login", { email: "alice@example.com", password: "nope" })).status, 401);
  });

  it("returns 400 for malformed ceremony responses", async () => {
    const res = await call("/passkeys/login/verify", { response: { id: "x", response: { clientDataJSON: "%%%" } } });
    assert.equal(res.status, 400);
  });
});
