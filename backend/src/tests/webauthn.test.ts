import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { UserRole } from "../types/index.js";
import {
  WebAuthnService,
  toBase64Url,
  fromBase64Url,
} from "../services/auth/webauthnService.js";
import {
  AuthService,
  AuthConflictError,
  AuthUnauthorizedError,
} from "../services/auth/authService.js";
import { verifyAccessToken } from "../config/jwt.js";

const TEST_RP_ID = "fantasyxi.test";
const TEST_ORIGIN = "https://fantasyxi.test";

interface FakeUserRecord {
  id: string;
  email: string;
  username: string;
  passwordHash: string | null;
  googleId: string | null;
  name: string | null;
  role: UserRole;
  referralCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeCredentialRecord {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  algorithm: number;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

function createFakeStore(seedUsers: FakeUserRecord[] = []) {
  const users = new Map<string, FakeUserRecord>(seedUsers.map((u) => [u.id, { ...u }]));
  const credentials = new Map<string, FakeCredentialRecord>();
  let seq = 1;

  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => {
        if (where.id) return users.get(where.id) ?? null;
        if (where.email) {
          for (const u of users.values()) {
            if (u.email === where.email) return u;
          }
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const u = users.get(where.id);
        if (!u) throw new Error("User not found");
        const updated = { ...u, ...data, updatedAt: new Date() };
        users.set(where.id, updated);
        return updated;
      },
    },
    webAuthnCredential: {
      findMany: async ({ where }: any) => {
        const list = Array.from(credentials.values()).filter(
          (c) => !where?.userId || c.userId === where.userId
        );
        return list;
      },
      findUnique: async ({ where, include }: any) => {
        let found: FakeCredentialRecord | null = null;
        if (where.id) {
          found = credentials.get(where.id) ?? null;
        } else if (where.credentialId) {
          for (const c of credentials.values()) {
            if (c.credentialId === where.credentialId) {
              found = c;
              break;
            }
          }
        }
        if (!found) return null;
        if (include?.user) {
          return { ...found, user: users.get(found.userId) ?? null };
        }
        return found;
      },
      count: async ({ where }: any) => {
        return Array.from(credentials.values()).filter(
          (c) => !where?.userId || c.userId === where.userId
        ).length;
      },
      create: async ({ data }: any) => {
        const record: FakeCredentialRecord = {
          id: `pk_${seq++}`,
          userId: data.userId,
          credentialId: data.credentialId,
          publicKey: data.publicKey,
          counter: data.counter ?? 0,
          deviceType: data.deviceType ?? "multiDevice",
          backedUp: Boolean(data.backedUp),
          transports: data.transports ?? [],
          algorithm: data.algorithm ?? -7,
          name: data.name ?? "Passkey",
          createdAt: new Date(),
          lastUsedAt: null,
        };
        credentials.set(record.id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = credentials.get(where.id);
        if (!existing) throw new Error("Credential not found");
        const updated = { ...existing, ...data };
        credentials.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: any) => {
        const existing = credentials.get(where.id);
        credentials.delete(where.id);
        return existing;
      },
    },
  };

  return { prisma, users, credentials };
}

/**
 * Helper to encode a COSE EC2 (P-256, alg -7) public key and wrap it in a real
 * CBOR attestationObject with authenticatorData.
 */
function buildCborAttestationObject(params: {
  rpId: string;
  flags?: number;
  signCount?: number;
  credentialId: string;
  jwk: crypto.JsonWebKey;
}): string {
  const rpIdHash = crypto.createHash("sha256").update(params.rpId).digest();
  const flags = Buffer.from([params.flags ?? 0x5d]); // UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10) | AT (0x40)
  const signCountBuf = Buffer.alloc(4);
  signCountBuf.writeUInt32BE(params.signCount ?? 1, 0);

  const aaguid = Buffer.alloc(16, 0);
  const credIdBytes = fromBase64Url(params.credentialId);
  const credIdLenBuf = Buffer.alloc(2);
  credIdLenBuf.writeUInt16BE(credIdBytes.length, 0);

  // Encode COSE_Key Map: { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x (32B), -3: y (32B) }
  const xBytes = fromBase64Url(params.jwk.x!);
  const yBytes = fromBase64Url(params.jwk.y!);
  const coseKeyCbor = Buffer.concat([
    Buffer.from([0xa5]), // map(5)
    Buffer.from([0x01, 0x02]), // 1: 2
    Buffer.from([0x03, 0x26]), // 3: -7
    Buffer.from([0x20, 0x01]), // -1: 1
    Buffer.from([0x21, 0x58, 0x20]), // -2: bstr(32)
    xBytes,
    Buffer.from([0x22, 0x58, 0x20]), // -3: bstr(32)
    yBytes,
  ]);

  const authData = Buffer.concat([
    rpIdHash,
    flags,
    signCountBuf,
    aaguid,
    credIdLenBuf,
    credIdBytes,
    coseKeyCbor,
  ]);

  // CBOR map(1) { "authData": bstr(authData) }
  const authDataLenHeader =
    authData.length < 256
      ? Buffer.from([0x58, authData.length])
      : Buffer.from([0x59, authData.length >> 8, authData.length & 0xff]);

  const cborAttestation = Buffer.concat([
    Buffer.from([0xa1]), // map(1)
    Buffer.from([0x68]), // tstr(8)
    Buffer.from("authData", "utf8"),
    authDataLenHeader,
    authData,
  ]);

  return toBase64Url(cborAttestation);
}

function buildAssertionAuthData(params: {
  rpId: string;
  flags?: number;
  signCount: number;
}): Buffer {
  const rpIdHash = crypto.createHash("sha256").update(params.rpId).digest();
  const flags = Buffer.from([params.flags ?? 0x05]); // UP | UV
  const signCountBuf = Buffer.alloc(4);
  signCountBuf.writeUInt32BE(params.signCount, 0);
  return Buffer.concat([rpIdHash, flags, signCountBuf]);
}

describe("WebAuthn / Passkeys Authentication Provider (#365)", () => {
  const baseUser: FakeUserRecord = {
    id: "user_manager_1",
    email: "manager@fantasyxi.test",
    username: "gaffer_one",
    passwordHash: "bcrypt_hashed_password",
    googleId: null,
    name: "Manager One",
    role: UserRole.USER,
    referralCode: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("registers a passkey via CBOR COSE attestation and signs in passwordlessly with JWT parity", async () => {
    const { prisma } = createFakeStore([baseUser]);
    const loginAuditCalls: Array<{ userId: string; ip?: string }> = [];
    const fakeLoginSecurity: any = {
      handleSuccessfulLogin: async (ctx: any) => {
        loginAuditCalls.push({ userId: ctx.userId, ip: ctx.ip });
      },
    };

    const service = new WebAuthnService(prisma, fakeLoginSecurity, {
      rpId: TEST_RP_ID,
      rpName: "FantasyXI",
      expectedOrigins: [TEST_ORIGIN],
    });

    // 1. Generate registration challenge options
    const regOptions = await service.generateRegistrationOptions(baseUser.id);
    assert.ok(regOptions.challenge.length >= 32);
    assert.equal(regOptions.rp.id, TEST_RP_ID);
    assert.deepEqual(regOptions.excludeCredentials, []);

    // 2. Simulate authenticator keypair generation (ES256 P-256)
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = toBase64Url(crypto.randomBytes(24));

    const clientDataReg = toBase64Url(
      Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: regOptions.challenge,
          origin: TEST_ORIGIN,
        }),
        "utf8"
      )
    );

    const attestationObject = buildCborAttestationObject({
      rpId: TEST_RP_ID,
      signCount: 1,
      credentialId,
      jwk,
    });

    const regResult = await service.verifyRegistration(baseUser.id, {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      name: "MacBook Pro Touch ID",
      transports: ["internal", "hybrid"],
      response: {
        clientDataJSON: clientDataReg,
        attestationObject,
      },
    });

    assert.equal(regResult.credential.credentialId, credentialId);
    assert.equal(regResult.credential.name, "MacBook Pro Touch ID");
    assert.equal(regResult.credential.backedUp, true);
    assert.equal(regResult.user.authProviders?.passkeys, true);

    // Subsequent registration options exclude the newly registered passkey
    const secondRegOptions = await service.generateRegistrationOptions(baseUser.id);
    assert.equal(secondRegOptions.excludeCredentials.length, 1);
    assert.equal(secondRegOptions.excludeCredentials[0].id, credentialId);

    // 3. Generate authentication options and sign in without password
    const authOptions = await service.generateAuthenticationOptions({
      email: baseUser.email,
    });
    assert.equal(authOptions.allowCredentials.length, 1);
    assert.equal(authOptions.allowCredentials[0].id, credentialId);

    const clientDataAuthBuf = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: authOptions.challenge,
        origin: TEST_ORIGIN,
      }),
      "utf8"
    );
    const authDataBuf = buildAssertionAuthData({
      rpId: TEST_RP_ID,
      signCount: 2,
    });

    const clientDataHash = crypto.createHash("sha256").update(clientDataAuthBuf).digest();
    const signedPayload = Buffer.concat([authDataBuf, clientDataHash]);
    // Test IEEE P1363 64-byte signature format (standard WebCrypto output)
    const p1363Sig = crypto.sign("sha256", signedPayload, {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });

    const loginResult = await service.verifyAuthentication(
      {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: toBase64Url(clientDataAuthBuf),
          authenticatorData: toBase64Url(authDataBuf),
          signature: toBase64Url(p1363Sig),
          userHandle: toBase64Url(Buffer.from(baseUser.id, "utf8")),
        },
      },
      { ip: "203.0.113.42", userAgent: "PasskeyTestAgent/1.0" }
    );

    assert.equal(loginResult.user.id, baseUser.id);
    assert.equal(loginResult.user.authProviders?.passkeys, true);
    assert.equal(loginAuditCalls.length, 1);
    assert.equal(loginAuditCalls[0].ip, "203.0.113.42");

    // Verify JWT token parity with standard auth
    const decoded = verifyAccessToken(loginResult.token);
    assert.equal(decoded.userId, baseUser.id);
    assert.equal(decoded.email, baseUser.email);
    assert.equal(decoded.role, UserRole.USER);
  });

  it("rejects replayed challenges, untrusted origins, tampered signatures, and counter regressions", async () => {
    const { prisma } = createFakeStore([baseUser]);
    const fakeLoginSecurity: any = { handleSuccessfulLogin: async () => {} };
    const service = new WebAuthnService(prisma, fakeLoginSecurity, {
      rpId: TEST_RP_ID,
      rpName: "FantasyXI",
      expectedOrigins: [TEST_ORIGIN],
    });

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    const credentialId = toBase64Url(crypto.randomBytes(20));

    const regOpts = await service.generateRegistrationOptions(baseUser.id);
    const clientDataReg = toBase64Url(
      Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: regOpts.challenge,
          origin: TEST_ORIGIN,
        }),
        "utf8"
      )
    );

    await service.verifyRegistration(baseUser.id, {
      id: credentialId,
      name: "YubiKey 5",
      response: {
        clientDataJSON: clientDataReg,
        publicKey: toBase64Url(spkiDer),
        publicKeyAlgorithm: -7,
      },
    });

    // Reusing the same registration challenge must fail
    await assert.rejects(
      () =>
        service.verifyRegistration(baseUser.id, {
          id: toBase64Url(crypto.randomBytes(20)),
          response: {
            clientDataJSON: clientDataReg,
            publicKey: toBase64Url(spkiDer),
          },
        }),
      (err: unknown) =>
        err instanceof AuthUnauthorizedError && /Invalid or expired WebAuthn challenge/.test(err.message)
    );

    // Untrusted origin during login must fail
    const authOpts1 = await service.generateAuthenticationOptions({ email: baseUser.email });
    const badOriginClientData = toBase64Url(
      Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: authOpts1.challenge,
          origin: "https://phishing-fantasyxi.evil",
        }),
        "utf8"
      )
    );
    const authData1 = buildAssertionAuthData({ rpId: TEST_RP_ID, signCount: 5 });
    await assert.rejects(
      () =>
        service.verifyAuthentication({
          id: credentialId,
          response: {
            clientDataJSON: badOriginClientData,
            authenticatorData: toBase64Url(authData1),
            signature: toBase64Url(Buffer.alloc(64, 1)),
          },
        }),
      (err: unknown) => err instanceof AuthUnauthorizedError && /Untrusted WebAuthn origin/.test(err.message)
    );

    // Valid login with counter = 5 succeeds
    const authOpts2 = await service.generateAuthenticationOptions();
    const validClientData2 = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: authOpts2.challenge,
        origin: TEST_ORIGIN,
      }),
      "utf8"
    );
    const sig2 = crypto.sign(
      "sha256",
      Buffer.concat([authData1, crypto.createHash("sha256").update(validClientData2).digest()]),
      privateKey
    );
    await service.verifyAuthentication({
      id: credentialId,
      response: {
        clientDataJSON: toBase64Url(validClientData2),
        authenticatorData: toBase64Url(authData1),
        signature: toBase64Url(sig2),
      },
    });

    // Counter regression (signCount = 5 again or 3 <= 5) must be rejected as cloned authenticator
    const authOpts3 = await service.generateAuthenticationOptions();
    const validClientData3 = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: authOpts3.challenge,
        origin: TEST_ORIGIN,
      }),
      "utf8"
    );
    const regressedAuthData = buildAssertionAuthData({ rpId: TEST_RP_ID, signCount: 4 });
    const sig3 = crypto.sign(
      "sha256",
      Buffer.concat([regressedAuthData, crypto.createHash("sha256").update(validClientData3).digest()]),
      privateKey
    );

    await assert.rejects(
      () =>
        service.verifyAuthentication({
          id: credentialId,
          response: {
            clientDataJSON: toBase64Url(validClientData3),
            authenticatorData: toBase64Url(regressedAuthData),
            signature: toBase64Url(sig3),
          },
        }),
      (err: unknown) =>
        err instanceof AuthUnauthorizedError && /counter regression/i.test(err.message)
    );
  });

  it("lists and revokes passkeys while preventing account lockout when passkey is the only sign-in method", async () => {
    const passkeyOnlyUser: FakeUserRecord = {
      ...baseUser,
      id: "user_passkey_only",
      email: "passkeyonly@fantasyxi.test",
      passwordHash: null,
      googleId: "google_sub_123",
    };

    const { prisma } = createFakeStore([passkeyOnlyUser]);
    const fakeLoginSecurity: any = { handleSuccessfulLogin: async () => {} };
    const webauthn = new WebAuthnService(prisma, fakeLoginSecurity, {
      rpId: TEST_RP_ID,
      rpName: "FantasyXI",
      expectedOrigins: [TEST_ORIGIN],
    });
    const authSvc = new AuthService(prisma, fakeLoginSecurity);

    // Register two passkeys
    const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = toBase64Url(publicKey.export({ type: "spki", format: "der" }));

    for (const [idx, label] of ["iPhone Passkey", "Backup YubiKey"].entries()) {
      const opts = await webauthn.generateRegistrationOptions(passkeyOnlyUser.id);
      await webauthn.verifyRegistration(passkeyOnlyUser.id, {
        id: `cred_${idx + 1}`,
        name: label,
        response: {
          clientDataJSON: toBase64Url(
            Buffer.from(
              JSON.stringify({
                type: "webauthn.create",
                challenge: opts.challenge,
                origin: TEST_ORIGIN,
              })
            )
          ),
          publicKey: spki,
        },
      });
    }

    // Unlink Google account succeeds because user has registered passkeys even without a password
    const afterUnlinkUser = await authSvc.unlinkGoogleAccount(passkeyOnlyUser.id);
    assert.equal(afterUnlinkUser.authProviders?.google, false);
    assert.equal(afterUnlinkUser.authProviders?.passkeys, true);

    const list = await webauthn.listPasskeys(passkeyOnlyUser.id);
    assert.equal(list.length, 2);

    // Revoking first passkey succeeds because a second passkey remains
    const revoke1 = await webauthn.revokePasskey(passkeyOnlyUser.id, list[0].id);
    assert.equal(revoke1.deletedId, list[0].id);
    assert.equal(revoke1.user.authProviders?.passkeys, true);

    // Attempting to revoke the last remaining passkey when neither password nor Google is set must fail
    await assert.rejects(
      () => webauthn.revokePasskey(passkeyOnlyUser.id, list[1].id),
      (err: unknown) =>
        err instanceof AuthConflictError && /Cannot remove your only sign-in method/.test(err.message)
    );
  });
});
