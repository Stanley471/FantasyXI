import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SettlementWebhookPipeline,
  generateSettlementIdempotencyKey,
  calculateBackoffWithJitter,
  SettlementConfirmationPayload,
} from "../services/webhooks/settlementWebhookPipeline.js";
import { verifyWebhookSignature } from "../services/webhooks/webhookSigner.js";
import { WebhookEndpoint } from "../services/webhooks/webhookDispatcher.js";

describe("Idempotent Webhook Dispatch Pipeline for Settlement Confirmations (#338)", () => {
  let endpoint: WebhookEndpoint;
  let samplePayload: SettlementConfirmationPayload;

  beforeEach(() => {
    endpoint = {
      id: "ep_settlement_test",
      url: "https://auditor.example.com/webhooks/settlements",
      secret: "whsec_super_secret_settlement_signing_key_999",
      userId: "auditor-user-1",
      events: ["league.settled"],
      isActive: true,
    };

    samplePayload = {
      leagueId: "league-premier-2026",
      gameweekId: 38,
      settlementKey: "settle_stellar_tx_998877",
      payoutTxHash: "4444ffff4444ffff4444ffff4444ffff4444ffff4444ffff4444ffff4444ffff",
      totalPrizeDistributed: "25000.00",
      timestamp: new Date().toISOString(),
    };
  });

  describe("Deterministic Idempotency Key Generation", () => {
    it("generates deterministic SHA-256 idempotency key from leagueId, gameweekId, and settlementKey", () => {
      const key1 = generateSettlementIdempotencyKey("league-1", 10, "settle-key-1");
      const key2 = generateSettlementIdempotencyKey("league-1", 10, "settle-key-1");
      const keyDifferent = generateSettlementIdempotencyKey("league-1", 11, "settle-key-1");

      assert.equal(key1, key2);
      assert.notEqual(key1, keyDifferent);
      assert.equal(key1.length, 64, "Key should be 64-char sha256 hex");
    });
  });

  describe("Duplicate Settlement Deduplication Window", () => {
    it("generates exactly ONE HTTP delivery for duplicate settlement events within the dedup window", async () => {
      let httpCallCount = 0;
      const pipeline = new SettlementWebhookPipeline({
        dedupWindowMs: 60_000,
        httpFetch: async () => {
          httpCallCount++;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      // Dispatch initial settlement event
      const delivery1 = await pipeline.dispatchSettlement(endpoint, samplePayload);
      assert.equal(delivery1.status, "DELIVERED");
      assert.equal(httpCallCount, 1);

      // Immediately attempt duplicate dispatches with identical settlement parameters
      const delivery2 = await pipeline.dispatchSettlement(endpoint, samplePayload);
      const delivery3 = await pipeline.dispatchSettlement(endpoint, samplePayload);

      // Verify no duplicate HTTP calls were made
      assert.equal(httpCallCount, 1, "Duplicate events must not produce additional HTTP requests");
      assert.equal(delivery2.id, delivery1.id);
      assert.equal(delivery3.id, delivery1.id);
      assert.equal(delivery2.status, "DELIVERED");
    });
  });

  describe("Verifiable Cryptographic Signatures & Headers", () => {
    it("includes verifiable HMAC-SHA256 signature and idempotency key headers in dispatch", async () => {
      let capturedHeaders: Headers | null = null;
      let capturedBody: string | null = null;

      const pipeline = new SettlementWebhookPipeline({
        httpFetch: async (_url, init) => {
          capturedHeaders = new Headers(init.headers);
          capturedBody = init.body as string;
          return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
        },
      });

      const delivery = await pipeline.dispatchSettlement(endpoint, samplePayload);
      assert.equal(delivery.status, "DELIVERED");
      assert.ok(capturedHeaders);

      const sigHeader = capturedHeaders.get("X-FantasyXI-Signature");
      const idempotencyHeader = capturedHeaders.get("X-FantasyXI-Idempotency-Key");
      const eventHeader = capturedHeaders.get("X-FantasyXI-Event");
      const deliveryHeader = capturedHeaders.get("X-FantasyXI-Delivery");

      assert.ok(sigHeader, "X-FantasyXI-Signature header must be present");
      assert.equal(eventHeader, "league.settled");
      assert.equal(idempotencyHeader, delivery.idempotencyKey);
      assert.equal(deliveryHeader, delivery.id);

      // Verify the cryptographic HMAC signature against the received body and secret
      const parsedBody = JSON.parse(capturedBody!);
      const verification = verifyWebhookSignature(parsedBody, sigHeader, endpoint.secret);
      assert.equal(verification.valid, true, "Webhook HMAC signature must be valid");
    });
  });

  describe("Exponential Backoff, Jitter & Dead-Letter Queue (DLQ)", () => {
    it("calculates exponential backoff with jitter bounded within maxDelayMs", () => {
      assert.equal(calculateBackoffWithJitter(1, 1000, 60000, false), 0);
      assert.equal(calculateBackoffWithJitter(2, 1000, 60000, false), 1000);
      assert.equal(calculateBackoffWithJitter(3, 1000, 60000, false), 2000);
      assert.equal(calculateBackoffWithJitter(4, 1000, 60000, false), 4000);

      // Jitter test
      for (let i = 0; i < 20; i++) {
        const jittered = calculateBackoffWithJitter(3, 1000, 60000, true);
        assert.ok(jittered >= 0 && jittered <= 2000, `Jittered delay ${jittered} should be between 0 and 2000`);
      }
    });

    it("retries failed attempts with backoff and isolates permanently failing deliveries in DLQ", async () => {
      let attemptsCount = 0;
      const pipeline = new SettlementWebhookPipeline({
        maxAttempts: 3,
        initialDelayMs: 200,
        jitter: false,
        httpFetch: async () => {
          attemptsCount++;
          return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
        },
      });

      const delivery = await pipeline.dispatchSettlement(endpoint, samplePayload);
      assert.equal(delivery.status, "FAILED");
      assert.equal(delivery.attemptCount, 1);
      assert.equal(delivery.attempts.length, 1);
      assert.equal(delivery.attempts[0].statusCode, 503);
      assert.ok(delivery.nextRetryAt !== null);

      // Execute attempt 2
      await pipeline.executeAttempt(delivery, endpoint);
      assert.equal(delivery.status, "FAILED");
      assert.equal(delivery.attemptCount, 2);

      // Execute attempt 3 (exhausts maxAttempts)
      await pipeline.executeAttempt(delivery, endpoint);
      assert.equal(delivery.status, "DEAD_LETTER");
      assert.equal(delivery.attemptCount, 3);
      assert.equal(delivery.nextRetryAt, null);

      // Verify in DLQ
      const dlq = pipeline.getDeadLetterQueue();
      assert.equal(dlq.length, 1);
      assert.equal(dlq[0].id, delivery.id);
      assert.equal(dlq[0].status, "DEAD_LETTER");
    });
  });

  describe("Flaky Receiver & Network Partition Recovery Simulation", () => {
    it("recovers and marks DELIVERED when flaky receiver endpoint recovers on retry", async () => {
      let callIndex = 0;
      const pipeline = new SettlementWebhookPipeline({
        maxAttempts: 4,
        httpFetch: async () => {
          callIndex++;
          if (callIndex === 1) {
            // Simulated network partition / timeout
            throw new Error("ETIMEDOUT: Connection timed out to receiver");
          }
          if (callIndex === 2) {
            // Flaky receiver internal error
            return new Response("502 Bad Gateway", { status: 502, statusText: "Bad Gateway" });
          }
          // Receiver recovers
          return new Response(JSON.stringify({ settlementRecorded: true }), { status: 200 });
        },
      });

      const delivery = await pipeline.dispatchSettlement(endpoint, samplePayload);
      assert.equal(delivery.status, "FAILED");
      assert.equal(delivery.attempts[0].error, "ETIMEDOUT: Connection timed out to receiver");

      // Retry 1: returns 502
      await pipeline.executeAttempt(delivery, endpoint);
      assert.equal(delivery.status, "FAILED");
      assert.equal(delivery.attempts[1].statusCode, 502);

      // Retry 2: recovers with 200
      await pipeline.executeAttempt(delivery, endpoint);
      assert.equal(delivery.status, "DELIVERED");
      assert.equal(delivery.attemptCount, 3);
      assert.ok(delivery.deliveredAt instanceof Date);
    });

    it("supports manual replay of DLQ delivery with fresh signature and original payload", async () => {
      let receiverOnline = false;
      let lastSignature = "";

      const pipeline = new SettlementWebhookPipeline({
        maxAttempts: 2,
        httpFetch: async (_url, init) => {
          lastSignature = (init.headers as any)["X-FantasyXI-Signature"];
          if (!receiverOnline) {
            return new Response("Offline", { status: 500 });
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        },
      });

      const delivery = await pipeline.dispatchSettlement(endpoint, samplePayload);
      await pipeline.executeAttempt(delivery, endpoint);
      assert.equal(delivery.status, "DEAD_LETTER");

      // Auditor fixes downstream endpoint
      receiverOnline = true;

      // Replay dead-letter delivery
      const replayed = await pipeline.retryDelivery(delivery.id);
      assert.equal(replayed.status, "DELIVERED");
      assert.equal(replayed.attemptCount, 3);
      assert.deepEqual(replayed.payload.leagueId, samplePayload.leagueId);

      // Validate replayed HMAC signature
      const verification = verifyWebhookSignature(replayed.payload, lastSignature, endpoint.secret);
      assert.equal(verification.valid, true);
    });
  });
});
