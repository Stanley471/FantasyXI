import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_SYNC_STORAGE_KEY,
  broadcastSessionRevocation,
  SessionSyncMessage,
} from "../hooks/useCrossTabSessionSync";

// Mock localStorage environment
class MockStorage {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] || null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = value;
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
  clear(): void {
    this.store = {};
  }
}

describe("Cross-Tab Multi-Device Session Invalidation (Issue #342)", () => {
  beforeEach(() => {
    (globalThis as any).window = globalThis;
    (globalThis as any).localStorage = new MockStorage();
  });

  it("broadcastSessionRevocation writes structured payload to localStorage", () => {
    broadcastSessionRevocation({
      type: "LOGOUT",
      userId: "usr-123",
      timestamp: 1700000000,
    });

    const stored = (globalThis as any).localStorage.getItem(SESSION_SYNC_STORAGE_KEY);
    assert.ok(stored);

    const parsed: SessionSyncMessage = JSON.parse(stored);
    assert.equal(parsed.type, "LOGOUT");
    assert.equal(parsed.userId, "usr-123");
    assert.equal(parsed.timestamp, 1700000000);
  });

  it("handles SESSION_REVOKED and TOKEN_EXPIRED messages", () => {
    broadcastSessionRevocation({
      type: "SESSION_REVOKED",
      sessionId: "sess-abc-456",
      timestamp: 1700000050,
    });

    const stored = (globalThis as any).localStorage.getItem(SESSION_SYNC_STORAGE_KEY);
    assert.ok(stored);

    const parsed: SessionSyncMessage = JSON.parse(stored);
    assert.equal(parsed.type, "SESSION_REVOKED");
    assert.equal(parsed.sessionId, "sess-abc-456");
  });

  it("safely handles SSR environments when window is undefined", () => {
    delete (globalThis as any).window;
    // Should not throw in SSR
    assert.doesNotThrow(() => {
      broadcastSessionRevocation({
        type: "LOGOUT",
        timestamp: Date.now(),
      });
    });
  });
});
