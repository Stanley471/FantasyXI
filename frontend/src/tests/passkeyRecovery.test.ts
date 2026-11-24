import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createRecoveryPhrase, signRecoveryChallenge } from "../lib/passkeyRecovery.js";

const decode = (value: string) => Buffer.from(value, "base64url");

describe("Passkey recovery phrase proof", () => {
  it("creates a valid BIP-39 phrase whose key signs a server challenge", () => {
    const recovery = createRecoveryPhrase();
    assert.equal(recovery.mnemonic.split(" ").length, 12);
    const challenge = Buffer.alloc(32, 42).toString("base64url");
    const signature = signRecoveryChallenge(recovery.mnemonic, challenge);
    assert.equal(ed25519.verify(decode(signature), decode(challenge), decode(recovery.publicKey)), true);
  });

  it("rejects an incomplete or invalid phrase before making a recovery request", () => {
    assert.throws(() => signRecoveryChallenge("not a valid recovery phrase", "dGVzdA"), /complete 12-word/i);
  });
});
