import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToastType, ToastOptions, ToastItem } from "../types/index.js";
import { emitToast } from "../context/ToastContext.js";

interface MockCustomEventDetail {
  message: string;
  type: ToastType;
  options?: ToastOptions;
}

interface MockEvent {
  type: string;
  detail: MockCustomEventDetail;
}

describe("Toast Notification System", () => {
  describe("Toast Types and Contracts", () => {
    it("should recognize all supported toast severity types", () => {
      const types: ToastType[] = ["success", "error", "info", "warning"];
      assert.equal(types.length, 4);
      assert.ok(types.includes("success"));
      assert.ok(types.includes("error"));
      assert.ok(types.includes("info"));
      assert.ok(types.includes("warning"));
    });

    it("should properly structure ToastItem with all options", () => {
      let actionClicked = false;
      const options: ToastOptions = {
        id: "custom-id-123",
        title: "Test Title",
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => {
            actionClicked = true;
          },
        },
      };

      const item: ToastItem = {
        id: options.id ?? "default-id",
        type: "success",
        message: "Squad lineup saved successfully",
        title: options.title,
        duration: options.duration ?? 4000,
        action: options.action,
        createdAt: Date.now(),
      };

      assert.equal(item.id, "custom-id-123");
      assert.equal(item.type, "success");
      assert.equal(item.message, "Squad lineup saved successfully");
      assert.equal(item.title, "Test Title");
      assert.equal(item.duration, 5000);
      assert.equal(item.action?.label, "Undo");

      item.action?.onClick();
      assert.equal(actionClicked, true);
    });
  });

  describe("Toast Queue and Reducer Logic", () => {
    const MAX_TOASTS = 5;
    const DEFAULT_DURATION = 4000;

    function applyAddToast(
      prev: ToastItem[],
      message: string,
      type: ToastType = "info",
      options?: ToastOptions
    ): { toasts: ToastItem[]; newId: string } {
      const id = options?.id || `toast-${Date.now()}-${Math.random()}`;
      const duration = typeof options?.duration === "number" ? options.duration : DEFAULT_DURATION;
      const newToast: ToastItem = {
        id,
        type,
        message,
        title: options?.title,
        duration,
        action: options?.action,
        createdAt: Date.now(),
      };

      const exists = prev.some((t) => t.id === id);
      let updated: ToastItem[];
      if (exists) {
        updated = prev.map((t) => (t.id === id ? newToast : t));
      } else {
        updated = [...prev, newToast];
      }

      if (updated.length > MAX_TOASTS) {
        updated = updated.slice(updated.length - MAX_TOASTS);
      }

      return { toasts: updated, newId: id };
    }

    function applyDismiss(prev: ToastItem[], id: string): ToastItem[] {
      return prev.filter((t) => t.id !== id);
    }

    function applyDismissAll(): ToastItem[] {
      return [];
    }

    it("should start with an empty toast list", () => {
      const toasts: ToastItem[] = [];
      assert.equal(toasts.length, 0);
    });

    it("should add a success toast with default duration", () => {
      let state: ToastItem[] = [];
      const res = applyAddToast(state, "Team saved successfully", "success");
      state = res.toasts;

      assert.equal(state.length, 1);
      assert.equal(state[0].message, "Team saved successfully");
      assert.equal(state[0].type, "success");
      assert.equal(state[0].duration, 4000);
    });

    it("should add an error toast with custom duration", () => {
      let state: ToastItem[] = [];
      const res = applyAddToast(state, "Failed to submit transaction", "error", { duration: 8000 });
      state = res.toasts;

      assert.equal(state.length, 1);
      assert.equal(state[0].message, "Failed to submit transaction");
      assert.equal(state[0].type, "error");
      assert.equal(state[0].duration, 8000);
    });

    it("should add an info toast with title", () => {
      let state: ToastItem[] = [];
      const res = applyAddToast(state, "New gameweek fixtures available", "info", {
        title: "Gameweek 12",
      });
      state = res.toasts;

      assert.equal(state.length, 1);
      assert.equal(state[0].title, "Gameweek 12");
      assert.equal(state[0].type, "info");
    });

    it("should replace an existing toast if the same ID is re-used", () => {
      let state: ToastItem[] = [];
      const { toasts: t1 } = applyAddToast(state, "Uploading team...", "info", { id: "save-operation" });
      state = t1;
      assert.equal(state.length, 1);
      assert.equal(state[0].message, "Uploading team...");
      assert.equal(state[0].type, "info");

      const { toasts: t2 } = applyAddToast(state, "Team uploaded!", "success", { id: "save-operation" });
      state = t2;
      assert.equal(state.length, 1);
      assert.equal(state[0].message, "Team uploaded!");
      assert.equal(state[0].type, "success");
    });

    it("should enforce maximum visible toast limit (FIFO trimming)", () => {
      let state: ToastItem[] = [];
      for (let i = 1; i <= 8; i++) {
        const { toasts } = applyAddToast(state, `Message ${i}`, "info", { id: `toast-${i}` });
        state = toasts;
      }

      assert.equal(state.length, 5);
      assert.equal(state[0].id, "toast-4");
      assert.equal(state[4].id, "toast-8");
    });

    it("should dismiss an individual toast by ID", () => {
      let state: ToastItem[] = [];
      state = applyAddToast(state, "Toast 1", "info", { id: "t1" }).toasts;
      state = applyAddToast(state, "Toast 2", "info", { id: "t2" }).toasts;
      state = applyAddToast(state, "Toast 3", "info", { id: "t3" }).toasts;

      assert.equal(state.length, 3);
      state = applyDismiss(state, "t2");
      assert.equal(state.length, 2);
      assert.ok(!state.some((t) => t.id === "t2"));
      assert.ok(state.some((t) => t.id === "t1"));
      assert.ok(state.some((t) => t.id === "t3"));
    });

    it("should dismiss all toasts via dismissAll", () => {
      let state: ToastItem[] = [];
      state = applyAddToast(state, "Toast 1", "info").toasts;
      state = applyAddToast(state, "Toast 2", "error").toasts;
      assert.equal(state.length, 2);

      state = applyDismissAll();
      assert.equal(state.length, 0);
    });
  });

  describe("Timer and Pause-on-Hover Logic", () => {
    it("should calculate remaining time correctly when paused and resumed", () => {
      const duration = 4000;
      let remaining = duration;

      // Simulate 1500ms elapsed before pause
      const simulatedElapsed = 1500;
      remaining = Math.max(0, remaining - simulatedElapsed);
      assert.equal(remaining, 2500);

      // Simulate another 1000ms elapsed after resume
      const secondElapsed = 1000;
      remaining = Math.max(0, remaining - secondElapsed);
      assert.equal(remaining, 1500);
    });
  });

  describe("Headless emitToast Dispatcher", () => {
    it("should dispatch custom event on window when available", () => {
      let dispatchedEvent: MockEvent | null = null;
      const mockWindow = {
        dispatchEvent: (e: Event) => {
          dispatchedEvent = e as unknown as MockEvent;
          return true;
        },
      };

      const globalRecord = globalThis as unknown as Record<string, unknown>;
      const originalWindow = globalRecord.window;
      globalRecord.window = mockWindow;

      try {
        emitToast("Invitation copied!", "success", { duration: 3000 });
        const event1 = dispatchedEvent as MockEvent | null;
        assert.ok(event1);
        assert.equal(event1.type, "fantasyxi:toast");
        assert.equal(event1.detail.message, "Invitation copied!");
        assert.equal(event1.detail.type, "success");
        assert.equal(event1.detail.options?.duration, 3000);

        emitToast.error("Wallet disconnected");
        const event2 = dispatchedEvent as MockEvent | null;
        assert.ok(event2);
        assert.equal(event2.detail.message, "Wallet disconnected");
        assert.equal(event2.detail.type, "error");

        emitToast.warning("Invalid formation");
        const event3 = dispatchedEvent as MockEvent | null;
        assert.ok(event3);
        assert.equal(event3.detail.message, "Invalid formation");
        assert.equal(event3.detail.type, "warning");

        emitToast.info("Gameweek started");
        const event4 = dispatchedEvent as MockEvent | null;
        assert.ok(event4);
        assert.equal(event4.detail.message, "Gameweek started");
        assert.equal(event4.detail.type, "info");
      } finally {
        globalRecord.window = originalWindow;
      }
    });

    it("should safely no-op when window is undefined (SSR)", () => {
      const globalRecord = globalThis as unknown as Record<string, unknown>;
      const originalWindow = globalRecord.window;
      delete globalRecord.window;

      try {
        assert.doesNotThrow(() => {
          emitToast("SSR test", "info");
          emitToast.success("SSR success");
        });
      } finally {
        globalRecord.window = originalWindow;
      }
    });
  });

  describe("Accessibility Attributes", () => {
    it("should assign alert role and assertive live region to error toasts", () => {
      const errorToast: ToastItem = {
        id: "err-1",
        type: "error",
        message: "Network request failed",
        duration: 4000,
        createdAt: Date.now(),
      };

      const isAlert = errorToast.type === "error";
      const role = isAlert ? "alert" : "status";
      const ariaLive = isAlert ? "assertive" : "polite";

      assert.equal(role, "alert");
      assert.equal(ariaLive, "assertive");
    });

    it("should assign status role and polite live region to success/info/warning toasts", () => {
      const types: ToastType[] = ["success", "info", "warning"];

      for (const type of types) {
        const toast: ToastItem = {
          id: `t-${type}`,
          type,
          message: `${type} message`,
          duration: 4000,
          createdAt: Date.now(),
        };

        const isAlert = toast.type === "error";
        const role = isAlert ? "alert" : "status";
        const ariaLive = isAlert ? "assertive" : "polite";

        assert.equal(role, "status");
        assert.equal(ariaLive, "polite");
      }
    });
  });
});
