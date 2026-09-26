import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryEventBus,
  publishOrThrow,
  SubscriberDeliveryError,
} from "../services/events/eventBus.js";

describe("InMemoryEventBus (#118)", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  it("delivers a published payload to every subscriber", async () => {
    const received: string[] = [];
    bus.subscribe("gameweek.updated", (payload: { id: number }) => {
      received.push(`a:${payload.id}`);
    });
    bus.subscribe("gameweek.updated", (payload: { id: number }) => {
      received.push(`b:${payload.id}`);
    });

    const summary = await bus.publish("gameweek.updated", { id: 7 });

    assert.deepEqual(received, ["a:7", "b:7"]);
    assert.equal(summary.delivered, 2);
    assert.deepEqual(summary.failed, []);
  });

  it("only notifies subscribers of the published event name", async () => {
    let otherCalled = false;
    bus.subscribe("user.signed_up", () => {
      otherCalled = true;
    });
    bus.subscribe("gameweek.updated", () => {});

    await bus.publish("gameweek.updated", {});

    assert.equal(otherCalled, false);
  });

  it("runs subscribers in subscription order", async () => {
    const order: string[] = [];
    bus.subscribe("evt", () => {
      order.push("first");
    });
    bus.subscribe("evt", () => {
      order.push("second");
    });
    bus.subscribe("evt", () => {
      order.push("third");
    });

    await bus.publish("evt", {});

    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("isolates a subscriber failure: other subscribers still run and are reported delivered", async () => {
    const calledHandlers: string[] = [];
    bus.subscribe(
      "evt",
      () => {
        calledHandlers.push("first");
      },
      { name: "first" }
    );
    bus.subscribe(
      "evt",
      () => {
        calledHandlers.push("failing");
        throw new Error("boom");
      },
      { name: "failing" }
    );
    bus.subscribe(
      "evt",
      () => {
        calledHandlers.push("third");
      },
      { name: "third" }
    );

    const summary = await bus.publish("evt", {});

    assert.deepEqual(calledHandlers, ["first", "failing", "third"]);
    assert.equal(summary.delivered, 2);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].handlerName, "failing");
    assert.match(summary.failed[0].error.message, /boom/);
  });

  it("retries a failing subscriber up to maxAttemptsPerSubscriber before giving up", async () => {
    let attempts = 0;
    bus.subscribe(
      "evt",
      () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
      },
      { name: "flaky" }
    );

    const summary = await bus.publish("evt", {}, { maxAttemptsPerSubscriber: 3, retryDelayMs: 1 });

    assert.equal(attempts, 3);
    assert.equal(summary.delivered, 1, "should count as delivered once a retry succeeds");
    assert.deepEqual(summary.failed, []);
  });

  it("records a subscriber as failed once retries are exhausted", async () => {
    let attempts = 0;
    bus.subscribe(
      "evt",
      () => {
        attempts++;
        throw new Error("always fails");
      },
      { name: "always-fails" }
    );

    const summary = await bus.publish("evt", {}, { maxAttemptsPerSubscriber: 2, retryDelayMs: 1 });

    assert.equal(attempts, 2);
    assert.equal(summary.delivered, 0);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].attempts, 2);
    assert.equal(bus.getFailedDeliveries().length, 1, "failure should be recorded for admin review");
  });

  it("unsubscribe stops future deliveries without affecting past ones", async () => {
    let calls = 0;
    const unsubscribe = bus.subscribe("evt", () => {
      calls++;
    });

    await bus.publish("evt", {});
    unsubscribe();
    await bus.publish("evt", {});

    assert.equal(calls, 1);
  });

  it("publish resolves with no subscribers registered", async () => {
    const summary = await bus.publish("nothing.listens", { any: true });
    assert.equal(summary.delivered, 0);
    assert.deepEqual(summary.failed, []);
  });

  it("publishOrThrow resolves normally when every subscriber succeeds", async () => {
    bus.subscribe("evt", () => {});
    const summary = await publishOrThrow(bus, "evt", {});
    assert.equal(summary.delivered, 1);
  });

  it("publishOrThrow throws SubscriberDeliveryError when a subscriber fails on every attempt", async () => {
    bus.subscribe(
      "evt",
      () => {
        throw new Error("critical failure");
      },
      { name: "critical" }
    );

    await assert.rejects(() => publishOrThrow(bus, "evt", {}), (err: unknown) => {
      assert.ok(err instanceof SubscriberDeliveryError);
      assert.equal(err.summary.failed[0].handlerName, "critical");
      assert.match(err.message, /critical failure/);
      return true;
    });
  });
});
