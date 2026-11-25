/**
 * Tests for Issue #439 — Redis Streams Session Sync (L2 backbone)
 *
 * These tests verify event parsing, L1 application logic, and the
 * publish helper without requiring a live Redis connection.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  applySessionEvent,
  type SessionStreamEvent,
} from "../services/auth/sessionStreamSync.js";
import { l1Get, l1Clear } from "../services/auth/sessionL1Cache.js";

describe("Session Stream Sync — event application (Issue #439)", () => {
  beforeEach(() => {
    l1Clear();
  });

  it("SESSION_REVOKED writes an L1 tombstone", () => {
    const event: SessionStreamEvent = {
      type: "SESSION_REVOKED",
      sessionId: "sid-revoked",
      userId: "user-1",
      expiresAt: Date.now() + 60_000,
      publishedAt: Date.now(),
    };

    applySessionEvent(event);

    const entry = l1Get("sid-revoked");
    assert.ok(entry, "tombstone entry must exist in L1");
    assert.equal(entry.valid, false);
  });

  it("SESSION_CREATED populates L1 with a valid entry", () => {
    const expiresAt = Date.now() + 120_000;
    const event: SessionStreamEvent = {
      type: "SESSION_CREATED",
      sessionId: "sid-created",
      userId: "user-2",
      expiresAt,
      publishedAt: Date.now(),
    };

    applySessionEvent(event);

    const entry = l1Get("sid-created");
    assert.ok(entry, "entry must exist in L1 after SESSION_CREATED");
    assert.equal(entry.valid, true);
    assert.equal(entry.userId, "user-2");
    assert.equal(entry.expiresAt, expiresAt);
  });

  it("SESSION_HEARTBEAT refreshes / extends the L1 entry", () => {
    const originalExpiry = Date.now() + 60_000;
    // Seed an existing entry
    applySessionEvent({
      type: "SESSION_CREATED",
      sessionId: "sid-hb",
      userId: "user-3",
      expiresAt: originalExpiry,
      publishedAt: Date.now(),
    });

    const extendedExpiry = originalExpiry + 300_000;
    applySessionEvent({
      type: "SESSION_HEARTBEAT",
      sessionId: "sid-hb",
      userId: "user-3",
      expiresAt: extendedExpiry,
      publishedAt: Date.now(),
    });

    const entry = l1Get("sid-hb");
    assert.ok(entry);
    assert.equal(entry.expiresAt, extendedExpiry);
  });

  it("SESSION_REVOKED after SESSION_CREATED produces a tombstone", () => {
    applySessionEvent({
      type: "SESSION_CREATED",
      sessionId: "sid-then-revoked",
      userId: "user-4",
      expiresAt: Date.now() + 60_000,
      publishedAt: Date.now(),
    });
    assert.equal(l1Get("sid-then-revoked")?.valid, true);

    applySessionEvent({
      type: "SESSION_REVOKED",
      sessionId: "sid-then-revoked",
      userId: "user-4",
      expiresAt: Date.now(),
      publishedAt: Date.now(),
    });
    assert.equal(l1Get("sid-then-revoked")?.valid, false);
  });
});
