import test from "node:test";
import assert from "node:assert/strict";
import {
  signInternalWebhook,
  verifyInternalWebhook,
  verifySignatureOnly,
  inMemoryNonceStore,
} from "../services/webhooks/internalWebhookSigner.js";
import { createInternalWebhookAuth } from "../middleware/internalWebhookAuth.js";
import { type IRedisCacheClient } from "../config/redis.js";

test("Inter-Service Internal Webhook Auth & Replay Defense (Issue #356)", async (t) => {
  const primarySecret = "whsec_internal_primary_abcdef1234567890";
  const secondarySecret = "whsec_internal_secondary_0987654321fedcba";

  t.beforeEach(() => {
    inMemoryNonceStore.clear();
  });

  await t.test("Generates valid headers: X-Fantasy-Signature, X-Fantasy-Timestamp, X-Fantasy-Nonce", () => {
    const payload = { event: "player.transferred", playerId: 42, newClub: "Arsenal" };
    const signed = signInternalWebhook(payload, primarySecret);

    assert.ok(signed.signature, "Should generate signature");
    assert.equal(signed.signature.length, 64, "SHA-256 hex signature must be 64 characters");
    assert.ok(signed.timestamp > 0, "Timestamp must be positive");
    assert.ok(signed.nonce, "Nonce must be generated");
    assert.equal(signed.headers["X-Fantasy-Signature"], signed.signature);
    assert.equal(signed.headers["X-Fantasy-Timestamp"], String(signed.timestamp));
    assert.equal(signed.headers["X-Fantasy-Nonce"], signed.nonce);
  });

  await t.test("Successfully verifies valid payload with primary secret", async () => {
    const payload = { action: "RECALCULATE_LEAGUE", leagueId: "lg-123" };
    const signed = signInternalWebhook(payload, primarySecret);

    const result = await verifyInternalWebhook(payload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, { primarySecret, secondarySecret });

    assert.equal(result.valid, true);
    assert.equal(result.status, 200);
    assert.equal(result.usedSecret, "primary");
  });

  await t.test("Rejects missing headers with 401 Unauthorized", async () => {
    const payload = { foo: "bar" };

    const missingSig = await verifyInternalWebhook(payload, {
      timestamp: Math.floor(Date.now() / 1000),
      nonce: "nonce-1",
    }, primarySecret);
    assert.equal(missingSig.valid, false);
    assert.equal(missingSig.status, 401);

    const missingTimestamp = await verifyInternalWebhook(payload, {
      signature: "0123456789abcdef",
      nonce: "nonce-1",
    }, primarySecret);
    assert.equal(missingTimestamp.valid, false);
    assert.equal(missingTimestamp.status, 401);

    const missingNonce = await verifyInternalWebhook(payload, {
      signature: "0123456789abcdef",
      timestamp: Math.floor(Date.now() / 1000),
    }, primarySecret);
    assert.equal(missingNonce.valid, false);
    assert.equal(missingNonce.status, 401);
  });

  await t.test("Rejects timestamp exceeding 300s drift window with 401", async () => {
    const payload = { event: "game.completed" };
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredTimestamp = nowSec - 301; // 301 seconds ago

    const signed = signInternalWebhook(payload, primarySecret, {
      timestamp: expiredTimestamp,
    });

    const result = await verifyInternalWebhook(payload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, primarySecret, { toleranceSeconds: 300 });

    assert.equal(result.valid, false);
    assert.equal(result.status, 401);
    assert.match(result.error!, /clock drift exceeds 300 seconds/);
  });

  await t.test("Rejects future timestamp exceeding 300s drift window with 401", async () => {
    const payload = { event: "game.future" };
    const nowSec = Math.floor(Date.now() / 1000);
    const futureTimestamp = nowSec + 305;

    const signed = signInternalWebhook(payload, primarySecret, {
      timestamp: futureTimestamp,
    });

    const result = await verifyInternalWebhook(payload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, primarySecret, { toleranceSeconds: 300 });

    assert.equal(result.valid, false);
    assert.equal(result.status, 401);
  });

  await t.test("Rejects replayed nonce with 409 Conflict", async () => {
    const payload = { transferId: "tx-999" };
    const signed = signInternalWebhook(payload, primarySecret);

    // First attempt succeeds
    const firstResult = await verifyInternalWebhook(payload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, primarySecret);
    assert.equal(firstResult.valid, true);
    assert.equal(firstResult.status, 200);

    // Second attempt with exact same nonce triggers 409 Replay Defense
    const replayResult = await verifyInternalWebhook(payload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, primarySecret);
    assert.equal(replayResult.valid, false);
    assert.equal(replayResult.status, 409);
    assert.match(replayResult.error!, /Replay defense triggered/);
  });

  await t.test("Rejects tampered payload with 401 Unauthorized", async () => {
    const originalPayload = { points: 10, participantId: "part-1" };
    const signed = signInternalWebhook(originalPayload, primarySecret);

    // Attacker tampers points
    const tamperedPayload = { points: 999, participantId: "part-1" };

    const result = await verifyInternalWebhook(tamperedPayload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, primarySecret);

    assert.equal(result.valid, false);
    assert.equal(result.status, 401);
    assert.match(result.error!, /Cryptographic signature mismatch/);
  });

  await t.test("Supports dual active secret rotation (authenticates both primary and secondary)", async () => {
    const payload = { system: "scoring", action: "sync" };

    // Request signed with secondary secret
    const signedSecondary = signInternalWebhook(payload, secondarySecret);

    const result = await verifyInternalWebhook(payload, {
      signature: signedSecondary.signature,
      timestamp: signedSecondary.timestamp,
      nonce: signedSecondary.nonce,
    }, { primarySecret, secondarySecret });

    assert.equal(result.valid, true);
    assert.equal(result.status, 200);
    assert.equal(result.usedSecret, "secondary");
  });

  await t.test("Redis-backed nonce tracking checks atomic SET NX", async () => {
    const redisStorage = new Map<string, string>();
    const mockRedis: IRedisCacheClient = {
      async get(key: string) {
        return redisStorage.get(key) ?? null;
      },
      async set(key: string, value: string, mode?: any, duration?: any, flag?: any) {
        if (flag === "NX" || mode === "EX" && arguments[4] === "NX") {
          if (redisStorage.has(key)) return null;
          redisStorage.set(key, value);
          return "OK";
        }
        // handle options
        if (redisStorage.has(key)) return null;
        redisStorage.set(key, value);
        return "OK";
      },
      async del(...keys: string[]) {
        let count = 0;
        for (const k of keys) {
          if (redisStorage.delete(k)) count++;
        }
        return count;
      },
      async keys() {
        return Array.from(redisStorage.keys());
      },
    };

    const payload = { test: "redis" };
    const signed = signInternalWebhook(payload, primarySecret);

    const first = await verifyInternalWebhook(payload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, primarySecret, { redisClient: mockRedis });

    assert.equal(first.valid, true);
    assert.ok(redisStorage.has(`fantasy:webhook:nonce:${signed.nonce}`));

    // Replay should fail with 409
    const second = await verifyInternalWebhook(payload, {
      signature: signed.signature,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    }, primarySecret, { redisClient: mockRedis });

    assert.equal(second.valid, false);
    assert.equal(second.status, 409);
  });

  await t.test("Express middleware executes next() for valid and responds 401/409 on invalid", async () => {
    const middleware = createInternalWebhookAuth({
      secrets: { primarySecret, secondarySecret },
      toleranceSeconds: 300,
    });

    const payload = { user: "bob", balance: 50 };
    const signed = signInternalWebhook(payload, primarySecret);

    let nextCalled = false;
    let statusCode: number | null = null;
    let jsonBody: any = null;

    const mockReq: any = {
      headers: {
        "x-fantasy-signature": signed.signature,
        "x-fantasy-timestamp": String(signed.timestamp),
        "x-fantasy-nonce": signed.nonce,
      },
      body: payload,
    };

    const mockRes: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: any) {
        jsonBody = body;
        return this;
      },
    };

    await middleware(mockReq, mockRes, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.ok(mockReq.internalWebhook);
    assert.equal(mockReq.internalWebhook.verified, true);
    assert.equal(mockReq.internalWebhook.usedSecret, "primary");

    // Test replay through middleware
    let replayNextCalled = false;
    let replayStatusCode: number | null = null;
    let replayJsonBody: any = null;

    const replayRes: any = {
      status(code: number) {
        replayStatusCode = code;
        return this;
      },
      json(body: any) {
        replayJsonBody = body;
        return this;
      },
    };

    await middleware(mockReq, replayRes, () => {
      replayNextCalled = true;
    });

    assert.equal(replayNextCalled, false);
    assert.equal(replayStatusCode, 409);
    assert.match(replayJsonBody.message, /Replay/);
  });
});
