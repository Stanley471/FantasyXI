import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { EventFanout, FANOUT_STREAM, FANOUT_LIMITS } from "../../services/live/eventFanout.js";

const url = process.env.FANOUT_REDIS_URL;
describe("Redis Streams fanout", { skip: !url }, () => {
  it("broadcasts to every instance, bounds saturation, ACKs and reclaims abandoned work", async () => {
    const redis = new Redis(url!);
    const a = new EventFanout({ redis: new Redis(url!), instanceId: `test-a-${randomUUID()}` });
    const b = new EventFanout({ redis: new Redis(url!), instanceId: `test-b-${randomUUID()}` });
    const topic = `test:${randomUUID()}`;
    const seenA: unknown[] = [], seenB: unknown[] = [];
    a.subscribe(topic, frame => { seenA.push(frame); }); b.subscribe(topic, frame => { seenB.push(frame); });
    try {
      await a.start(); await b.start();
      a.publish(topic, "player:1", { goals: 1 }); a.publish(topic, "player:1", { totalPoints: 6 });
      await a.flushProducer(); await a.poll(); await b.poll();
      assert.ok(seenA.length > 0); assert.ok(seenB.length > 0);
      assert.deepEqual(seenA[0], seenB[0]);
      const group = `fanout:${b.instanceId}`;
      await redis.xadd(FANOUT_STREAM, "*", "event", JSON.stringify({ topic, entity: "orphan", data: { goals: 2 }, origin: "dead" }));
      const held = await redis.xreadgroup("GROUP", group, "dead-consumer", "COUNT", 1, "STREAMS", FANOUT_STREAM, ">") as any;
      const id = held[0][1][0][0];
      await redis.xclaim(FANOUT_STREAM, group, "dead-consumer", 0, id, "IDLE", 6000);
      await b.poll();
      assert.ok(seenB.some((frame: any) => frame.events.some((event: any) => event.entity === "orphan")));
      const pending = await redis.xpending(FANOUT_STREAM, group) as any;
      assert.equal(pending[0], 0);
      for (let batch = 0; batch < 20; batch++) {
        for (let i = 0; i < 10_000; i++) a.publish(topic, String(i), { totalPoints: i });
        await a.flushProducer();
      }
      assert.ok(await redis.xlen(FANOUT_STREAM) <= FANOUT_LIMITS.streamLength);
      assert.ok(a.outbound.size <= FANOUT_LIMITS.entities);
      assert.ok(process.memoryUsage().rss < 500 * 1024 * 1024);
    } finally { await a.close(); await b.close(); redis.disconnect(); }
  });
});
