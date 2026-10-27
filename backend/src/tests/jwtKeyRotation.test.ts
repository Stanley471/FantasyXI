import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { JwtKeyRing, generateSigningKeyPair } from "../services/auth/jwtKeyRing.js";
import {
  JwtKeyRotationService,
  JwtKeyStore,
  JwtKeyRecord,
  JwtKeyEvent,
  JwtKeyEventChannel,
  encryptPrivateKey,
  decryptPrivateKey,
} from "../services/auth/jwtKeyRotationService.js";
import { jwtKeyRing, signAccessToken } from "../config/jwt.js";
import { requireAuth } from "../middleware/authMiddleware.js";

/**
 * Issue #332: asymmetric JWT signing keys with pre-published successors,
 * grace windows for the previous key, and cluster-wide revocation.
 */

const HOUR = 60 * 60_000;
const ROTATION_INTERVAL = 24 * HOUR;
const TOKEN_LIFETIME_SECONDS = 2 * 60 * 60;
const SECRET = "test-key-encryption-secret-at-least-32-characters";

class MemoryJwtKeyStore implements JwtKeyStore {
  rows = new Map<string, JwtKeyRecord>();
  listCalls = 0;
  /** When set, listUsable waits for it, to interleave a refresh with a revocation. */
  gate: Promise<void> | null = null;

  async listUsable(now: Date): Promise<JwtKeyRecord[]> {
    this.listCalls++;
    const snapshot = [...this.rows.values()]
      .filter((r) => !r.revokedAt && (!r.retiresAt || r.retiresAt > now))
      .map((r) => ({ ...r }));
    if (this.gate) await this.gate;
    return snapshot;
  }
  async find(kid: string) {
    const row = this.rows.get(kid);
    return row ? { ...row } : null;
  }
  async insert(record: JwtKeyRecord) {
    this.rows.set(record.kid, { ...record });
  }
  async setRetiresAt(kids: string[], retiresAt: Date) {
    for (const kid of kids) this.rows.get(kid)!.retiresAt = retiresAt;
  }
  async revoke(kid: string, revokedAt: Date) {
    this.rows.get(kid)!.revokedAt = revokedAt;
  }
  async prune(now: Date) {
    let count = 0;
    for (const [kid, row] of this.rows) {
      if (row.retiresAt && row.retiresAt <= now) {
        this.rows.delete(kid);
        count++;
      }
    }
    return count;
  }
}

/** Synchronous fan-out standing in for Redis pub/sub between nodes. */
class MemoryHub {
  private handlers: Array<(event: JwtKeyEvent) => void> = [];
  channel(): JwtKeyEventChannel {
    return {
      publish: async (event) => this.handlers.forEach((handler) => handler(event)),
      subscribe: async (handler) => {
        this.handlers.push(handler);
      },
      close: async () => {},
    };
  }
}

function createNode(store: JwtKeyStore, clock: { now: number }, channel: JwtKeyEventChannel | null = null, ring?: JwtKeyRing) {
  const nodeRing = ring ?? new JwtKeyRing({ now: () => clock.now });
  const service = new JwtKeyRotationService({
    store,
    ring: nodeRing,
    channel,
    now: () => clock.now,
    rotationIntervalMs: ROTATION_INTERVAL,
    tokenLifetimeSeconds: () => TOKEN_LIFETIME_SECONDS,
    encryptionSecret: () => SECRET,
  });
  return { ring: nodeRing, service };
}

const signedKid = (token: string) => (jwt.decode(token, { complete: true })!.header.kid as string);

describe("JwtKeyRing (#332)", () => {
  it("signs ES256 tokens carrying the kid of the active key and publishes only public material", async () => {
    const clock = { now: Date.now() };
    const { ring, service } = createNode(new MemoryJwtKeyStore(), clock);
    await service.start();

    const token = ring.sign({ userId: "u1" }, "1h");
    const header = jwt.decode(token, { complete: true })!.header;
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, ring.currentSigningKey()!.kid);
    assert.equal(ring.verify(token).userId, "u1");

    const { keys } = service.getJwks();
    assert.equal(keys.length, 1);
    assert.deepEqual(Object.keys(keys[0]).sort(), ["alg", "crv", "kid", "kty", "use", "x", "y"]);
    assert.equal(keys[0].kty, "EC");
    assert.equal(keys[0].crv, "P-256");
    assert.equal(keys[0].use, "sig");
    await service.stop();
  });

  it("rejects algorithm confusion: an HS256 token naming a valid kid", async () => {
    const clock = { now: Date.now() };
    const { ring, service } = createNode(new MemoryJwtKeyStore(), clock);
    await service.start();
    const kid = ring.currentSigningKey()!.kid;
    const forged = jwt.sign({ userId: "attacker" }, "guessable", { algorithm: "HS256", keyid: kid });
    assert.throws(() => ring.verify(forged), jwt.JsonWebTokenError);
    await service.stop();
  });

  it("accepts legacy kid-less HS256 tokens only while the migration window is open", () => {
    let legacy: string | null = SECRET;
    const ring = new JwtKeyRing({ legacySecret: () => legacy, allowEphemeralKeys: true });
    const legacyToken = jwt.sign({ userId: "legacy" }, SECRET, { algorithm: "HS256", expiresIn: "1h" });

    assert.equal(ring.verify(legacyToken).userId, "legacy");
    legacy = null;
    assert.throws(() => ring.verify(legacyToken), /legacy tokens are no longer accepted/);
  });

  it("encrypts private keys with the kid as authenticated data", () => {
    const { kid, privateKey } = generateSigningKeyPair();
    const sealed = encryptPrivateKey(privateKey, kid, SECRET);
    const opened = decryptPrivateKey(sealed, kid, SECRET);
    assert.deepEqual(
      opened.export({ format: "der", type: "pkcs8" }),
      privateKey.export({ format: "der", type: "pkcs8" })
    );
    assert.throws(() => decryptPrivateKey(sealed, "another-kid", SECRET));
    assert.throws(() => decryptPrivateKey(sealed, kid, "a-different-secret-of-sufficient-length!!"));
  });
});

describe("JwtKeyRotationService (#332)", () => {
  it("pre-publishes the successor before it signs, then switches without a shared clock tick", async () => {
    const clock = { now: Date.now() };
    const { ring, service } = createNode(new MemoryJwtKeyStore(), clock);
    await service.start();
    const firstKid = ring.currentSigningKey()!.kid;

    clock.now += 2 * HOUR; // not yet due
    assert.equal((await service.rotate()).createdKid, null);

    clock.now += ROTATION_INTERVAL; // due
    const { createdKid } = await service.rotate();
    assert.ok(createdKid);
    assert.equal(ring.currentSigningKey()!.kid, firstKid, "successor must not sign before it activates");
    assert.deepEqual(
      service.getJwks().keys.map((k) => k.kid).sort(),
      [firstKid, createdKid].sort(),
      "successor is published in the JWKS ahead of activation"
    );

    clock.now += 5 * 60_000; // pre-publication lead time elapsed
    assert.equal(ring.currentSigningKey()!.kid, createdKid);
    await service.stop();
  });

  it("keeps verifying the previous key's tokens until its grace window ends, then prunes it", async () => {
    const clock = { now: Date.now() };
    const store = new MemoryJwtKeyStore();
    const { ring, service } = createNode(store, clock);
    await service.start();
    const oldToken = ring.sign({ userId: "u1" }, "7d");
    const oldKid = signedKid(oldToken);

    clock.now += ROTATION_INTERVAL;
    await service.rotate();
    clock.now += 5 * 60_000;
    assert.notEqual(ring.currentSigningKey()!.kid, oldKid);
    assert.equal(ring.verify(oldToken).userId, "u1", "old token survives the rollover");

    const retiresAt = store.rows.get(oldKid)!.retiresAt!.getTime();
    assert.equal(retiresAt, clock.now + TOKEN_LIFETIME_SECONDS * 1000 + 60_000);

    clock.now = retiresAt - 1;
    assert.equal(ring.verify(oldToken).userId, "u1");
    clock.now = retiresAt;
    assert.throws(() => ring.verify(oldToken), /retired/);

    const { pruned } = await service.rotate();
    assert.equal(pruned, 1);
    assert.equal(store.rows.has(oldKid), false);
    await service.stop();
  });

  it("revocation fails verification on every node immediately and installs a replacement key", async () => {
    const clock = { now: Date.now() };
    const store = new MemoryJwtKeyStore();
    const hub = new MemoryHub();
    const nodeA = createNode(store, clock, hub.channel());
    const nodeB = createNode(store, clock, hub.channel());
    await nodeA.service.start();
    await nodeB.service.start();

    const token = nodeA.ring.sign({ userId: "u1" }, "1h");
    assert.equal(nodeB.ring.verify(token).userId, "u1");

    const result = await nodeA.service.revoke(signedKid(token), "leaked in CI logs");
    assert.ok(result?.replacementKid, "revoking the signing key creates a replacement");

    assert.throws(() => nodeA.ring.verify(token), /unknown or revoked/);
    assert.throws(() => nodeB.ring.verify(token), /unknown or revoked/);

    await nodeB.service.refresh();
    const fresh = nodeA.ring.sign({ userId: "u1" }, "1h");
    assert.equal(signedKid(fresh), result.replacementKid);
    assert.equal(nodeB.ring.verify(fresh).userId, "u1");

    assert.equal(await nodeA.service.revoke("no-such-kid", "typo"), null);
    await nodeA.service.stop();
    await nodeB.service.stop();
  });

  it("a refresh that read the store before a revocation cannot resurrect the revoked key", async () => {
    const clock = { now: Date.now() };
    const store = new MemoryJwtKeyStore();
    const hub = new MemoryHub();
    const nodeA = createNode(store, clock, hub.channel());
    const nodeB = createNode(store, clock, hub.channel());
    await nodeA.service.start();
    await nodeB.service.start();
    const kid = nodeA.ring.currentSigningKey()!.kid;

    let release!: () => void;
    store.gate = new Promise((resolve) => (release = resolve));
    const staleRefresh = nodeB.service.refresh(); // reads the key as usable, then waits
    await new Promise((resolve) => setImmediate(resolve));

    store.gate = null;
    await nodeA.service.revoke(kid, "compromised");
    release();
    await staleRefresh;

    assert.equal(nodeB.ring.has(kid), false);
    await nodeA.service.stop();
    await nodeB.service.stop();
  });

  it("refreshes once when tokens name an unknown kid, so random kids cannot flood the database", async () => {
    const clock = { now: Date.now() };
    const store = new MemoryJwtKeyStore();
    const nodeA = createNode(store, clock);
    const nodeB = createNode(store, clock);
    await nodeB.service.start();
    await nodeA.service.start();
    // nodeA created no key (nodeB did); force a key nodeB has not loaded yet
    clock.now += ROTATION_INTERVAL + 5 * 60_000;
    await nodeA.service.rotate();
    clock.now += 5 * 60_000;
    await nodeA.service.refresh();
    const token = nodeA.ring.sign({ userId: "u1" }, "1h");

    const callsBefore = store.listCalls;
    assert.throws(() => nodeB.ring.verify(token));
    for (let i = 0; i < 100; i++) {
      const bogus = jwt.sign({}, crypto.randomBytes(8).toString("hex"), { algorithm: "HS256", keyid: `random-${i}` });
      assert.throws(() => nodeB.ring.verify(bogus));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.listCalls - callsBefore, 1);
    assert.equal(nodeB.ring.verify(token).userId, "u1");
    await nodeA.service.stop();
    await nodeB.service.stop();
  });
});

describe("Key rollover through the auth middleware (#332 integration)", () => {
  // jwtKeyRing checks retirement against the real clock, so the service uses it too
  const clock = {
    get now() {
      return Date.now();
    },
  };
  const store = new MemoryJwtKeyStore();
  // Drive the process-wide ring used by requireAuth, as the server does
  const { service } = createNode(store, clock, null, jwtKeyRing);
  const app = express();
  app.get("/me", requireAuth, (req, res) => {
    res.json({ id: req.user!.id });
  });

  after(() => service.stop());

  it("validates in-flight requests across an automated rotation, then expires and revokes cleanly", async () => {
    jwtKeyRing.replaceAll([]);
    await service.start();

    const before = signAccessToken({ userId: "manager-1" });
    const inFlight = Array.from({ length: 40 }, () =>
      request(app).get("/me").set("Authorization", `Bearer ${before}`)
    );
    // Rotate while the requests are being served: the successor is created
    // already active by pretending the current key is long overdue.
    const firstKid = signedKid(before);
    store.rows.get(firstKid)!.activatesAt = new Date(Date.now() - ROTATION_INTERVAL - 10 * 60_000);
    const rotation = service.rotate().then(async () => {
      const successor = [...store.rows.values()].find((r) => r.kid !== firstKid)!;
      successor.activatesAt = new Date(Date.now() - 1_000);
      await service.refresh();
    });
    const responses = await Promise.all([...inFlight, rotation]);
    for (const res of responses.slice(0, inFlight.length) as request.Response[]) {
      assert.equal(res.status, 200);
      assert.equal(res.body.id, "manager-1");
    }

    const rotated = signAccessToken({ userId: "manager-1" });
    assert.notEqual(signedKid(rotated), firstKid, "new sessions use the successor");
    await request(app).get("/me").set("Authorization", `Bearer ${before}`).expect(200);
    await request(app).get("/me").set("Authorization", `Bearer ${rotated}`).expect(200);

    // Grace window over: the previous key's tokens stop working
    store.rows.get(firstKid)!.retiresAt = new Date(Date.now() - 1);
    await service.refresh();
    await request(app).get("/me").set("Authorization", `Bearer ${before}`).expect(401);

    // Revocation: immediate 401 for the revoked key's tokens
    await service.revoke(signedKid(rotated), "suspected leak");
    await request(app).get("/me").set("Authorization", `Bearer ${rotated}`).expect(401);
    const replacement = signAccessToken({ userId: "manager-1" });
    await request(app).get("/me").set("Authorization", `Bearer ${replacement}`).expect(200);
  });
});
