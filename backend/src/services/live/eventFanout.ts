import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { createRedisClient } from "../../config/redis.js";

export const FANOUT_STREAM = "fantasyxi:matchday:events";
export const FANOUT_LIMITS = { entities: 2048, eventBytes: 4096, streamLength: 4096, batch: 256, windowMs: 100 } as const;
export interface FanoutEvent {
  topic: string;
  entity: string;
  /** Absolute changed fields, never additive increments: replay and coalescing are safe. */
  data: Record<string, unknown>;
  origin: string;
}
export interface DeltaFrame { type: "delta"; topic: string; events: FanoutEvent[] }
type Listener = (frame: DeltaFrame) => void;

/** A bounded last-value buffer. Distinct entities overflow by dropping the oldest. */
export class DeltaBuffer {
  private readonly pending = new Map<string, FanoutEvent>();
  public dropped = 0;
  public coalesced = 0;
  get size() { return this.pending.size; }
  add(event: FanoutEvent): boolean {
    if (!event.topic || event.topic.length > 128 || !event.entity || event.entity.length > 128 ||
        Buffer.byteLength(JSON.stringify(event)) > FANOUT_LIMITS.eventBytes) { this.dropped++; return false; }
    const key = JSON.stringify([event.topic, event.entity]);
    const old = this.pending.get(key);
    if (old) {
      const merged = { ...event, data: { ...old.data, ...event.data } };
      if (Buffer.byteLength(JSON.stringify(merged)) > FANOUT_LIMITS.eventBytes) { this.dropped++; return false; }
      this.pending.set(key, merged);
      this.coalesced++;
    } else {
      if (this.pending.size >= FANOUT_LIMITS.entities) {
        this.pending.delete(this.pending.keys().next().value!);
        this.dropped++;
      }
      this.pending.set(key, event);
    }
    return true;
  }
  take(limit = FANOUT_LIMITS.batch): FanoutEvent[] {
    const events: FanoutEvent[] = [];
    for (const [key, event] of this.pending) {
      events.push(event); this.pending.delete(key);
      if (events.length >= limit) break;
    }
    return events;
  }
}

/**
 * One consumer group per API instance: every instance must see every event for
 * its local sockets. Consumers within that group share the work. Redis 6.2+.
 * Delivery is best effort; reconnecting clients fetch the authoritative snapshot.
 */
export class EventFanout {
  readonly outbound = new DeltaBuffer();
  readonly inbound = new DeltaBuffer();
  readonly instanceId: string;
  private readonly consumer = randomUUID();
  private readonly listeners = new Map<string, Set<Listener>>();
  private producerTimer?: NodeJS.Timeout;
  private consumerTimer?: NodeJS.Timeout;
  private producing: Promise<void> | null = null;
  private consuming: Promise<void> | null = null;
  private redis: Redis | null;
  private started = false;
  private readonly redisConfigured: boolean;
  private lastMaintenance = 0;
  private reclaimCursor = "0-0";
  public errors = 0;
  constructor(options: { redis?: Redis | null; instanceId?: string } = {}) {
    this.redisConfigured = options.redis !== undefined;
    this.redis = options.redis ?? null;
    this.instanceId = options.instanceId ?? process.env.FANOUT_INSTANCE_ID ?? `${hostname()}-${process.pid}`;
  }
  private get group() { return `fanout:${this.instanceId}`; }
  subscribe(topic: string, listener: Listener): () => void {
    const set = this.listeners.get(topic) ?? new Set<Listener>();
    set.add(listener); this.listeners.set(topic, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(topic); };
  }
  publish(topic: string, entity: string, data: Record<string, unknown>): boolean {
    return this.outbound.add({ topic, entity, data, origin: this.instanceId });
  }
  private deliver(events: FanoutEvent[]): void {
    // At most 12 x 4KB events/frame, including JSON overhead < 64KB.
    const byTopic = new Map<string, FanoutEvent[]>();
    for (const event of events) {
      const list = byTopic.get(event.topic) ?? [];
      list.push(event); byTopic.set(event.topic, list);
    }
    for (const [topic, values] of byTopic) {
      for (let i = 0; i < values.length; i += 12) {
        const frame: DeltaFrame = { type: "delta", topic, events: values.slice(i, i + 12) };
        for (const listener of this.listeners.get(topic) ?? []) {
          try { listener(frame); } catch { this.errors++; }
        }
      }
    }
  }
  async flushProducer(): Promise<void> {
    if (this.producing) return this.producing;
    this.producing = (async () => {
      const events = this.outbound.take();
      if (!events.length) return;
      if (!this.redis) { for (const event of events) this.inbound.add(event); return; }
      const pipeline = this.redis.pipeline();
      for (const event of events) pipeline.xadd(FANOUT_STREAM, "MAXLEN", "=", FANOUT_LIMITS.streamLength, "*", "event", JSON.stringify(event));
      const result = await pipeline.exec();
      if (!result || result.some(([error]) => error)) throw new Error("Fanout stream write failed");
    })().catch(() => { this.errors++; }).finally(() => { this.producing = null; });
    return this.producing;
  }
  async poll(): Promise<void> {
    if (this.consuming) return this.consuming;
    this.consuming = (async () => {
      if (this.redis) {
        if (Date.now() - this.lastMaintenance >= 10_000) {
          await this.maintainGroups(); this.lastMaintenance = Date.now();
        }
        const reclaimed = await this.redis.xautoclaim(FANOUT_STREAM, this.group, this.consumer, 5_000, this.reclaimCursor, "COUNT", FANOUT_LIMITS.batch) as [string, Array<[string, string[] | null]>];
        this.reclaimCursor = reclaimed[0];
        const reply = await this.redis.xreadgroup("GROUP", this.group, this.consumer, "COUNT", FANOUT_LIMITS.batch, "STREAMS", FANOUT_STREAM, ">") as Array<[string, Array<[string, string[] | null]>]> | null;
        const rows = [...reclaimed[1], ...(reply?.[0]?.[1] ?? [])];
        for (const [id, fields] of rows) {
          try {
            const raw = fields?.[fields.indexOf("event") + 1];
            if (raw && Buffer.byteLength(raw) <= FANOUT_LIMITS.eventBytes) {
              const event = JSON.parse(raw) as FanoutEvent;
              if (typeof event.origin === "string" && event.data && typeof event.data === "object" &&
                  typeof event.topic === "string" && typeof event.entity === "string") this.inbound.add(event);
            }
          } catch { this.errors++; }
          // Poison/trimmed messages cannot grow the pending list indefinitely.
          await this.redis.xack(FANOUT_STREAM, this.group, id);
        }
      }
      this.deliver(this.inbound.take());
    })().catch(() => { this.errors++; }).finally(() => { this.consuming = null; });
    return this.consuming;
  }
  private async maintainGroups(): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(`fanout:active:${this.group}`, "1", "PX", 60_000);
    let groups: unknown[][] = [];
    try { groups = await this.redis.xinfo("GROUPS", FANOUT_STREAM) as unknown[][]; }
    catch (error) { if (!(error as Error).message.includes("no such key")) throw error; }
    let active = 0;
    for (const fields of groups) {
      const group = String(fields[fields.indexOf("name") + 1]);
      if (!group.startsWith("fanout:")) continue;
      if (group === this.group || await this.redis.exists(`fanout:active:${group}`)) active++;
      else await this.redis.xgroup("DESTROY", FANOUT_STREAM, group);
    }
    if (active >= 128 && !groups.some(fields => fields[fields.indexOf("name") + 1] === this.group)) {
      throw new Error("Fanout is limited to 128 active API instance groups");
    }
  }
  async start(): Promise<void> {
    if (this.started) return;
    if (!this.redisConfigured) this.redis ??= createRedisClient();
    if (this.redis) {
      if (this.redis.status === "wait") await this.redis.connect();
      await this.maintainGroups();
      try { await this.redis.xgroup("CREATE", FANOUT_STREAM, this.group, "$", "MKSTREAM"); }
      catch (error) { if (!(error as Error).message.includes("BUSYGROUP")) throw error; }
    }
    this.started = true;
    this.producerTimer = setInterval(() => void this.flushProducer(), FANOUT_LIMITS.windowMs);
    this.consumerTimer = setInterval(() => void this.poll(), FANOUT_LIMITS.windowMs);
    this.producerTimer.unref(); this.consumerTimer.unref();
  }
  async close(): Promise<void> {
    clearInterval(this.producerTimer); clearInterval(this.consumerTimer);
    await this.producing; await this.consuming;
    if (this.redis) {
      try { await this.redis.xgroup("DESTROY", FANOUT_STREAM, this.group); } catch { this.errors++; }
      try { await this.redis.del(`fanout:active:${this.group}`); } catch { this.errors++; }
      this.redis.disconnect();
    }
    this.started = false;
    this.listeners.clear();
  }
}
export const eventFanout = new EventFanout();
