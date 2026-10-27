/** Paced 50k events/s soak with actual Redis and two independent API consumer groups. */
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { EventFanout, FANOUT_LIMITS, FANOUT_STREAM } from "../services/live/eventFanout.js";

const url = process.env.FANOUT_REDIS_URL;
if (!url) throw new Error("FANOUT_REDIS_URL must point to an isolated test Redis");
const seconds = Number(process.env.FANOUT_LOAD_SECONDS ?? 10);
const redis = new Redis(url);
const producer = new EventFanout({ redis: new Redis(url), instanceId: `load-a-${randomUUID()}` });
const peer = new EventFanout({ redis: new Redis(url), instanceId: `load-b-${randomUUID()}` });
let frames = 0, events = 0, peakRss = 0;
peer.subscribe("matchday:1", () => { frames++; });
try {
  await producer.start(); await peer.start();
  const started = performance.now();
  // 500 events every 10ms; no unbounded arrays of promises or event payloads.
  for (let tick = 0; tick < seconds * 100; tick++) {
    for (let i = 0; i < 500; i++) {
      producer.publish("matchday:1", String(events % 500), { totalPoints: events, goals: events % 5 }); events++;
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const delay = started + (tick + 1) * 10 - performance.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    else await new Promise<void>(resolve => setImmediate(resolve));
  }
  await producer.flushProducer(); await peer.poll();
  const durationMs = performance.now() - started;
  const streamLength = await redis.xlen(FANOUT_STREAM);
  const report = { events, durationMs: Math.round(durationMs), eventsPerSecond: Math.round(events * 1000 / durationMs),
    frames, peakRssMiB: Math.round(peakRss / 1024 / 1024), streamLength,
    producerDropped: producer.outbound.dropped, coalesced: producer.outbound.coalesced,
    errors: producer.errors + peer.errors };
  console.log(JSON.stringify(report, null, 2));
  if (peakRss >= 500 * 1024 * 1024 || streamLength > FANOUT_LIMITS.streamLength || !frames || report.errors) {
    throw new Error("Fanout load acceptance failed");
  }
} finally { await producer.close(); await peer.close(); redis.disconnect(); }
