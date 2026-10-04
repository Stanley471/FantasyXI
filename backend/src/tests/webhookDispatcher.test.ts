import { describe, it } from "node:test";
import assert from "node:assert";
import { generateWebhookSignature, verifyWebhookSignature } from "../services/webhooks/webhookSigner.js";
import {
  WebhookDispatcher,
  calculateBackoffDelay,
  WebhookEndpoint,
} from "../services/webhooks/webhookDispatcher.js";

describe("Webhook HMAC Signing & Verification (Issue 157)", () => {
  const secret = "whsec_test_secret_1234567890abcdef";
  const payload = { event: "gameweek.settled", gameweek: 5, leagueId: "league-123" };

  it("should generate a valid HMAC signature header with timestamp and v1 signature", () => {
    const { signature, timestamp, header } = generateWebhookSignature(payload, secret);

    assert.ok(signature && signature.length === 64, "Signature should be a 64-character SHA-256 hex string");
    assert.ok(typeof timestamp === "number", "Timestamp should be numeric");
    assert.strictEqual(header, `t=${timestamp},v1=${signature}`);
  });

  it("should successfully verify a genuine payload and header", () => {
    const { header } = generateWebhookSignature(payload, secret);
    const verification = verifyWebhookSignature(payload, header, secret);

    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.reason, undefined);
  });

  it("should reject verification if payload was tampered with", () => {
    const { header } = generateWebhookSignature(payload, secret);
    const tamperedPayload = { ...payload, gameweek: 6 };
    const verification = verifyWebhookSignature(tamperedPayload, header, secret);

    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.reason, "Signature mismatch");
  });

  it("should reject verification if secret is incorrect", () => {
    const { header } = generateWebhookSignature(payload, secret);
    const wrongSecret = "whsec_wrong_secret_abcdef";
    const verification = verifyWebhookSignature(payload, header, wrongSecret);

    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.reason, "Signature mismatch");
  });

  it("should reject requests outside replay tolerance window", () => {
    const pastTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const { header } = generateWebhookSignature(payload, secret, pastTimestamp);

    const verification = verifyWebhookSignature(payload, header, secret, 5 * 60 * 1000); // 5 min tolerance
    assert.strictEqual(verification.valid, false);
    assert.ok(verification.reason?.includes("expired"));
  });
});

describe("Webhook Exponential Backoff Algorithm (Issue 157)", () => {
  it("should compute accurate exponential backoff delays", () => {
    const initialDelay = 1000;
    const maxDelay = 16000;

    assert.strictEqual(calculateBackoffDelay(1, initialDelay, maxDelay, false), 1000);
    assert.strictEqual(calculateBackoffDelay(2, initialDelay, maxDelay, false), 2000);
    assert.strictEqual(calculateBackoffDelay(3, initialDelay, maxDelay, false), 4000);
    assert.strictEqual(calculateBackoffDelay(4, initialDelay, maxDelay, false), 8000);
    assert.strictEqual(calculateBackoffDelay(5, initialDelay, maxDelay, false), 16000);
  });

  it("should cap backoff delay at maxDelayMs", () => {
    const initialDelay = 1000;
    const maxDelay = 10000;

    assert.strictEqual(calculateBackoffDelay(6, initialDelay, maxDelay, false), 10000);
    assert.strictEqual(calculateBackoffDelay(10, initialDelay, maxDelay, false), 10000);
  });
});

describe("Webhook Dispatcher Engine & Dead-Letter Handling (Issue 157)", () => {
  const endpoint: WebhookEndpoint = {
    id: "ep-test-1",
    url: "https://external.integration/webhook",
    secret: "whsec_test_secret_xyz",
    userId: "user-123",
    events: ["gameweek.settled"],
    isActive: true,
  };

  it("should successfully record SUCCESS when external server returns 200", async () => {
    let capturedHeaders: any = null;
    const mockFetch = async (_url: string, init: any) => {
      capturedHeaders = init.headers;
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const dispatcher = new WebhookDispatcher({ httpFetch: mockFetch });
    const delivery = await dispatcher.dispatch(endpoint, "gameweek.settled", { gw: 5 });

    assert.strictEqual(delivery.status, "SUCCESS");
    assert.strictEqual(delivery.responseStatus, 200);
    assert.ok(capturedHeaders["X-FantasyXI-Signature"].startsWith("t="));
    assert.strictEqual(capturedHeaders["X-FantasyXI-Event"], "gameweek.settled");
    assert.ok(delivery.deliveredAt instanceof Date);
  });

  it("should record FAILED and schedule nextRetryAt when external server returns 500", async () => {
    const mockFetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    const dispatcher = new WebhookDispatcher({
      initialDelayMs: 2000,
      maxAttempts: 3,
      httpFetch: mockFetch,
    });

    const delivery = await dispatcher.dispatch(endpoint, "gameweek.settled", { gw: 5 }, "del-fail-1", 1);

    assert.strictEqual(delivery.status, "FAILED");
    assert.strictEqual(delivery.attempts, 1);
    assert.ok(delivery.nextRetryAt instanceof Date);
    const delay = delivery.nextRetryAt.getTime() - delivery.createdAt.getTime();
    assert.ok(delay >= 1900 && delay <= 2200, `Expected delay ~2000ms, got ${delay}`);
  });

  it("should route to DEAD_LETTER when maximum retry attempts are exhausted", async () => {
    const mockFetch = async () => {
      throw new Error("Connection refused (ECONNREFUSED)");
    };

    const dispatcher = new WebhookDispatcher({
      maxAttempts: 3,
      httpFetch: mockFetch,
    });

    const delivery = await dispatcher.dispatch(endpoint, "gameweek.settled", { gw: 5 }, "del-dlq-1", 3);

    assert.strictEqual(delivery.status, "DEAD_LETTER");
    assert.strictEqual(delivery.attempts, 3);
    assert.strictEqual(delivery.nextRetryAt, null);
    assert.ok(delivery.error?.includes("ECONNREFUSED"));
  });
});
