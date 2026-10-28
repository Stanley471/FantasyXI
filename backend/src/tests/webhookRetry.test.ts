import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  WebhookRetryEngine,
  calculateBackoffDelay,
  RETRY_SCHEDULE_MS,
  MAX_RETRY_ATTEMPTS,
  MAX_CONSECUTIVE_FAILURES_BEFORE_DEACTIVATION,
} from "../services/webhooks/webhookRetryEngine.js";
import { verifyWebhookSignature } from "../services/webhooks/webhookSigner.js";
import { WebhookEndpoint } from "../services/webhooks/webhookDispatcher.js";
import app from "../app.js";

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return handler;
}

describe("Webhook Retry Engine & Dead-Letter Queue (#219)", () => {
  let endpoint: WebhookEndpoint;

  beforeEach(() => {
    endpoint = {
      id: "ep_test_123",
      url: "https://consumer.example.com/webhook",
      secret: "whsec_test_secret_1234567890abcdef12345678",
      userId: "user-1",
      events: ["league.settled", "player.score_update"],
      isActive: true,
    };
  });

  describe("Retry Schedule & Backoff Intervals", () => {
    it("strictly follows the exponential backoff schedule: immediate, 1m, 5m, 15m, 1h", () => {
      assert.equal(calculateBackoffDelay(1), 0); // Attempt 1: immediate
      assert.equal(calculateBackoffDelay(2), 60_000); // Attempt 2: 1 minute
      assert.equal(calculateBackoffDelay(3), 300_000); // Attempt 3: 5 minutes
      assert.equal(calculateBackoffDelay(4), 900_000); // Attempt 4: 15 minutes
      assert.equal(calculateBackoffDelay(5), 3_600_000); // Attempt 5: 1 hour
      // Beyond attempt 5 caps at 1 hour
      assert.equal(calculateBackoffDelay(6), 3_600_000);
    });
  });

  describe("Dead-Letter Queue & Delivery Attempt Tracking", () => {
    it("records delivery attempts with latency, status code, and moves to DEAD_LETTER after 5 failed attempts", async () => {
      let callCount = 0;
      const engine = new WebhookRetryEngine({
        httpFetch: mockFetch(async () => {
          callCount++;
          return new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
      });

      const payload = { leagueId: "league-42", prizeDisbursed: true };
      const record = await engine.dispatch(endpoint, "league.settled", payload);

      assert.equal(record.status, "FAILED");
      assert.equal(record.attemptCount, 1);
      assert.equal(record.attempts.length, 1);
      assert.equal(record.attempts[0].statusCode, 500);
      assert.ok(record.attempts[0].latencyMs >= 0);
      assert.ok(record.nextRetryAt !== null);

      // Simulate retries up to max attempts (5)
      for (let attempt = 2; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        await engine.executeAttempt(record, endpoint);
      }

      assert.equal(record.attemptCount, 5);
      assert.equal(record.attempts.length, 5);
      assert.equal(record.status, "DEAD_LETTER");
      assert.equal(record.nextRetryAt, null);

      // Verify presence in Dead-Letter Queue
      const dlq = engine.getDeadLetterQueue();
      assert.equal(dlq.length, 1);
      assert.equal(dlq[0].id, record.id);
      assert.equal(dlq[0].status, "DEAD_LETTER");
    });
  });

  describe("Subscription Circuit & Auto-Deactivation", () => {
    it("auto-deactivates endpoint after 10 consecutive delivery failures", async () => {
      const engine = new WebhookRetryEngine({
        httpFetch: mockFetch(async () => {
          return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
        }),
      });

      // Dispatch 10 separate failing deliveries to this endpoint
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES_BEFORE_DEACTIVATION; i++) {
        await engine.dispatch(endpoint, "ping", { index: i });
      }

      assert.equal(endpoint.isActive, false);
      assert.equal(engine.getConsecutiveFailures(endpoint.id), 10);

      // Subsequent dispatch to deactivated endpoint is immediately rejected/dead-lettered
      const rejected = await engine.dispatch(endpoint, "ping", { afterDeactivation: true });
      assert.equal(rejected.status, "DEAD_LETTER");
      assert.ok(rejected.lastError?.includes("DEACTIVATED"));
    });

    it("resets consecutive failure counter on successful delivery", async () => {
      let fail = true;
      const engine = new WebhookRetryEngine({
        httpFetch: mockFetch(async () => {
          if (fail) return new Response("Error", { status: 500, statusText: "Error" });
          return new Response("OK", { status: 200 });
        }),
      });

      // 3 failures
      for (let i = 0; i < 3; i++) {
        await engine.dispatch(endpoint, "ping", {});
      }
      assert.equal(engine.getConsecutiveFailures(endpoint.id), 3);

      // 1 success resets counter
      fail = false;
      await engine.dispatch(endpoint, "ping", {});
      assert.equal(engine.getConsecutiveFailures(endpoint.id), 0);
      assert.equal(endpoint.isActive, true);
    });

    it("reactivates deactivated endpoint and allows new dispatches", () => {
      const engine = new WebhookRetryEngine();
      endpoint.isActive = false;
      engine.registerEndpoint(endpoint);

      const reactivated = engine.reactivateEndpoint(endpoint.id);
      assert.equal(reactivated.isActive, true);
      assert.equal(engine.getConsecutiveFailures(endpoint.id), 0);
    });
  });

  describe("Manual Replay Fidelity", () => {
    it("replays dead-letter delivery preserving payload and generating valid HMAC signature", async () => {
      let fail = true;
      let lastHeaders: Headers | undefined;
      let lastBody: string | undefined;

      const engine = new WebhookRetryEngine({
        httpFetch: mockFetch(async (_url, init) => {
          lastHeaders = new Headers(init.headers);
          lastBody = init.body as string;
          if (fail) {
            return new Response("Fatal Error", { status: 500, statusText: "Internal Error" });
          }
          return new Response(JSON.stringify({ received: true }), { status: 200 });
        }),
      });

      const originalPayload = {
        transactionId: "tx_999",
        amountStroops: "10000000",
        currency: "USDC",
      };

      const record = await engine.dispatch(endpoint, "payout.completed", originalPayload);

      // Exhaust retries to send to DLQ
      for (let i = 2; i <= 5; i++) {
        await engine.executeAttempt(record, endpoint);
      }
      assert.equal(record.status, "DEAD_LETTER");

      // Upstream server recovers
      fail = false;

      // Replay dead-letter delivery
      const replayed = await engine.retryDelivery(record.id);

      assert.equal(replayed.status, "DELIVERED");
      assert.equal(replayed.attemptCount, 6);
      assert.deepEqual(replayed.payload, originalPayload);

      // Check header and signature fidelity
      const sigHeader = lastHeaders?.get("X-FantasyXI-Signature");
      const eventHeader = lastHeaders?.get("X-FantasyXI-Event");
      assert.equal(eventHeader, "payout.completed");
      assert.ok(sigHeader, "Signature header must be present on replay");

      // Verify signature validates against original payload and endpoint secret
      const verification = verifyWebhookSignature(JSON.parse(lastBody!), sigHeader!, endpoint.secret);
      assert.equal(verification.valid, true);
    });
  });

  describe("Dead-Letter & Retry Management API Controllers", () => {
    it("handles getDeadLetterDeliveries, retryFailedDelivery, and reactivateEndpointController", async () => {
      const {
        createEndpoint,
        getDeadLetterDeliveries,
        retryFailedDelivery,
        reactivateEndpointController,
      } = await import("../controllers/webhook.controller.js");

      // Mock express req/res
      function makeReqRes(body: any = {}, params: any = {}, query: any = {}) {
        let statusCode = 200;
        let jsonResponse: any = null;
        return {
          req: { body, params, query } as any,
          res: {
            status: (code: number) => {
              statusCode = code;
              return { json: (data: any) => (jsonResponse = data) };
            },
            json: (data: any) => (jsonResponse = data),
          } as any,
          getStatus: () => statusCode,
          getBody: () => jsonResponse,
        };
      }

      // 1. Create endpoint
      const create = makeReqRes({ url: "https://example.com/hook", events: ["test"] });
      await createEndpoint(create.req, create.res);
      assert.equal(create.getStatus(), 201);
      const ep = create.getBody().endpoint;
      assert.ok(ep.id);

      // 2. Query DLQ
      const dlqReq = makeReqRes({}, {}, { endpointId: ep.id });
      await getDeadLetterDeliveries(dlqReq.req, dlqReq.res);
      assert.equal(dlqReq.getStatus(), 200);
      assert.ok(Array.isArray(dlqReq.getBody().deadLetters));

      // 3. Retry without deliveryId returns 400
      const retryFail = makeReqRes({});
      await retryFailedDelivery(retryFail.req, retryFail.res);
      assert.equal(retryFail.getStatus(), 400);

      // 4. Reactivate endpoint
      const reactivate = makeReqRes({}, { id: ep.id });
      await reactivateEndpointController(reactivate.req, reactivate.res);
      assert.equal(reactivate.getStatus(), 200);
      assert.equal(reactivate.getBody().endpoint.isActive, true);
    });

    it("rejects duplicate normalized subscriptions and updates disjoint events", async () => {
      const { createEndpoint } = await import("../controllers/webhook.controller.js");
      function makeReqRes(body: any) {
        let statusCode = 200;
        let jsonResponse: any;
        const res: any = {
          status(code: number) {
            statusCode = code;
            return res;
          },
          json(value: any) {
            jsonResponse = value;
            return res;
          },
        };
        return {
          req: { body, user: { id: "webhook-uniqueness-user" } } as any,
          res,
          getStatus: () => statusCode,
          getBody: () => jsonResponse,
        };
      }

      const suffix = `/${Date.now()}-duplicate`;
      const first = makeReqRes({
        url: ` HTTPS://Example.COM/hooks${suffix}/ `,
        events: ["league.created"],
      });
      await createEndpoint(first.req, first.res);
      assert.equal(first.getStatus(), 201);
      assert.equal(first.getBody().endpoint.url, `https://example.com/hooks${suffix}`);

      const duplicate = makeReqRes({
        url: `https://EXAMPLE.com/hooks${suffix}`,
        events: ["league.created"],
      });
      await createEndpoint(duplicate.req, duplicate.res);
      assert.equal(duplicate.getStatus(), 409);
      assert.equal(duplicate.getBody().error, "Webhook subscription already exists for this URL and event");

      const updated = makeReqRes({
        url: `https://example.com/hooks${suffix}/`,
        events: ["league.updated"],
      });
      await createEndpoint(updated.req, updated.res);
      assert.equal(updated.getStatus(), 200);
      assert.deepEqual(updated.getBody().endpoint.events, ["league.created", "league.updated"]);
      assert.equal(updated.getBody().updated, true);
    });
  });
});
