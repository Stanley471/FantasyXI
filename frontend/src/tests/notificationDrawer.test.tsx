import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { NotificationDrawer } from "../components/layout/NotificationDrawer";

const mockRouter: any = {
  push: (..._args: unknown[]) => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: async () => {},
};

function withRouter(children: React.ReactNode) {
  return <AppRouterContext.Provider value={mockRouter}>{children}</AppRouterContext.Provider>;
}

/**
 * Notification center drawer (issue #500): open/close behavior and
 * mark-as-read dismissal.
 */

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let requests: Array<{ method: string; url: string }>;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const SAMPLE_NOTIFICATIONS = [
  {
    id: "notif_1",
    type: "league_invite",
    title: "You were invited to Mini League",
    body: "Join before the gameweek deadline.",
    link: "/leagues/abc123",
    isRead: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: "notif_2",
    type: "payment_confirmed",
    title: "Payment confirmed",
    body: "Your entry fee was received.",
    link: null,
    isRead: true,
    createdAt: new Date().toISOString(),
  },
];

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("localStorage", dom.window.localStorage);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  requests = [];
  setGlobal("fetch", async (url: string, options: any = {}) => {
    requests.push({ method: options.method || "GET", url });
    if (options.method === "POST" || options.method === "DELETE") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: SAMPLE_NOTIFICATIONS,
        unreadCount: SAMPLE_NOTIFICATIONS.filter((n) => !n.isRead).length,
      }),
    } as Response;
  });

  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("NotificationDrawer (issue #500)", () => {
  it("renders nothing when closed", () => {
    act(() => {
      root.render(withRouter(<NotificationDrawer isOpen={false} onClose={() => {}} />));
    });
    assert.equal(container.querySelector('[data-testid="notification-drawer"]'), null);
  });

  it("fetches and renders notifications when opened", async () => {
    act(() => {
      root.render(withRouter(<NotificationDrawer isOpen={true} onClose={() => {}} />));
    });
    await flush();

    assert.ok(container.querySelector('[data-testid="notification-drawer"]'));
    assert.ok(container.querySelector('[data-testid="notification-item-notif_1"]'));
    assert.ok(container.querySelector('[data-testid="notification-item-notif_2"]'));
    assert.ok(requests.some((r) => r.method === "GET" && r.url.includes("/notifications")));
  });

  it("reports the unread count to the parent", async () => {
    let reportedCount: number | undefined;
    act(() => {
      root.render(
        withRouter(
          <NotificationDrawer
            isOpen={true}
            onClose={() => {}}
            onUnreadCountChange={(count) => {
              reportedCount = count;
            }}
          />
        )
      );
    });
    await flush();

    assert.equal(reportedCount, 1);
  });

  it("calls onClose when the close button is clicked", async () => {
    let closed = false;
    act(() => {
      root.render(withRouter(<NotificationDrawer isOpen={true} onClose={() => (closed = true)} />));
    });
    await flush();

    const closeButton = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    act(() => closeButton.click());

    assert.equal(closed, true);
  });

  it("calls onClose when the backdrop is clicked", async () => {
    let closed = false;
    act(() => {
      root.render(withRouter(<NotificationDrawer isOpen={true} onClose={() => (closed = true)} />));
    });
    await flush();

    const backdrop = container.querySelector(
      'button[aria-label="Close notifications"]'
    ) as HTMLButtonElement;
    act(() => backdrop.click());

    assert.equal(closed, true);
  });

  it("marks a notification read and dismisses its unread indicator when clicked", async () => {
    act(() => {
      root.render(withRouter(<NotificationDrawer isOpen={true} onClose={() => {}} />));
    });
    await flush();

    const item = container.querySelector(
      '[data-testid="notification-item-notif_1"]'
    ) as HTMLButtonElement;
    assert.ok(item.querySelector(".bg-emerald-500"), "unread dot should be present before the click");

    await act(async () => {
      item.click();
      await Promise.resolve();
    });

    assert.ok(
      requests.some((r) => r.method === "POST" && r.url.includes("/notifications/notif_1/read")),
      "expected a mark-as-read request"
    );
    assert.equal(
      container.querySelector('[data-testid="notification-item-notif_1"] .bg-emerald-500'),
      null
    );
  });

  it("clears every notification when 'Clear all' is clicked", async () => {
    act(() => {
      root.render(withRouter(<NotificationDrawer isOpen={true} onClose={() => {}} />));
    });
    await flush();

    const clearAllButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Clear all"
    ) as HTMLButtonElement;
    await act(async () => {
      clearAllButton.click();
      await Promise.resolve();
    });

    assert.equal(container.querySelector('[data-testid="notification-item-notif_1"]'), null);
    assert.equal(container.querySelector('[data-testid="notification-item-notif_2"]'), null);
    assert.ok(requests.some((r) => r.method === "DELETE" && r.url.includes("/notifications")));
  });
});
