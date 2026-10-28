import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { WebAuthnService, PasskeyError, type WebAuthnConfig } from "../services/auth/webAuthnService.js";
import { SecurityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";

/**
 * WebAuthn / passkey ceremonies (issue #273) against a software authenticator
 * that produces real P-256 attestations and assertions, so every check
 * (challenge, origin, RP ID hash, flags, signature, counter) runs through
 * @simplewebauthn/server unmocked. Credentials and users live in memory.
 */

process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_ORIGINS = "http://localhost:3000";
// Read when the routes/rate limiter modules are first imported (integration suite)
process.env.AUTH_RATE_LIMIT_MAX = "1000";
process.env.REDIS_ENABLED = "false";

const CONFIG: WebAuthnConfig = { rpID: "localhost", rpName: "FantasyXI", origins: ["http://localhost:3000"] };
const sha256 = (data: string | Uint8Array) => crypto.createHash("sha256").update(data).digest();
const b64 = (data: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(data));

/** Flags (W3C WebAuthn §6.1): UP = 0x01, UV = 0x04, AT = 0x40 */
const FLAGS_REGISTER = 0x45;
const FLAGS_ASSERT = 0x05;

class VirtualAuthenticator {
  public readonly credentialId = crypto.randomBytes(16);
  public counter = 0;
  private readonly keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

  constructor(private readonly origin = CONFIG.origins[0], private readonly rpID = CONFIG.rpID) {}

  get id(): string {
    return b64(this.credentialId);
  }

  private authenticatorData(flags: number, attestedCredentialData?: Uint8Array): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(this.rpID), Buffer.from([flags]), counter, ...(attestedCredentialData ? [attestedCredentialData] : [])]);
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    // COSE_Key (RFC 9052): kty EC2, alg ES256, crv P-256, x, y
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ])
    );
  }

  public register(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false })
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, this.cosePublicKey()]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, never> | Uint8Array>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(this.authenticatorData(FLAGS_REGISTER, attested))],
      ])
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ["internal"] },
    };
  }

  public assert(options: PublicKeyCredentialRequestOptionsJSON, userId: string | null): AuthenticationResponseJSON {
    this.counter++;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false })
    );
    const authData = this.authenticatorData(FLAGS_ASSERT);
    const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(signature),
        ...(userId && { userHandle: isoBase64URL.fromUTF8String(userId) }),
      },
    };
  }
}

type StoredCredential = {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: bigint;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  aaguid: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

const pick = (row: StoredCredential, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof StoredCredential]])) : { ...row };

function createCredentialStore() {
  const credentials: StoredCredential[] = [];
  return {
    credentials,
    webAuthnCredential: {
      findMany: async ({ where, select }: any) => credentials.filter((c) => c.userId === where.userId).map((c) => pick(c, select)),
      count: async ({ where }: any) => credentials.filter((c) => c.userId === where.userId).length,
      findUnique: async ({ where }: any) => {
        const row = credentials.find((c) => c.id === where.id);
        return row ? { ...row } : null;
      },
      create: async ({ data, select }: any) => {
        if (credentials.some((c) => c.id === data.id)) {
          throw Object.assign(new Error("Unique constraint failed on id"), { code: "P2002" });
        }
        const row: StoredCredential = { createdAt: new Date(), lastUsedAt: null, ...data };
        credentials.push(row);
        return pick(row, select);
      },
      updateMany: async ({ where, data }: any) => {
        const row = credentials.find((c) => c.id === where.id && c.counter === where.counter);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: any) => {
        const index = credentials.findIndex((c) => c.id === where.id && c.userId === where.userId);
        if (index === -1) return { count: 0 };
        credentials.splice(index, 1);
        return { count: 1 };
      },
    },
  };
}

const ALICE = { id: "8f6c1c0e-6a8e-4d1f-9a43-2f1d8e1b7a01", email: "alice@example.com", username: "alice" };
const MALLORY = { id: "1b2f3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d", email: "mallory@example.com", username: "mallory" };

async function expectPasskeyError(promise: Promise<unknown>, status: number, message?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PasskeyError, `expected PasskeyError, got ${error}`);
    assert.equal(error.statusCode, status);
    if (message) assert.match(error.message, message);
    return true;
  });
}

describe("WebAuthnService ceremonies (#273)", () => {
  let store: ReturnType<typeof createCredentialStore>;
  let anomalies: SecurityAnomalyLog;
  let service: WebAuthnService;

  beforeEach(() => {
    store = createCredentialStore();
    anomalies = new SecurityAnomalyLog();
    service = new WebAuthnService({ db: store, redis: null, config: CONFIG, anomalyLog: anomalies });
  });

  async function registerPasskey(user = ALICE, authenticator = new VirtualAuthenticator()) {
    const options = await service.generateRegistrationOptions(user);
    await service.verifyRegistration(user.id, authenticator.register(options));
    return authenticator;
  }

  it("registers multiple passkeys per account and excludes already-registered ones", async () => {
    const phone = await registerPasskey();
    const options = await service.generateRegistrationOptions(ALICE);
    assert.deepEqual(options.excludeCredentials?.map((c) => c.id), [phone.id]);
    assert.equal(options.authenticatorSelection?.residentKey, "required");
    assert.equal(options.authenticatorSelection?.userVerification, "required");

    const securityKey = new VirtualAuthenticator();
    const added = await service.verifyRegistration(ALICE.id, securityKey.register(options), "YubiKey 5C");
    assert.equal(added.name, "YubiKey 5C");

    const passkeys = await service.listCredentials(ALICE.id);
    assert.deepEqual(passkeys.map((p) => p.id).sort(), [phone.id, securityKey.id].sort());
    assert.equal(store.credentials[0].counter, 0n);
    assert.deepEqual(store.credentials[0].transports, ["internal"]);
  });

  it("refuses to register the same authenticator twice", async () => {
    const authenticator = await registerPasskey();
    const options = await service.generateRegistrationOptions(ALICE);
    await expectPasskeyError(service.verifyRegistration(ALICE.id, authenticator.register(options)), 409);
  });

  it("rejects a registration made on another origin or RP ID", async () => {
    const options = await service.generateRegistrationOptions(ALICE);
    await expectPasskeyError(
      service.verifyRegistration(ALICE.id, new VirtualAuthenticator("https://evil.test").register(options)),
      400,
      /origin/i
    );
    const again = await service.generateRegistrationOptions(ALICE);
    await expectPasskeyError(
      service.verifyRegistration(ALICE.id, new VirtualAuthenticator(CONFIG.origins[0], "evil.test").register(again)),
      400,
      /RP ID/i
    );
    assert.equal(store.credentials.length, 0);
  });

  it("binds a registration ceremony to the account that started it", async () => {
    const options = await service.generateRegistrationOptions(ALICE);
    await expectPasskeyError(
      service.verifyRegistration(MALLORY.id, new VirtualAuthenticator().register(options)),
      401,
      /expired or was already used/
    );
  });

  it("signs in without a password through a usernameless ceremony", async () => {
    const authenticator = await registerPasskey();
    const options = await service.generateAuthenticationOptions();
    assert.equal(options.allowCredentials, undefined, "discoverable credentials: no account enumeration");

    const result = await service.verifyAuthentication(authenticator.assert(options, ALICE.id), { ip: "203.0.113.5" });
    assert.deepEqual(result, { userId: ALICE.id, ceremony: "authentication" });
    assert.equal(store.credentials[0].counter, 1n);
    assert.ok(store.credentials[0].lastUsedAt instanceof Date);
  });

  it("rejects a replayed assertion", async () => {
    const authenticator = await registerPasskey();
    const response = authenticator.assert(await service.generateAuthenticationOptions(), ALICE.id);
    await service.verifyAuthentication(response, { ip: "203.0.113.5" });
    await expectPasskeyError(service.verifyAuthentication(response, { ip: "203.0.113.5" }), 401, /already used/);
  });

  it("rejects tampered signatures, origins and challenges", async () => {
    const authenticator = await registerPasskey();

    const forged = authenticator.assert(await service.generateAuthenticationOptions(), ALICE.id);
    const signature = isoBase64URL.toBuffer(forged.response.signature);
    signature[signature.length - 1] ^= 0xff;
    forged.response.signature = b64(signature);
    await expectPasskeyError(service.verifyAuthentication(forged, { ip: "203.0.113.5" }), 401);

    const phishing = new VirtualAuthenticator("https://fantasyxi.evil.test");
    Object.assign(phishing, { credentialId: authenticator.credentialId });
    await expectPasskeyError(
      service.verifyAuthentication(phishing.assert(await service.generateAuthenticationOptions(), ALICE.id), {
        ip: "203.0.113.5",
      }),
      401,
      /origin/i
    );

    const unknownChallenge = authenticator.assert({ challenge: b64(crypto.randomBytes(32)) } as never, ALICE.id);
    await expectPasskeyError(service.verifyAuthentication(unknownChallenge, { ip: "203.0.113.5" }), 401, /expired/);
  });

  it("rejects a regressed signature counter and flags a possibly cloned authenticator", async () => {
    const authenticator = await registerPasskey();
    await service.verifyAuthentication(authenticator.assert(await service.generateAuthenticationOptions(), ALICE.id), {
      ip: "203.0.113.5",
    });
    await service.verifyAuthentication(authenticator.assert(await service.generateAuthenticationOptions(), ALICE.id), {
      ip: "203.0.113.5",
    });

    authenticator.counter = 0; // a clone replaying from an older state
    await expectPasskeyError(
      service.verifyAuthentication(authenticator.assert(await service.generateAuthenticationOptions(), ALICE.id), {
        ip: "198.51.100.7",
      }),
      401,
      /counter/i
    );
    assert.equal(store.credentials[0].counter, 2n, "stored counter is untouched");
    const [anomaly] = anomalies.query({ type: SecurityAnomalyType.WEBAUTHN_COUNTER_REGRESSION });
    assert.equal(anomaly.userId, ALICE.id);
    assert.deepEqual(anomaly.detail, { storedCounter: 2, assertedCounter: 1 });
  });

  it("accepts only the account's own passkey for a step-up challenge", async () => {
    const alicePasskey = await registerPasskey(ALICE);
    const malloryPasskey = await registerPasskey(MALLORY);

    const stepUp = await service.generateStepUpOptions(ALICE.id, [{ id: alicePasskey.id, transports: ["internal"] }]);
    assert.deepEqual(stepUp.options.allowCredentials?.map((c) => c.id), [alicePasskey.id]);
    await expectPasskeyError(
      service.verifyAuthentication(malloryPasskey.assert(stepUp.options, MALLORY.id), { ip: "203.0.113.5" }),
      401,
      /not registered for this account/
    );

    const again = await service.generateStepUpOptions(ALICE.id, [{ id: alicePasskey.id, transports: [] }]);
    // A non-discoverable step-up assertion may omit the user handle
    const result = await service.verifyAuthentication(alicePasskey.assert(again.options, null), { ip: "203.0.113.5" });
    assert.deepEqual(result, { userId: ALICE.id, ceremony: "step-up" });
  });

  it("requires the user handle to match the credential owner", async () => {
    const authenticator = await registerPasskey();
    await expectPasskeyError(
      service.verifyAuthentication(authenticator.assert(await service.generateAuthenticationOptions(), MALLORY.id), {
        ip: "203.0.113.5",
      }),
      401,
      /does not belong/
    );
    await expectPasskeyError(
      service.verifyAuthentication(authenticator.assert(await service.generateAuthenticationOptions(), null), {
        ip: "203.0.113.5",
      }),
      401,
      /does not belong/
    );
  });

  it("does not accept a registration challenge for sign-in", async () => {
    const authenticator = await registerPasskey();
    const registration = await service.generateRegistrationOptions(ALICE);
    await expectPasskeyError(
      service.verifyAuthentication(authenticator.assert(registration as never, ALICE.id), { ip: "203.0.113.5" }),
      401
    );
  });

  it("deletes only the owner's passkeys and validates input shapes", async () => {
    const authenticator = await registerPasskey();
    await expectPasskeyError(service.deleteCredential(MALLORY.id, authenticator.id), 404);
    await service.deleteCredential(ALICE.id, authenticator.id);
    assert.equal(store.credentials.length, 0);

    await expectPasskeyError(service.verifyRegistration(ALICE.id, { id: "x" }), 400);
    await expectPasskeyError(service.verifyAuthentication("not-a-response", { ip: "203.0.113.5" }), 400);
  });
});

describe("Passkey API (integration, #273)", () => {
  type StoredUser = {
    id: string;
    email: string;
    username: string;
    passwordHash: string | null;
    name: string | null;
    role: "USER";
    googleId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };

  let server: Server;
  let base: string;
  let users: StoredUser[];
  let credentials: ReturnType<typeof createCredentialStore>;

  const send = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    const { default: authRoutes } = await import("../routes/auth.routes.js");
    const { authService } = await import("../services/auth/authService.js");
    const { webAuthnService } = await import("../services/auth/webAuthnService.js");

    const db = {
      user: {
        findUnique: async ({ where, include }: any) => {
          const [field, value] = Object.entries(where)[0] as [keyof StoredUser, unknown];
          const user = users.find((u) => u[field] === value);
          if (!user) return null;
          return include?.webAuthnCredentials
            ? {
                ...user,
                webAuthnCredentials: await credentials.webAuthnCredential.findMany({
                  where: { userId: user.id },
                  select: include.webAuthnCredentials.select,
                }),
              }
            : { ...user };
        },
        create: async ({ data }: any) => {
          const user: StoredUser = {
            id: crypto.randomUUID(),
            role: "USER",
            googleId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          users.push(user);
          return { ...user };
        },
        update: async ({ where, data }: any) => Object.assign(users.find((u) => u.id === where.id)!, data),
      },
      get webAuthnCredential() {
        return credentials.webAuthnCredential;
      },
      // Sign-in signatures (#274) are fire-and-forget; the in-memory store discards them
      accountSignal: { upsert: async () => ({}) },
    };
    Object.defineProperty(authService, "db", { get: () => db });
    Object.defineProperty(authService, "signals", { value: { record: () => undefined } });
    Object.defineProperty(webAuthnService, "db", { get: () => db });

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
    users = [];
    credentials = createCredentialStore();
  });

  async function signUp() {
    const res = await send("POST", "/api/v1/auth/register", {
      email: "manager@example.com",
      password: "correct-horse-battery",
      username: "manager",
    });
    assert.equal(res.status, 201);
    return res.body.data as { token: string; user: { id: string } };
  }

  async function addPasskey(token: string, name?: string) {
    const authenticator = new VirtualAuthenticator();
    const options = await send("POST", "/api/v1/auth/webauthn/register/options", undefined, token);
    assert.equal(options.status, 200);
    const verified = await send(
      "POST",
      "/api/v1/auth/webauthn/register/verify",
      { response: authenticator.register(options.body.data), name },
      token
    );
    assert.equal(verified.status, 201, JSON.stringify(verified.body));
    return authenticator;
  }

  it("runs the full registration and passwordless authentication ceremony", async () => {
    const { token, user } = await signUp();
    const phone = await addPasskey(token, "iPhone");
    const securityKey = await addPasskey(token, "YubiKey");

    const listed = await send("GET", "/api/v1/auth/webauthn/credentials", undefined, token);
    assert.deepEqual(listed.body.data.map((p: { name: string }) => p.name), ["iPhone", "YubiKey"]);
    assert.equal(listed.body.data[0].publicKey, undefined, "public keys are never returned");

    const options = await send("POST", "/api/v1/auth/webauthn/login/options");
    const assertion = securityKey.assert(options.body.data, user.id);
    const login = await send("POST", "/api/v1/auth/webauthn/login/verify", { response: assertion });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.id, user.id);
    assert.ok(login.body.data.token);

    const replay = await send("POST", "/api/v1/auth/webauthn/login/verify", { response: assertion });
    assert.equal(replay.status, 401);

    const removed = await send("DELETE", `/api/v1/auth/webauthn/credentials/${encodeURIComponent(phone.id)}`, undefined, token);
    assert.equal(removed.status, 200);
    assert.equal((await send("GET", "/api/v1/auth/webauthn/credentials", undefined, token)).body.data.length, 1);
  });

  it("requires the passkey as a second factor after a correct password", async () => {
    const { token, user } = await signUp();
    const passkey = await addPasskey(token);

    const passwordLogin = await send("POST", "/api/v1/auth/login", {
      email: "manager@example.com",
      password: "correct-horse-battery",
    });
    assert.equal(passwordLogin.status, 202);
    assert.equal(passwordLogin.body.data.method, "WEBAUTHN");
    assert.equal(passwordLogin.body.data.token, undefined, "no session before the second factor");
    assert.deepEqual(
      passwordLogin.body.data.options.allowCredentials.map((c: { id: string }) => c.id),
      [passkey.id]
    );

    const stepUp = await send("POST", "/api/v1/auth/webauthn/login/verify", {
      response: passkey.assert(passwordLogin.body.data.options, user.id),
    });
    assert.equal(stepUp.status, 200);
    assert.equal(stepUp.body.data.user.id, user.id);
  });

  it("protects passkey management behind authentication", async () => {
    assert.equal((await send("POST", "/api/v1/auth/webauthn/register/options")).status, 401);
    assert.equal((await send("GET", "/api/v1/auth/webauthn/credentials")).status, 401);
    const malformed = await send("POST", "/api/v1/auth/webauthn/login/verify", { response: { id: 1 } });
    assert.equal(malformed.status, 400);
  });
});
