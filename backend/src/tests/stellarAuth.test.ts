import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Account, Keypair, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { StellarAuthService } from "../services/auth/stellarAuthService.js";
import { AuthService } from "../services/auth/authService.js";

const PASSPHRASE = Networks.TESTNET;
const HOME = "fantasyxi.test";
const server = Keypair.random();

function makeService(overrides: Record<string, unknown> = {}) {
  return new StellarAuthService({
    redis: null,
    config: {
      serverSecret: server.secret(),
      homeDomain: HOME,
      webAuthDomain: HOME,
      networkPassphrase: PASSPHRASE,
      challengeTtlSeconds: 300,
      ...overrides,
    },
  });
}

function sign(xdr: string, kp: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
  tx.sign(kp);
  return tx.toXDR();
}

describe("SEP-0010 stellar auth service", () => {
  let service: StellarAuthService;
  let client: Keypair;

  beforeEach(() => {
    service = makeService();
    client = Keypair.random();
  });

  it("issues a server-signed challenge and accepts the client-signed result", async () => {
    const challenge = await service.createChallenge(client.publicKey());
    assert.equal(challenge.networkPassphrase, PASSPHRASE);
    // The challenge is a sequence-0 transaction signed by the server
    const parsed = WebAuth.readChallengeTx(challenge.transaction, server.publicKey(), PASSPHRASE, HOME, HOME);
    assert.equal(parsed.clientAccountID, client.publicKey());
    assert.equal(parsed.tx.sequence, "0");

    const result = await service.verifyChallenge(sign(challenge.transaction, client));
    assert.equal(result.account, client.publicKey());
  });

  it("rejects an invalid account when requesting a challenge", async () => {
    await assert.rejects(service.createChallenge("not-a-key"), { statusCode: 400 });
    await assert.rejects(service.createChallenge(undefined), { statusCode: 400 });
  });

  it("is unavailable (503) when the server signing key is not configured", async () => {
    const unconfigured = makeService({ serverSecret: undefined });
    await assert.rejects(unconfigured.createChallenge(client.publicKey()), { statusCode: 503 });
  });

  it("rejects an unsigned challenge", async () => {
    const challenge = await service.createChallenge(client.publicKey());
    await assert.rejects(service.verifyChallenge(challenge.transaction), { statusCode: 401 });
  });

  it("rejects a challenge signed by a different key", async () => {
    const challenge = await service.createChallenge(client.publicKey());
    await assert.rejects(service.verifyChallenge(sign(challenge.transaction, Keypair.random())), { statusCode: 401 });
  });

  it("rejects an expired challenge", async () => {
    // Built with an already-elapsed window
    const expiredService = makeService({ challengeTtlSeconds: 1 });
    const challenge = await expiredService.createChallenge(client.publicKey());
    const signed = sign(challenge.transaction, client);
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;
    try {
      await assert.rejects(expiredService.verifyChallenge(signed), { statusCode: 401 });
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects a tampered challenge (altered after the server signed it)", async () => {
    const challenge = await service.createChallenge(client.publicKey());
    const original = TransactionBuilder.fromXDR(challenge.transaction, PASSPHRASE);
    // Rebuild a different transaction and splice in the server's original signature
    const forged = new TransactionBuilder(new Account(client.publicKey(), "-1"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: "forged-nonce", source: client.publicKey() }))
      .setTimeout(300)
      .build();
    forged.signatures.push(original.signatures[0]);
    forged.sign(client);
    await assert.rejects(service.verifyChallenge(forged.toXDR()), { statusCode: 401 });
  });

  it("rejects a challenge signed by an attacker's own server key", async () => {
    const rogue = Keypair.random();
    const rogueXdr = WebAuth.buildChallengeTx(rogue, client.publicKey(), HOME, 300, PASSPHRASE, HOME);
    await assert.rejects(service.verifyChallenge(sign(rogueXdr, client)), { statusCode: 401 });
  });

  it("rejects a challenge for another home domain", async () => {
    const other = WebAuth.buildChallengeTx(server, client.publicKey(), "evil.test", 300, PASSPHRASE, HOME);
    await assert.rejects(service.verifyChallenge(sign(other, client)), { statusCode: 401 });
  });

  it("rejects a validly signed challenge this server never issued", async () => {
    const xdr = WebAuth.buildChallengeTx(server, client.publicKey(), HOME, 300, PASSPHRASE, HOME);
    await assert.rejects(service.verifyChallenge(sign(xdr, client)), { statusCode: 401 });
  });

  it("consumes the nonce: a signed challenge cannot be replayed", async () => {
    const challenge = await service.createChallenge(client.publicKey());
    const signed = sign(challenge.transaction, client);
    await service.verifyChallenge(signed);
    await assert.rejects(service.verifyChallenge(signed), { statusCode: 401 });
  });

  it("rejects missing or oversized input", async () => {
    await assert.rejects(service.verifyChallenge(undefined), { statusCode: 400 });
    await assert.rejects(service.verifyChallenge(""), { statusCode: 400 });
    await assert.rejects(service.verifyChallenge("A".repeat(30_000)), { statusCode: 400 });
    await assert.rejects(service.verifyChallenge("not-xdr"), { statusCode: 401 });
  });
});

describe("AuthService.loginWithStellarAccount", () => {
  const user = {
    id: "user-1",
    email: "a@b.co",
    username: "admin1",
    role: "ADMIN",
    passwordHash: null,
    googleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("issues a session for the user who owns the wallet, with their role", async () => {
    const issued: any[] = [];
    const db: any = {
      wallet: {
        findUnique: async ({ where }: any) => (where.stellarAddress === "GKNOWN" ? { stellarAddress: "GKNOWN", user } : null),
      },
      refreshToken: { create: async (a: any) => (issued.push(a), a.data), updateMany: async () => ({}) },
      user: { findUnique: async () => user },
    };
    const svc = new AuthService(db);
    // Avoid exercising refresh-token persistence internals: stub the issuer
    (svc as any).issueAuthResult = async (u: any) => ({ user: { id: u.id, role: u.role }, token: "jwt" });
    const result: any = await svc.loginWithStellarAccount("GKNOWN", { ip: "127.0.0.1" });
    assert.equal(result.token, "jwt");
    assert.equal(result.user.role, "ADMIN");
    await assert.rejects(svc.loginWithStellarAccount("GUNKNOWN"), { name: "AuthUnauthorizedError" });
  });
});

describe("SEP-0010 HTTP endpoints", () => {
  it("serves the challenge and answers 401 for a tampered verification", async () => {
    const { stellarAuthService } = await import("../services/auth/stellarAuthService.js");
    const { getStellarChallenge, verifyStellarChallenge } = await import("../controllers/auth.controller.js");
    process.env.SEP10_SERVER_SIGNING_KEY = server.secret();
    process.env.SEP10_HOME_DOMAIN = HOME;

    const app = express();
    app.use(express.json());
    app.get("/stellar/challenge", getStellarChallenge);
    app.post("/stellar/verify", verifyStellarChallenge);
    const http = app.listen(0);
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    try {
      const client = Keypair.random();

      const bad = await fetch(`${base}/stellar/challenge?account=nope`);
      assert.equal(bad.status, 400);

      const ok = await fetch(`${base}/stellar/challenge?account=${client.publicKey()}`);
      assert.equal(ok.status, 200);
      const body: any = await ok.json();
      assert.ok(body.data.transaction);

      // Unsigned / altered transaction => 401
      const unsigned = await fetch(`${base}/stellar/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: body.data.transaction }),
      });
      assert.equal(unsigned.status, 401);

      const missing = await fetch(`${base}/stellar/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400);
      void stellarAuthService;
    } finally {
      http.close();
    }
  });
});
