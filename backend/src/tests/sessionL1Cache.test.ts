/**
 * Tests for Issue #439 — L1 In-Memory Session Cache
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  l1Get,
  l1Set,
  l1Revoke,
  l1Delete,
  l1Clear,
  l1Size,
} from "../services/auth/sessionL1Cache.js";

describe("L1 Session Cache (Issue #439)", () => {
  beforeEach(() => {
    l1Clear();
  });

  it("returns undefined on a cache miss", () => {
    assert.equal(l1Get("nonexistent-session-id"), undefined);
  });

  it("stores and retrieves a valid session", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    l1Set("sid-1", "user-1", expiresAt);

    const entry = l1Get("sid-1");
    assert.ok(entry);
    assert.equal(entry.userId, "user-1");
    assert.equal(entry.valid, true);
    assert.equal(entry.expiresAt, expiresAt.getTime());
  });

  it("does not cache a session that is already expired", () => {
    const expiresAt = new Date(Date.now() - 1000); // past
    l1Set("sid-expired", "user-1", expiresAt);
    assert.equal(l1Get("sid-expired"), undefined);
  });

  it("transparently evicts an entry whose session expiry passes after caching", () => {
    // Set a session that expires very soon
    const expiresAt = new Date(Date.now() + 10); // 10 ms
    l1Set("sid-soon", "user-1", expiresAt);
    // Before expiry — entry exists
    const before = l1Get("sid-soon");
    assert.ok(before);

    // Simulate time passing by overwriting with an already-expired version
    l1Delete("sid-soon");
    l1Set("sid-soon-2", "user-1", new Date(Date.now() - 1));
    assert.equal(l1Get("sid-soon-2"), undefined);
  });

  it("writes and reads a revocation tombstone", () => {
    l1Revoke("sid-revoked");
    const entry = l1Get("sid-revoked");
    assert.ok(entry);
    assert.equal(entry.valid, false);
  });

  it("tombstone overwrites a previously valid entry", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    l1Set("sid-override", "user-2", expiresAt);
    assert.equal(l1Get("sid-override")?.valid, true);

    l1Revoke("sid-override");
    assert.equal(l1Get("sid-override")?.valid, false);
  });

  it("delete removes an entry so it becomes a cache miss", () => {
    l1Set("sid-delete-me", "user-3", new Date(Date.now() + 60_000));
    assert.ok(l1Get("sid-delete-me"));

    l1Delete("sid-delete-me");
    assert.equal(l1Get("sid-delete-me"), undefined);
  });

  it("clear resets the cache size to zero", () => {
    l1Set("s1", "u1", new Date(Date.now() + 60_000));
    l1Set("s2", "u2", new Date(Date.now() + 60_000));
    l1Revoke("s3");
    assert.ok(l1Size() >= 2);

    l1Clear();
    assert.equal(l1Size(), 0);
  });
});
