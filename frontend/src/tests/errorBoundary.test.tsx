import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { flush, getQueueLength } from "../lib/telemetry.js";

function withDom(run: (container: HTMLElement, win: Window & typeof globalThis) => Promise<void> | void) {
  const dom = new JSDOM("<!doctype html><html><body><div></div></body></html>", {
    url: "http://localhost:3000/team",
  });
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = dom.window.document.querySelector("div")!;
  return Promise.resolve()
    .then(() => run(container, dom.window as unknown as Window & typeof globalThis))
    .finally(() => {
      Object.assign(globalThis, prev);
      dom.window.close();
    });
}

describe("Granular ErrorBoundary Tree & Contextual Recovery (Issue #404)", () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    flush();
    // Silence React's expected error boundary console noise during intentional crash tests
    console.error = () => {};
  });

  afterEach(() => {
    console.error = originalConsoleError;
    flush();
  });

  it("isolates a crashing widget, renders contextual fallback UI, and reports error + componentStack to telemetry", async () => {
    const beaconCalls: Array<{ url: string; data: string }> = [];
    await withDom(async (container) => {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          sendBeacon: (url: string, data: string) => {
            beaconCalls.push({ url, data });
            return true;
          },
        },
        configurable: true,
        writable: true,
      });

      function BrokenWidget(): React.ReactElement {
        throw new Error("Simulated LeaderboardTable render failure");
      }

      const root = createRoot(container);
      await act(async () => {
        root.render(
          <div>
            <header data-testid="app-shell-header">Navigation Shell Intact</header>
            <ErrorBoundary
              name="LeaderboardTable"
              fallbackTitle="Leaderboard table failed to render"
            >
              <BrokenWidget />
            </ErrorBoundary>
            <footer data-testid="app-shell-footer">Sidebar & Footer Intact</footer>
          </div>
        );
      });

      // Surrounding shell must remain mounted and interactive
      assert.equal(
        container.querySelector('[data-testid="app-shell-header"]')?.textContent,
        "Navigation Shell Intact"
      );
      assert.equal(
        container.querySelector('[data-testid="app-shell-footer"]')?.textContent,
        "Sidebar & Footer Intact"
      );

      // Contextual fallback card must be rendered inside the isolated boundary
      const alertBox = container.querySelector('[role="alert"]');
      assert.ok(alertBox, "Expected fallback alert container to be rendered");
      assert.match(alertBox.textContent ?? "", /Leaderboard table failed to render/);
      assert.match(alertBox.textContent ?? "", /Simulated LeaderboardTable render failure/);

      // Telemetry queue must have recorded the error event with boundary name and componentStack
      assert.ok(getQueueLength() >= 1, "Expected error to be enqueued in telemetry");
      flush();
      assert.equal(beaconCalls.length, 1);
      const payload = JSON.parse(beaconCalls[0].data) as {
        events: Array<{
          type: string;
          name: string;
          metadata: { boundary?: string; message: string; stack: string };
        }>;
      };
      const errorEvt = payload.events.find((e) => e.type === "error");
      assert.ok(errorEvt);
      assert.equal(errorEvt.metadata.boundary, "LeaderboardTable");
      assert.equal(errorEvt.metadata.message, "Simulated LeaderboardTable render failure");
      assert.ok(errorEvt.metadata.stack.includes("BrokenWidget"));

      await act(async () => root.unmount());
    });
  });

  it("recovers and re-renders the widget without a full page reload when clicking 'Try again'", async () => {
    await withDom(async (container) => {
      let shouldThrow = true;
      let resetCallbackCount = 0;

      function FlakyPitchWidget() {
        if (shouldThrow) {
          throw new Error("Transient pitch WebGL context loss");
        }
        return <div data-testid="recovered-pitch">Pitch Tactical View Ready</div>;
      }

      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ErrorBoundary
            name="TeamBuilderPitch"
            fallbackTitle="Pitch tactical view failed to render"
            onReset={() => {
              resetCallbackCount++;
              shouldThrow = false;
            }}
          >
            <FlakyPitchWidget />
          </ErrorBoundary>
        );
      });

      // Verify fallback is shown initially
      const tryAgainBtn = container.querySelector("button");
      assert.ok(tryAgainBtn);
      assert.equal(tryAgainBtn.textContent, "Try again");

      // Click "Try again" to trigger contextual recovery
      await act(async () => {
        tryAgainBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });

      assert.equal(resetCallbackCount, 1);
      assert.equal(container.querySelector('[role="alert"]'), null);
      assert.equal(
        container.querySelector('[data-testid="recovered-pitch"]')?.textContent,
        "Pitch Tactical View Ready"
      );

      await act(async () => root.unmount());
    });
  });

  it("automatically resets the boundary when resetKeys change", async () => {
    await withDom(async (container) => {
      function GameweekWidget({ gwId }: { gwId: number }) {
        if (gwId === 1) {
          throw new Error("Corrupted GW 1 fixture payload");
        }
        return <div data-testid="gw-content">Showing Gameweek {gwId}</div>;
      }

      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ErrorBoundary
            name="FixturesList"
            fallbackTitle="Fixtures schedule failed to render"
            resetKeys={[1]}
          >
            <GameweekWidget gwId={1} />
          </ErrorBoundary>
        );
      });

      assert.ok(container.querySelector('[role="alert"]'));

      // Change resetKeys to [2] -> boundary auto-recovers
      await act(async () => {
        root.render(
          <ErrorBoundary
            name="FixturesList"
            fallbackTitle="Fixtures schedule failed to render"
            resetKeys={[2]}
          >
            <GameweekWidget gwId={2} />
          </ErrorBoundary>
        );
      });

      assert.equal(container.querySelector('[role="alert"]'), null);
      assert.equal(
        container.querySelector('[data-testid="gw-content"]')?.textContent,
        "Showing Gameweek 2"
      );

      await act(async () => root.unmount());
    });
  });
});
