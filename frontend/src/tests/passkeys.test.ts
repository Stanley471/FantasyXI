import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  isMfaChallenge,
  serializeAssertion,
  serializeRegistration,
  toCreationOptions,
  toRequestOptions,
} from "../lib/passkeys";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe("Passkey browser helpers (issue #273)", () => {
  it("round-trips base64url without padding or unsafe characters", () => {
    const raw = bytes(0xfb, 0xff, 0xbf, 0x00, 0x01);
    const encoded = bufferToBase64Url(raw);
    assert.equal(encoded, "-_-_AAE");
    assert.deepEqual(new Uint8Array(base64UrlToBuffer(encoded)), new Uint8Array(raw));
    assert.deepEqual(new Uint8Array(base64UrlToBuffer("AQ")), new Uint8Array([1]));
  });

  it("decodes server creation options into binary fields for navigator.credentials.create", () => {
    const options = toCreationOptions({
      challenge: "AAEC",
      rp: { id: "fantasyxi.app", name: "FantasyXI" },
      user: { id: "dXNlcg", name: "alice@example.com", displayName: "Alice" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ id: "AQID", type: "public-key", transports: ["usb"] }],
    });
    assert.deepEqual(new Uint8Array(options.challenge as ArrayBuffer), new Uint8Array([0, 1, 2]));
    assert.equal(new TextDecoder().decode(options.user.id as ArrayBuffer), "user");
    assert.deepEqual(new Uint8Array(options.excludeCredentials![0].id as ArrayBuffer), new Uint8Array([1, 2, 3]));
    assert.deepEqual(options.excludeCredentials![0].transports, ["usb"]);
  });

  it("decodes request options and defaults to discoverable credentials", () => {
    const options = toRequestOptions({ challenge: "AAEC", rpId: "fantasyxi.app", userVerification: "required" });
    assert.deepEqual(options.allowCredentials, []);
    assert.equal(options.userVerification, "required");
  });

  it("serializes registration and assertion credentials to JSON", () => {
    const base = {
      id: "AQID",
      rawId: bytes(1, 2, 3),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
    };
    const registration = serializeRegistration({
      ...base,
      response: {
        clientDataJSON: bytes(123, 125),
        attestationObject: bytes(0xa0),
        getTransports: () => ["internal"],
      },
    } as unknown as PublicKeyCredential);
    assert.deepEqual(registration.response, { clientDataJSON: "e30", attestationObject: "oA", transports: ["internal"] });
    assert.equal(registration.rawId, "AQID");

    const assertion = serializeAssertion({
      ...base,
      response: {
        clientDataJSON: bytes(123, 125),
        authenticatorData: bytes(9),
        signature: bytes(8),
        userHandle: null,
      },
    } as unknown as PublicKeyCredential);
    assert.deepEqual(assertion.response, {
      clientDataJSON: "e30",
      authenticatorData: "CQ",
      signature: "CA",
      userHandle: undefined,
    });
  });

  it("recognizes a passkey step-up response from password login", () => {
    assert.equal(isMfaChallenge({ mfaRequired: true, mfaToken: "t", methods: ["passkey"] }), true);
    assert.equal(isMfaChallenge({ token: "jwt", user: {} }), false);
    assert.equal(isMfaChallenge(undefined), false);
  });
});
