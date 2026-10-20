import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeltaBuffer, EventFanout, FANOUT_LIMITS } from "../services/live/eventFanout.js";
import { BoundedSocketSender } from "../realtime/boundedSocket.js";

describe("bounded matchday fanout", () => {
  it("merges absolute score/card changes into one entity delta", () => {
    const buffer = new DeltaBuffer();
    buffer.add({ topic: "matchday:1", entity: "8:4", origin: "a", data: { goals: 1, totalPoints: 5 } });
    buffer.add({ topic: "matchday:1", entity: "8:4", origin: "b", data: { yellowCards: 1, totalPoints: 4 } });
    assert.deepEqual(buffer.take()[0].data, { goals: 1, yellowCards: 1, totalPoints: 4 });
    assert.equal(buffer.size, 0);
    assert.equal(buffer.coalesced, 1);
  });
  it("bounds memory under 500,000 distinct saturated producer events", () => {
    const buffer = new DeltaBuffer();
    for (let i = 0; i < 500_000; i++) buffer.add({ topic: "matchday:1", entity: String(i), origin: "a", data: { goals: i } });
    assert.equal(buffer.size, FANOUT_LIMITS.entities);
    assert.equal(buffer.dropped, 500_000 - FANOUT_LIMITS.entities);
    assert.ok(process.memoryUsage().rss < 500 * 1024 * 1024);
  });
  it("rejects oversized events and oversized merged patches", () => {
    const buffer = new DeltaBuffer();
    assert.equal(buffer.add({ topic: "x", entity: "x", origin: "a", data: { a: "x".repeat(4096) } }), false);
    assert.equal(buffer.size, 0);
    buffer.add({ topic: "x", entity: "x", origin: "a", data: { a: "x".repeat(2500) } });
    assert.equal(buffer.add({ topic: "x", entity: "x", origin: "a", data: { b: "x".repeat(2500) } }), false);
    assert.equal(buffer.size, 1);
  });
  it("drops frames and terminates a stalled socket without retaining application queues", () => {
    let sends = 0, closed = 0;
    const callbacks: Array<() => void> = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (_: string, cb: () => void) => { sends++; callbacks.push(cb); }, terminate: () => { closed++; } };
    const sender = new BoundedSocketSender(socket, 2, 1024, 3);
    assert.equal(sender.send({ score: 1 }), true);
    assert.equal(sender.send({ score: 2 }), true);
    for (let i = 0; i < 3; i++) assert.equal(sender.send({ score: i }), false);
    assert.equal(sends, 2); assert.equal(closed, 1);
    callbacks.shift()!();
    assert.equal(sender.send({ score: 3 }), true);
    socket.bufferedAmount = 1024;
    assert.equal(sender.send({ score: 4 }), false);
  });
  it("delivers coalesced frames without Redis in local mode and isolates listener failures", async () => {
    const fanout = new EventFanout({ redis: null, instanceId: "local" });
    const received: unknown[] = [];
    const unsubscribe = fanout.subscribe("matchday:1", frame => { received.push(frame); });
    fanout.subscribe("matchday:1", () => { throw new Error("socket closed"); });
    fanout.publish("matchday:1", "player:1", { goals: 1 });
    fanout.publish("matchday:1", "player:1", { totalPoints: 6 });
    await fanout.flushProducer(); await fanout.poll();
    assert.equal(received.length, 1); assert.equal(fanout.errors, 1);
    unsubscribe(); await fanout.close();
  });
});
