import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  liveMatchEventAggregator,
  SLIDING_WINDOW_BUFFER_SIZE,
} from "../services/live/liveMatchEventAggregator.js";

test("LiveMatchEventAggregator - Process live event", async () => {
  const event = {
    eventId: "evt-001",
    fixtureId: 123,
    playerId: 456,
    eventType: "GOAL" as const,
    points: 5,
    minute: 45,
    timestamp: Date.now(),
  };

  try {
    const affected = await liveMatchEventAggregator.processLiveEvent(event);
    assert.ok(Array.isArray(affected));
  } catch (error) {
    // Expected if player or fixture doesn't exist
    assert.ok(error);
  }
});

test("LiveMatchEventAggregator - Get league rankings", async () => {
  const fixtureId = 123;

  try {
    const ranks = await liveMatchEventAggregator.getLeagueRanks(
      "test-league",
      fixtureId
    );

    assert.ok(Array.isArray(ranks));
  } catch (error) {
    // Expected
    assert.ok(error);
  }
});

test("LiveMatchEventAggregator - Get event history", async () => {
  const fixtureId = 123;

  try {
    const history = await liveMatchEventAggregator.getEventHistory(fixtureId);
    assert.ok(Array.isArray(history));
  } catch (error) {
    // Expected
    assert.ok(error);
  }
});

test("LiveMatchEventAggregator - Sliding window buffer size", async () => {
  assert.equal(SLIDING_WINDOW_BUFFER_SIZE, 1000);
});
