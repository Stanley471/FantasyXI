/**
 * Tests for Issue #438 — Outbox Event Deduplication
 *
 * Tests the in-process LRU layer only (no live Redis).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { deduplicationStore } from "../services/outbox/outboxDeduplication.js";

describe("OutboxDeduplicationStore (Issue #438)", () => {
  beforeEach(() => {
    deduplicationStore.clearLocal();
  });

  it("returns false for an unseen deduplication ID", async () => {
    const seen = await deduplicationStore.alreadySeen("brand-new-id");
    assert.equal(seen, false);
  });

  it("returns true after markSeen is called (local LRU path)", async () => {
    await deduplicationStore.markSeen("some-event-id");
    const seen = await deduplicationStore.alreadySeen("some-event-id");
    assert.equal(seen, true);
  });

  it("different IDs are independent", async () => {
    await deduplicationStore.markSeen("event-a");
    assert.equal(await deduplicationStore.alreadySeen("event-a"), true);
    assert.equal(await deduplicationStore.alreadySeen("event-b"), false);
  });

  it("clearLocal resets the in-memory seen set", async () => {
    await deduplicationStore.markSeen("event-clear");
    assert.equal(await deduplicationStore.alreadySeen("event-clear"), true);

    deduplicationStore.clearLocal();
    // After clear, local LRU misses — Redis also unavailable in test, so false
    assert.equal(await deduplicationStore.alreadySeen("event-clear"), false);
  });
});
