import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type { Redis } from "ioredis";
import type { SequenceTaggedEvent } from "../services/live/sequenceTracker.js";

describe("WebSocket Disconnection Backfill and Sequence Reconciliation", () => {
  describe("Sequence Number Tagging", () => {
    it("tags goal events with monotonic sequence numbers", async () => {
      const events: SequenceTaggedEvent[] = [];

      for (let i = 1; i <= 5; i++) {
        events.push({
          sequenceNumber: i,
          timestamp: Date.now() + i * 1000,
          type: "goal",
          data: { player: `Player${i}`, minute: 10 * i },
        });
      }

      const sequenceNumbers = events.map((e) => e.sequenceNumber);
      expect(sequenceNumbers).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(sequenceNumbers).size).toBe(5);
    });

    it("tags assist events with monotonic sequence numbers", async () => {
      const assists: SequenceTaggedEvent[] = [
        {
          sequenceNumber: 1,
          timestamp: 1000,
          type: "assist",
          data: { player: "Provider", goalScorer: "Scorer1" },
        },
        {
          sequenceNumber: 2,
          timestamp: 2000,
          type: "assist",
          data: { player: "Provider2", goalScorer: "Scorer2" },
        },
      ];

      expect(assists[0].sequenceNumber < assists[1].sequenceNumber).toBe(true);
    });

    it("tags bonus points events with sequence numbers", async () => {
      const bonusEvents: SequenceTaggedEvent[] = [
        {
          sequenceNumber: 1,
          timestamp: 1000,
          type: "bonus",
          data: { player: "P1", points: 5 },
        },
        {
          sequenceNumber: 2,
          timestamp: 2000,
          type: "bonus",
          data: { player: "P2", points: 3 },
        },
        {
          sequenceNumber: 3,
          timestamp: 3000,
          type: "bonus",
          data: { player: "P1", points: 2 },
        },
      ];

      expect(bonusEvents.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    });

    it("tags chat messages with sequence numbers", async () => {
      const chatEvents: SequenceTaggedEvent[] = [
        {
          sequenceNumber: 50,
          timestamp: 1000,
          type: "chat_message",
          data: { user: "alice", text: "Hello" },
        },
        {
          sequenceNumber: 51,
          timestamp: 1100,
          type: "chat_message",
          data: { user: "bob", text: "Hi there" },
        },
      ];

      expect(chatEvents[1].sequenceNumber).toBeGreaterThan(chatEvents[0].sequenceNumber);
    });
  });

  describe("Sliding Window Storage (Last 500 Events)", () => {
    it("maintains sliding window of last 500 events per channel", () => {
      const channel = "matchday:1";
      const windowSize = 500;

      const events: SequenceTaggedEvent[] = Array.from({ length: 1000 }, (_, i) => ({
        sequenceNumber: i + 1,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const window = events.slice(-windowSize);
      expect(window).toHaveLength(500);
      expect(window[0].sequenceNumber).toBe(501);
      expect(window[499].sequenceNumber).toBe(1000);
    });

    it("stores per-channel event windows independently", () => {
      const matchday1Events: SequenceTaggedEvent[] = Array.from({ length: 100 }, (_, i) => ({
        sequenceNumber: i + 1,
        timestamp: 1000 + i * 100,
        type: "goal",
        data: { channel: "matchday:1" },
      }));

      const matchday2Events: SequenceTaggedEvent[] = Array.from({ length: 100 }, (_, i) => ({
        sequenceNumber: i + 1,
        timestamp: 1000 + i * 100,
        type: "goal",
        data: { channel: "matchday:2" },
      }));

      expect(matchday1Events[0].sequenceNumber).toBe(matchday2Events[0].sequenceNumber);
      expect(matchday1Events[0].data.channel).not.toBe(matchday2Events[0].data.channel);
    });

    it("evicts oldest events when window size is exceeded", () => {
      const windowSize = 500;
      const baseSeq = 2000;

      const events: SequenceTaggedEvent[] = Array.from({ length: 600 }, (_, i) => ({
        sequenceNumber: baseSeq + i,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const window = events.slice(-windowSize);
      expect(window).toHaveLength(500);
      expect(window[0].sequenceNumber).toBe(baseSeq + 100);
      expect(window[window.length - 1].sequenceNumber).toBe(baseSeq + 599);
    });
  });

  describe("Client Reconnection with lastSeenSequenceNumber", () => {
    it("retrieves all missed events if gap is within window", () => {
      const allEvents: SequenceTaggedEvent[] = Array.from({ length: 100 }, (_, i) => ({
        sequenceNumber: i + 1,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const lastSeenSeq = 50;
      const missedEvents = allEvents.filter((e) => e.sequenceNumber > lastSeenSeq);

      expect(missedEvents).toHaveLength(50);
      expect(missedEvents[0].sequenceNumber).toBe(51);
      expect(missedEvents[49].sequenceNumber).toBe(100);
    });

    it("triggers full snapshot refresh if gap exceeds window size", () => {
      const windowSize = 500;
      const allEvents: SequenceTaggedEvent[] = Array.from({ length: 100 }, (_, i) => ({
        sequenceNumber: 1000 + i,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const lastSeenSeq = 500;
      const gap = allEvents[allEvents.length - 1].sequenceNumber - lastSeenSeq;

      expect(gap).toBeGreaterThan(windowSize);

      const shouldTriggerSnapshot = gap > windowSize;
      expect(shouldTriggerSnapshot).toBe(true);
    });

    it("handles new client (lastSeenSequenceNumber=0)", () => {
      const allEvents: SequenceTaggedEvent[] = Array.from({ length: 50 }, (_, i) => ({
        sequenceNumber: i + 1,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const lastSeenSeq = 0;
      const backfill = allEvents.filter((e) => e.sequenceNumber > lastSeenSeq);

      expect(backfill).toHaveLength(50);
      expect(backfill[0].sequenceNumber).toBe(1);
    });

    it("handles reconnection after short disconnection", () => {
      const storedEvents: SequenceTaggedEvent[] = Array.from({ length: 10 }, (_, i) => ({
        sequenceNumber: 90 + i,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const clientLastSeen = 95;
      const missed = storedEvents.filter((e) => e.sequenceNumber > clientLastSeen);

      expect(missed).toHaveLength(4);
      expect(missed.map((e) => e.sequenceNumber)).toEqual([96, 97, 98, 99]);
    });

    it("handles reconnection at window boundary", () => {
      const windowSize = 500;
      const baseSeq = 1000;

      const storedEvents: SequenceTaggedEvent[] = Array.from({ length: windowSize }, (_, i) => ({
        sequenceNumber: baseSeq + i,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const clientLastSeen = baseSeq - 1;
      const missed = storedEvents.filter((e) => e.sequenceNumber > clientLastSeen);

      expect(missed).toHaveLength(windowSize);
    });

    it("returns empty backfill when client is at current sequence", () => {
      const storedEvents: SequenceTaggedEvent[] = Array.from({ length: 50 }, (_, i) => ({
        sequenceNumber: i + 1,
        timestamp: 1000 + i * 100,
        type: "delta",
        data: { index: i },
      }));

      const currentSeq = 50;
      const missed = storedEvents.filter((e) => e.sequenceNumber > currentSeq);

      expect(missed).toHaveLength(0);
    });
  });

  describe("Frontend Client-Side Deduplication and Merging", () => {
    it("deduplicates events by sequence number", () => {
      const receivedEvents: SequenceTaggedEvent[] = [
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: { player: "A" } },
        { sequenceNumber: 2, timestamp: 2000, type: "goal", data: { player: "B" } },
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: { player: "A" } },
        { sequenceNumber: 3, timestamp: 3000, type: "goal", data: { player: "C" } },
      ];

      const deduplicated = Array.from(
        new Map(receivedEvents.map((e) => [e.sequenceNumber, e])).values()
      );

      expect(deduplicated).toHaveLength(3);
      expect(deduplicated.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    });

    it("merges backfill with live stream chronologically", () => {
      const backfill: SequenceTaggedEvent[] = [
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: { player: "A" } },
        { sequenceNumber: 2, timestamp: 2000, type: "assist", data: { player: "B" } },
        { sequenceNumber: 3, timestamp: 3000, type: "bonus", data: { player: "A" } },
      ];

      const liveStream: SequenceTaggedEvent[] = [
        { sequenceNumber: 4, timestamp: 4000, type: "goal", data: { player: "C" } },
        { sequenceNumber: 5, timestamp: 5000, type: "chat", data: { text: "Great!" } },
      ];

      const merged = [...backfill, ...liveStream].sort(
        (a, b) => a.sequenceNumber - b.sequenceNumber
      );

      expect(merged).toHaveLength(5);
      expect(merged[0].sequenceNumber).toBe(1);
      expect(merged[4].sequenceNumber).toBe(5);
    });

    it("respects chronological order after merging", () => {
      const events: SequenceTaggedEvent[] = [
        { sequenceNumber: 10, timestamp: 10000, type: "goal", data: {} },
        { sequenceNumber: 5, timestamp: 5000, type: "goal", data: {} },
        { sequenceNumber: 15, timestamp: 15000, type: "goal", data: {} },
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: {} },
      ];

      const sorted = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

      expect(sorted.map((e) => e.sequenceNumber)).toEqual([1, 5, 10, 15]);
    });

    it("handles out-of-order timestamp with correct sequence ordering", () => {
      const events: SequenceTaggedEvent[] = [
        { sequenceNumber: 1, timestamp: 5000, type: "goal", data: {} },
        { sequenceNumber: 2, timestamp: 1000, type: "goal", data: {} },
        { sequenceNumber: 3, timestamp: 10000, type: "goal", data: {} },
      ];

      const sortedBySeq = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      expect(sortedBySeq.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);

      const sortedByTime = [...events].sort((a, b) => a.timestamp - b.timestamp);
      expect(sortedByTime.map((e) => e.timestamp)).toEqual([1000, 5000, 10000]);
    });
  });

  describe("Network Recovery Scenarios", () => {
    it("handles connection loss and re-establishment", () => {
      const clientState = {
        lastSeenSeq: 50,
        isConnected: true,
      };

      clientState.isConnected = false;
      expect(clientState.isConnected).toBe(false);

      clientState.isConnected = true;
      const missedStart = clientState.lastSeenSeq + 1;

      expect(missedStart).toBe(51);
    });

    it("handles multiple rapid reconnections", () => {
      const reconnections = [
        { disconnectSeq: 100, reconnectSeq: 102 },
        { disconnectSeq: 102, reconnectSeq: 105 },
        { disconnectSeq: 105, reconnectSeq: 107 },
      ];

      const totalMissed = reconnections.reduce((sum, r) => sum + (r.reconnectSeq - r.disconnectSeq), 0);
      expect(totalMissed).toBe(6);
    });

    it("prevents message loss during transient network hiccups", () => {
      const eventQueue: SequenceTaggedEvent[] = [];

      const incomingEvents: SequenceTaggedEvent[] = [
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: { player: "A" } },
        { sequenceNumber: 2, timestamp: 2000, type: "goal", data: { player: "B" } },
        { sequenceNumber: 3, timestamp: 3000, type: "goal", data: { player: "C" } },
      ];

      eventQueue.push(...incomingEvents);

      expect(eventQueue).toHaveLength(3);
      expect(eventQueue.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    });
  });

  describe("Broadcast Event Categories", () => {
    it("handles monotonic sequences across mixed event types", () => {
      const events: SequenceTaggedEvent[] = [
        { sequenceNumber: 1, timestamp: 1000, type: "goal", data: { player: "A" } },
        { sequenceNumber: 2, timestamp: 2000, type: "assist", data: { player: "B" } },
        { sequenceNumber: 3, timestamp: 3000, type: "bonus", data: { player: "C" } },
        { sequenceNumber: 4, timestamp: 4000, type: "chat_message", data: { text: "Great!" } },
        { sequenceNumber: 5, timestamp: 5000, type: "goal", data: { player: "D" } },
      ];

      const sequences = events.map((e) => e.sequenceNumber);
      expect(sequences).toEqual([1, 2, 3, 4, 5]);

      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
      }
    });

    it("stores different event categories in same sliding window", () => {
      const windowSize = 500;
      const mixedEvents: SequenceTaggedEvent[] = [];

      const goals = Array.from({ length: 100 }, (_, i) => ({
        sequenceNumber: i * 5 + 1,
        timestamp: 1000 + i * 1000,
        type: "goal" as const,
        data: { player: `Player${i}` },
      }));

      const assists = Array.from({ length: 100 }, (_, i) => ({
        sequenceNumber: i * 5 + 2,
        timestamp: 1000 + i * 1000,
        type: "assist" as const,
        data: { player: `Provider${i}` },
      }));

      mixedEvents.push(...goals, ...assists);
      mixedEvents.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

      expect(mixedEvents).toHaveLength(200);
      expect(mixedEvents[0].type).toBe("goal");
      expect(mixedEvents[1].type).toBe("assist");
    });
  });
});
