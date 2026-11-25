import { test } from "node:test";
import { strict as assert } from "node:assert";
import { sequenceTracker, SEQUENCE_WINDOW_SIZE } from "../services/live/sequenceTracker.js";

test("SequenceTracker - Tag and store event", async () => {
  const channel = `test-channel-${Date.now()}`;
  const event = {
    type: "goal",
    data: { playerId: 123, minute: 45 },
  };

  const tagged = await sequenceTracker.tagAndStoreEvent(channel, event);

  assert.ok(tagged.sequenceNumber);
  assert.equal(tagged.type, "goal");
  assert.ok(tagged.timestamp);
});

test("SequenceTracker - Retrieve backfill window", async () => {
  const channel = `test-channel-${Date.now()}`;

  for (let i = 0; i < 5; i++) {
    await sequenceTracker.tagAndStoreEvent(channel, {
      type: `event-${i}`,
      data: { index: i },
    });
  }

  const backfill = await sequenceTracker.getBackfillWindow(channel, 2);

  assert.ok(Array.isArray(backfill));
  assert.ok(backfill.length > 0);
  assert.ok(backfill.every((e) => e.sequenceNumber > 2));
});

test("SequenceTracker - Get last sequence number", async () => {
  const channel = `test-channel-${Date.now()}`;

  await sequenceTracker.tagAndStoreEvent(channel, {
    type: "event",
    data: {},
  });

  const lastSeq = await sequenceTracker.getLastSequenceNumber(channel);
  assert.ok(lastSeq > 0);
});

test("SequenceTracker - Sliding window maintains FIFO order", async () => {
  const channel = `test-channel-${Date.now()}`;

  for (let i = 0; i < 10; i++) {
    await sequenceTracker.tagAndStoreEvent(channel, {
      type: `event-${i}`,
      data: { index: i },
    });
  }

  const backfill = await sequenceTracker.getBackfillWindow(channel, 0);

  assert.ok(backfill.length <= SEQUENCE_WINDOW_SIZE);
  if (backfill.length > 1) {
    for (let i = 0; i < backfill.length - 1; i++) {
      assert.ok(backfill[i]!.sequenceNumber <= backfill[i + 1]!.sequenceNumber);
    }
  }
});

test("SequenceTracker - Clear channel", async () => {
  const channel = `test-channel-${Date.now()}`;

  await sequenceTracker.tagAndStoreEvent(channel, {
    type: "event",
    data: {},
  });

  await sequenceTracker.clearChannel(channel);

  const lastSeq = await sequenceTracker.getLastSequenceNumber(channel);
  assert.equal(lastSeq, 0);
});
