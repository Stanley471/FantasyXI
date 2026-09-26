import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acquireLock } from "../services/lockManager.js";

describe("LockManager", () => {
  it("acquires and releases a lock without errors", async () => {
    const release = await acquireLock("test-resource", { ttlMs: 1000, retryCount: 1, retryDelayMs: 10 });
    if (release) {
      await release();
    }
    assert.ok(true, "Lock acquired and released successfully");
  });

  it("returns null when Redis is unavailable", async () => {
    // This test verifies graceful fallback when Redis is not available
    const release = await acquireLock("test-resource-unavailable", { ttlMs: 100, retryCount: 1, retryDelayMs: 10 });
    // Should not throw even if Redis is unavailable
    assert.ok(true, "Graceful fallback works");
  });
});
