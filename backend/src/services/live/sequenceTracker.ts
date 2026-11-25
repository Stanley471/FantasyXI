import type { Redis } from "ioredis";
import { getRedisClient } from "../../config/redis.js";

export interface SequenceTaggedEvent {
  sequenceNumber: number;
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
}

export const SEQUENCE_WINDOW_SIZE = 500;
const SEQUENCE_KEY_PREFIX = "seq:";

export class SequenceTracker {
  private redis: Redis | null;

  constructor(redis: Redis | null = null) {
    this.redis = redis;
  }

  async initialize(): Promise<void> {
    if (!this.redis) {
      this.redis = getRedisClient();
    }
  }

  async tagAndStoreEvent(
    channel: string,
    event: Omit<SequenceTaggedEvent, "sequenceNumber" | "timestamp">
  ): Promise<SequenceTaggedEvent> {
    if (!this.redis) await this.initialize();

    const key = `${SEQUENCE_KEY_PREFIX}${channel}`;
    const sequenceNumber = await this.redis!.incr(`${key}:counter`);
    const timestamp = Date.now();

    const taggedEvent: SequenceTaggedEvent = {
      sequenceNumber,
      timestamp,
      type: event.type,
      data: event.data,
    };

    await this.redis!.lpush(key, JSON.stringify(taggedEvent));
    await this.redis!.ltrim(key, 0, SEQUENCE_WINDOW_SIZE - 1);

    return taggedEvent;
  }

  async getBackfillWindow(
    channel: string,
    lastSeenSequenceNumber: number
  ): Promise<SequenceTaggedEvent[]> {
    if (!this.redis) await this.initialize();

    const key = `${SEQUENCE_KEY_PREFIX}${channel}`;
    const events = await this.redis!.lrange(key, 0, -1);

    if (!events.length) return [];

    const parsed = events
      .map((e) => JSON.parse(e) as SequenceTaggedEvent)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const missed = parsed.filter((e) => e.sequenceNumber > lastSeenSequenceNumber);

    if (missed.length <= SEQUENCE_WINDOW_SIZE) {
      return missed;
    }

    return [];
  }

  async getLastSequenceNumber(channel: string): Promise<number> {
    if (!this.redis) await this.initialize();

    const key = `${SEQUENCE_KEY_PREFIX}${channel}`;
    const value = await this.redis!.get(`${key}:counter`);

    return value ? parseInt(value, 10) : 0;
  }

  async clearChannel(channel: string): Promise<void> {
    if (!this.redis) await this.initialize();

    const key = `${SEQUENCE_KEY_PREFIX}${channel}`;
    await this.redis!.del(key, `${key}:counter`);
  }
}

export const sequenceTracker = new SequenceTracker();
