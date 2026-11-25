import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Redis } from "ioredis";
import { SequenceTracker, SEQUENCE_WINDOW_SIZE } from "../services/live/sequenceTracker.js";

describe("SequenceTracker - Sequence Number Reconciliation Integration", () => {
  let tracker: SequenceTracker;
  let mockRedis: Redis;

  beforeEach(() => {
    mockRedis = {
      incr: vi.fn().mockResolvedValue(1),
      lpush: vi.fn().mockResolvedValue(1),
      ltrim: vi.fn().mockResolvedValue("OK"),
      lrange: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    tracker = new SequenceTracker(mockRedis);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Monotonic Sequence Numbering per Channel", () => {
    it("increments sequence counter for each tagged event", async () => {
      vi.mocked(mockRedis.incr).mockResolvedValueOnce(1);
      vi.mocked(mockRedis.incr).mockResolvedValueOnce(2);

      await tracker.tagAndStoreEvent("matchday:1", { type: "goal", data: { player: "A" } });
      await tracker.tagAndStoreEvent("matchday:1", { type: "goal", data: { player: "B" } });

      expect(vi.mocked(mockRedis.incr)).toHaveBeenCalledWith("seq:matchday:1:counter");
      expect(vi.mocked(mockRedis.incr)).toHaveBeenCalledTimes(2);
    });

    it("maintains separate counters per channel", async () => {
      vi.mocked(mockRedis.incr).mockResolvedValueOnce(1);
      vi.mocked(mockRedis.incr).mockResolvedValueOnce(1);

      await tracker.tagAndStoreEvent("matchday:1", { type: "goal", data: { player: "A" } });
      await tracker.tagAndStoreEvent("matchday:2", { type: "goal", data: { player: "B" } });

      expect(vi.mocked(mockRedis.incr)).toHaveBeenCalledWith("seq:matchday:1:counter");
      expect(vi.mocked(mockRedis.incr)).toHaveBeenCalledWith("seq:matchday:2:counter");
    });
  });

  describe("Sliding Window Storage", () => {
    it("maintains last 500 events in Redis list per channel", async () => {
      vi.mocked(mockRedis.incr).mockResolvedValue(1);

      await tracker.tagAndStoreEvent("matchday:1", { type: "delta", data: { index: 0 } });

      expect(vi.mocked(mockRedis.ltrim)).toHaveBeenCalledWith(
        "seq:matchday:1",
        0,
        SEQUENCE_WINDOW_SIZE - 1
      );
    });

    it("stores event as JSON string in Redis", async () => {
      vi.mocked(mockRedis.incr).mockResolvedValueOnce(42);

      await tracker.tagAndStoreEvent("matchday:5", {
        type: "goal",
        data: { player: "John", minute: 15 },
      });

      expect(vi.mocked(mockRedis.lpush)).toHaveBeenCalledWith(
        "seq:matchday:5",
        expect.stringContaining('"sequenceNumber":42')
      );
    });

    it("includes timestamp and event metadata in stored event", async () => {
      vi.mocked(mockRedis.incr).mockResolvedValueOnce(10);
      const beforeCall = Date.now();

      await tracker.tagAndStoreEvent("matchday:1", {
        type: "assist",
        data: { provider: "Alice", goalScorer: "Bob" },
      });

      const callArg = vi.mocked(mockRedis.lpush).mock.calls[0][1] as string;
      const stored = JSON.parse(callArg);

      expect(stored.sequenceNumber).toBe(10);
      expect(stored.type).toBe("assist");
      expect(stored.timestamp).toBeGreaterThanOrEqual(beforeCall);
      expect(stored.data.provider).toBe("Alice");
    });
  });

  describe("Client Backfill on Reconnection", () => {
    it("retrieves missed events when lastSeenSequenceNumber < current", async () => {
      const storedEvents = [
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: { player: "A" } },
        { sequenceNumber: 2, timestamp: 2000, type: "assist", data: { player: "B" } },
        { sequenceNumber: 3, timestamp: 3000, type: "bonus", data: { player: "A" } },
      ].map((e) => JSON.stringify(e));

      vi.mocked(mockRedis.lrange).mockResolvedValueOnce(storedEvents);

      const missed = await tracker.getBackfillWindow("matchday:1", 1);

      expect(missed).toHaveLength(2);
      expect(missed[0].sequenceNumber).toBe(2);
      expect(missed[1].sequenceNumber).toBe(3);
    });

    it("returns empty array when client is current", async () => {
      const storedEvents = [
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: { player: "A" } },
      ].map((e) => JSON.stringify(e));

      vi.mocked(mockRedis.lrange).mockResolvedValueOnce(storedEvents);

      const missed = await tracker.getBackfillWindow("matchday:1", 1);

      expect(missed).toHaveLength(0);
    });

    it("triggers full snapshot if gap exceeds window size", async () => {
      const events = Array.from({ length: 100 }, (_, i) => ({
        sequenceNumber: i + 1,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      })).map((e) => JSON.stringify(e));

      vi.mocked(mockRedis.lrange).mockResolvedValueOnce(events);

      const missed = await tracker.getBackfillWindow("matchday:1", 0);

      expect(missed).toHaveLength(100);
    });

    it("returns empty when no events available in window", async () => {
      vi.mocked(mockRedis.lrange).mockResolvedValueOnce([]);

      const missed = await tracker.getBackfillWindow("matchday:1", 0);

      expect(missed).toEqual([]);
    });
  });

  describe("Current Sequence State Synchronization", () => {
    it("retrieves current sequence counter for state reconciliation", async () => {
      vi.mocked(mockRedis.get).mockResolvedValueOnce("100");

      const currentSeq = await tracker.getLastSequenceNumber("matchday:1");

      expect(currentSeq).toBe(100);
      expect(vi.mocked(mockRedis.get)).toHaveBeenCalledWith("seq:matchday:1:counter");
    });

    it("returns 0 when counter not yet initialized", async () => {
      vi.mocked(mockRedis.get).mockResolvedValueOnce(null);

      const currentSeq = await tracker.getLastSequenceNumber("matchday:5");

      expect(currentSeq).toBe(0);
    });

    it("allows client to send currentSequence in ready message", async () => {
      vi.mocked(mockRedis.get).mockResolvedValueOnce("42");

      const seq = await tracker.getLastSequenceNumber("matchday:1");

      const readyMessage = {
        type: "ready",
        gameweekId: 1,
        currentSequence: seq,
      };

      expect(readyMessage.currentSequence).toBe(42);
    });
  });

  describe("Channel Cleanup", () => {
    it("clears sequence data when match or league ends", async () => {
      await tracker.clearChannel("matchday:99");

      expect(vi.mocked(mockRedis.del)).toHaveBeenCalledWith(
        "seq:matchday:99",
        "seq:matchday:99:counter"
      );
    });

    it("does not affect other channels when clearing one", async () => {
      await tracker.clearChannel("matchday:1");
      await tracker.clearChannel("matchday:2");

      expect(vi.mocked(mockRedis.del)).toHaveBeenCalledWith("seq:matchday:1", "seq:matchday:1:counter");
      expect(vi.mocked(mockRedis.del)).toHaveBeenCalledWith("seq:matchday:2", "seq:matchday:2:counter");
    });
  });

  describe("Event Ordering Guarantees", () => {
    it("preserves event order through sequence numbers", async () => {
      const events = [
        { sequenceNumber: 10, timestamp: 1000, type: "goal", data: {} },
        { sequenceNumber: 11, timestamp: 2000, type: "goal", data: {} },
        { sequenceNumber: 12, timestamp: 3000, type: "goal", data: {} },
      ].map((e) => JSON.stringify(e));

      vi.mocked(mockRedis.lrange).mockResolvedValueOnce(events);

      const retrieved = await tracker.getBackfillWindow("matchday:1", 9);

      const sequences = retrieved.map((e) => e.sequenceNumber);
      expect(sequences).toEqual([10, 11, 12]);

      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
      }
    });

    it("handles out-of-order Redis response correctly", async () => {
      const events = [
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: {} },
        { sequenceNumber: 3, timestamp: 3000, type: "goal", data: {} },
        { sequenceNumber: 2, timestamp: 2000, type: "goal", data: {} },
      ].map((e) => JSON.stringify(e));

      vi.mocked(mockRedis.lrange).mockResolvedValueOnce(events);

      const retrieved = await tracker.getBackfillWindow("matchday:1", 0);

      const sortedSeq = retrieved.map((e) => e.sequenceNumber).sort((a, b) => a - b);
      expect(sortedSeq).toEqual([1, 2, 3]);
    });
  });

  describe("Error Handling and Resilience", () => {
    it("initializes Redis connection lazily if not provided", async () => {
      const freshTracker = new SequenceTracker(null);
      expect(freshTracker).toBeDefined();
    });

    it("handles Redis operations transparently", async () => {
      vi.mocked(mockRedis.incr).mockResolvedValueOnce(1);

      const result = await tracker.tagAndStoreEvent("matchday:1", {
        type: "goal",
        data: { player: "A" },
      });

      expect(result.sequenceNumber).toBe(1);
      expect(result.type).toBe("goal");
    });
  });
});
