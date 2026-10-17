import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  WebAuthnService,
  buildAuthenticatorData,
  toBase64Url,
} from "../services/auth/webauthnService.js";
import { AuthUnauthorizedError, AuthConflictError } from "../services/auth/authService.js";

function createTestAssertion(params: {
  credentialId: string;
  challenge: string;
  origin: string;
  rpId: string;
  counter: number;
  privateKeyPem: string;
  algorithm: "Ed25519" | "ES256";
  userPresent?: boolean;
  userVerified?: boolean;
}) {
  const clientDataObj = {
    type: "webauthn.get",
    challenge: params.challenge,
    origin: params.origin,
  };
  const clientDataBuffer = Buffer.from(JSON.stringify(clientDataObj), "utf8");
  const authDataBuffer = buildAuthenticatorData({
    rpId: params.rpId,
    counter: params.counter,
    userPresent: params.userPresent ?? true,
    userVerified: params.userVerified ?? false,
  });

  const clientDataHash = crypto.createHash("sha256").update(clientDataBuffer).digest();
  const signedPayload = Buffer.concat([authDataBuffer, clientDataHash]);
  const privKey = crypto.createPrivateKey(params.privateKeyPem);

  const sigBuffer =
    params.algorithm === "Ed25519"
      ? crypto.sign(null, signedPayload, privKey)
      : crypto.sign("sha256", signedPayload, privKey);

  return {
    id: params.credentialId,
    type: "public-key" as const,
    response: {
      clientDataJSON: toBase64Url(clientDataBuffer),
      authenticatorData: toBase64Url(authDataBuffer),
      signature: toBase64Url(sigBuffer),
    },
  };
}

test("WebAuthnService: registers multiple credentials (Ed25519 + ES256) and verifies assertions", () => {
  const service = new WebAuthnService({
    rpName: "FantasyXI",
    rpId: "fantasyxi.io",
    expectedOrigin: "https://fantasyxi.io",
  });

  const edKeyPair = crypto.generateKeyPairSync("ed25519");
  const ecKeyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  // 1. Register YubiKey (Ed25519)
  const regOpts1 = service.generateRegistrationOptions({
    userId: "user-1",
    email: "alice@fantasyxi.io",
    nowMs: 1_000_000,
  });

  const regClientData1 = Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge: regOpts1.challenge,
      origin: "https://fantasyxi.io",
    }),
    "utf8"
  );
  const regAuthData1 = buildAuthenticatorData({
    rpId: "fantasyxi.io",
    counter: 10,
    userPresent: true,
  });

  const cred1 = service.verifyRegistrationResponse({
    userId: "user-1",
    nowMs: 1_005_000,
    response: {
      id: "cred-yubikey-1",
      type: "public-key",
      deviceName: "YubiKey 5C NFC",
      response: {
        clientDataJSON: toBase64Url(regClientData1),
        authenticatorData: toBase64Url(regAuthData1),
        publicKeyPem: edKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        transports: ["usb", "nfc"],
      },
    },
  });

  assert.equal(cred1.algorithm, "Ed25519");
  assert.equal(cred1.counter, 10);

  // 2. Register TouchID (ES256) for the same user
  const regOpts2 = service.generateRegistrationOptions({
    userId: "user-1",
    email: "alice@fantasyxi.io",
    nowMs: 1_010_000,
  });
  assert.equal(regOpts2.excludeCredentials.length, 1);
  assert.equal(regOpts2.excludeCredentials[0].id, "cred-yubikey-1");

  const regClientData2 = Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge: regOpts2.challenge,
      origin: "https://fantasyxi.io",
    }),
    "utf8"
  );
  const regAuthData2 = buildAuthenticatorData({
    rpId: "fantasyxi.io",
    counter: 1,
    userPresent: true,
  });

  const cred2 = service.verifyRegistrationResponse({
    userId: "user-1",
    nowMs: 1_015_000,
    response: {
      id: "cred-touchid-2",
      type: "public-key",
      deviceName: "MacBook Pro TouchID",
      response: {
        clientDataJSON: toBase64Url(regClientData2),
        authenticatorData: toBase64Url(regAuthData2),
        publicKeyPem: ecKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        transports: ["internal"],
      },
    },
  });

  assert.equal(cred2.algorithm, "ES256");
  assert.equal(service.listUserCredentials("user-1").length, 2);

  // 3. Authenticate with YubiKey (Ed25519)
  const authOpts1 = service.generateAuthenticationOptions({
    userId: "user-1",
    intent: "login",
    nowMs: 1_020_000,
  });
  assert.equal(authOpts1.allowCredentials.length, 2);

  const assertion1 = createTestAssertion({
    credentialId: "cred-yubikey-1",
    challenge: authOpts1.challenge,
    origin: "https://fantasyxi.io",
    rpId: "fantasyxi.io",
    counter: 11,
    privateKeyPem: edKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    algorithm: "Ed25519",
  });

  const verified1 = service.verifyAuthenticationResponse({
    response: assertion1,
    expectedUserId: "user-1",
    nowMs: 1_025_000,
  });

  assert.equal(verified1.verified, true);
  assert.equal(verified1.newCounter, 11);
  assert.equal(verified1.intent, "login");

  // 4. Authenticate with TouchID (ES256) for step-up 2FA
  const authOpts2 = service.generateAuthenticationOptions({
    userId: "user-1",
    intent: "step_up_2fa",
    nowMs: 1_030_000,
  });

  const assertion2 = createTestAssertion({
    credentialId: "cred-touchid-2",
    challenge: authOpts2.challenge,
    origin: "https://fantasyxi.io",
    rpId: "fantasyxi.io",
    counter: 2,
    privateKeyPem: ecKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    algorithm: "ES256",
    userVerified: true,
  });

  const verified2 = service.verifyAuthenticationResponse({
    response: assertion2,
    expectedUserId: "user-1",
    nowMs: 1_035_000,
  });

  assert.equal(verified2.verified, true);
  assert.equal(verified2.intent, "step_up_2fa");
  assert.ok(verified2.stepUpToken && verified2.stepUpToken.length > 16);
});

test("WebAuthnService: rejects replay attacks and counter regression (cloned authenticator)", () => {
  const service = new WebAuthnService({
    rpName: "FantasyXI",
    rpId: "fantasyxi.io",
    expectedOrigin: "https://fantasyxi.io",
  });

  const edKeyPair = crypto.generateKeyPairSync("ed25519");
  const privPem = edKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = edKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  const regOpts = service.generateRegistrationOptions({
    userId: "user-2",
    email: "bob@fantasyxi.io",
    nowMs: 2_000_000,
  });

  service.verifyRegistrationResponse({
    userId: "user-2",
    nowMs: 2_001_000,
    response: {
      id: "cred-clone-test",
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(
          Buffer.from(
            JSON.stringify({
              type: "webauthn.create",
              challenge: regOpts.challenge,
              origin: "https://fantasyxi.io",
            })
          )
        ),
        authenticatorData: toBase64Url(
          buildAuthenticatorData({ rpId: "fantasyxi.io", counter: 50, userPresent: true })
        ),
        publicKeyPem: pubPem,
      },
    },
  });

  // Duplicate credential ID registration must fail
  assert.throws(
    () =>
      service.verifyRegistrationResponse({
        userId: "user-2",
        response: {
          id: "cred-clone-test",
          type: "public-key",
          response: {
            clientDataJSON: "",
            authenticatorData: "",
            publicKeyPem: pubPem,
          },
        },
      }),
    AuthConflictError
  );

  // Valid login advancing counter to 55
  const authOpts1 = service.generateAuthenticationOptions({
    userId: "user-2",
    nowMs: 2_010_000,
  });

  const validAssertion = createTestAssertion({
    credentialId: "cred-clone-test",
    challenge: authOpts1.challenge,
    origin: "https://fantasyxi.io",
    rpId: "fantasyxi.io",
    counter: 55,
    privateKeyPem: privPem,
    algorithm: "Ed25519",
  });

  service.verifyAuthenticationResponse({
    response: validAssertion,
    nowMs: 2_012_000,
  });

  // Replay attack using same assertion / challenge must fail
  assert.throws(
    () =>
      service.verifyAuthenticationResponse({
        response: validAssertion,
        nowMs: 2_013_000,
      }),
    AuthUnauthorizedError
  );

  // Cloned authenticator presenting counter = 52 (<= 55) must fail and flag credential compromised
  const authOpts2 = service.generateAuthenticationOptions({
    userId: "user-2",
    nowMs: 2_020_000,
  });

  const clonedAssertion = createTestAssertion({
    credentialId: "cred-clone-test",
    challenge: authOpts2.challenge,
    origin: "https://fantasyxi.io",
    rpId: "fantasyxi.io",
    counter: 52, // regression!
    privateKeyPem: privPem,
    algorithm: "Ed25519",
  });

  assert.throws(
    () =>
      service.verifyAuthenticationResponse({
        response: clonedAssertion,
        nowMs: 2_021_000,
      }),
    /counter regression detected/i
  );

  const stored = service.listUserCredentials("user-2")[0];
  assert.equal(stored.compromised, true);
});
