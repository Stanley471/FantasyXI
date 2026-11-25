import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RealtimeWorkerCore, type MinimalPort, type MinimalWebSocketFactory } from "../lib/realtime/workerCore";
import {
  RealtimeBus,
  detectRealtimeMode,
} from "../lib/realtime/realtimeBus";
import {
  channelKey,
  liveSocketUrl,
  notificationSocketUrl,
  type RealtimeChannel,
  type WorkerToTabMessage,
} from "../lib/realtime/protocol";

/**
 * Issue #459: cross-tab SharedWorker broadcast state synchronization.
 *
 * The worker core is exercised directly with fake sockets/ports (message
 * routing, tab lifecycle, fallback-independent), and the tab-side bus is
 * exercised with fake SharedWorker / Worker / BroadcastChannel doubles so
 * the fallback ladder and auth fan-out are covered without a real browser.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.closeCode = code;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  /** Server-side abnormal drop: onclose fires, socket is not re-usable. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const fakeSocketFactory = Object.assign((url: string) => new FakeWebSocket(url), {
  OPEN: 1,
  CONNECTING: 0,
}) as unknown as MinimalWebSocketFactory;

function makePort(): { port: MinimalPort; received: WorkerToTabMessage[] } {
  const received: WorkerToTabMessage[] = [];
  return { port: { postMessage: (message) => received.push(message) }, received };
}

interface FakeTimers {
  scheduled: { fn: () => void; ms: number }[];
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (id: unknown) => void;
  runAll: () => void;
}

function makeFakeTimers(): FakeTimers {
  const scheduled: { fn: () => void; ms: number }[] = [];
  return {
    scheduled,
    setTimeoutFn: (fn, ms) => {
      const entry = { fn, ms };
      scheduled.push(entry);
      return entry;
    },
    clearTimeoutFn: (id) => {
      const idx = scheduled.indexOf(id as { fn: () => void; ms: number });
      if (idx >= 0) scheduled.splice(idx, 1);
    },
    runAll: () => {
      for (const entry of scheduled.splice(0)) entry.fn();
    },
  };
}

function makeCore(timers?: FakeTimers): { core: RealtimeWorkerCore; timers: FakeTimers } {
  const t = timers ?? makeFakeTimers();
  const core = new RealtimeWorkerCore({
    createSocket: fakeSocketFactory,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    random: () => 0, // deterministic backoff: reconnectDelay(n, () => 0)
  });
  return { core, timers: t };
}

const chatChannel: RealtimeChannel = { kind: "chat", leagueId: "league-1" };
const liveChannel: RealtimeChannel = { kind: "live", gameweekId: 7 };
const notificationsChannel: RealtimeChannel = { kind: "notifications" };

function initTab(core: RealtimeWorkerCore, tabId: string): { port: MinimalPort; received: WorkerToTabMessage[] } {
  const { port, received } = makePort();
  core.addPort(tabId, port);
  core.handleMessage(tabId, { type: "init", tabId, apiBaseUrl: "https://api.example.com", token: "test-token" });
  return { port, received };
}

function subscribeReady(core: RealtimeWorkerCore, tabId: string, channel: RealtimeChannel): FakeWebSocket {
  const before = FakeWebSocket.instances.length;
  core.handleMessage(tabId, { type: "subscribe", channel });
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  assert.ok(socket, "a socket must be opened on first subscribe");
  if (FakeWebSocket.instances.length === before + 1) {
    socket.open();
    socket.receive({ type: "ready", userId: "user-1" });
  }
  return socket;
}

// Fake BroadcastChannel hub: every channel in the hub hears the others.
class FakeBroadcastHub {
  private channels = new Set<FakeBroadcastChannel>();
  register(channel: FakeBroadcastChannel): void {
    this.channels.add(channel);
  }
  post(from: FakeBroadcastChannel, message: unknown): void {
    for (const channel of [...this.channels]) {
      if (channel !== from) channel.deliver(message);
    }
  }
}

class FakeBroadcastChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(private readonly hub: FakeBroadcastHub) {
    hub.register(this);
  }
  postMessage(message: unknown): void {
    this.hub.post(this, message);
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: message });
  }
  close(): void {}
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as Record<string, unknown>).window = globalThis;
  delete (globalThis as Record<string, unknown>).SharedWorker;
  delete (globalThis as Record<string, unknown>).Worker;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).SharedWorker;
  delete (globalThis as Record<string, unknown>).Worker;
});

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

describe("realtime protocol (Issue #459)", () => {
  it("channel keys are unique per stream", () => {
    assert.notEqual(channelKey(chatChannel), channelKey(liveChannel));
    assert.notEqual(channelKey({ kind: "chat", leagueId: "league-2" }), channelKey(chatChannel));
    assert.equal(channelKey({ kind: "chat", leagueId: "league-1" }), channelKey(chatChannel));
    assert.equal(channelKey(notificationsChannel), "notifications");
  });

  it("socket URLs switch to wss for https API bases", () => {
    assert.equal(liveSocketUrl("https://api.example.com", 7), "wss://api.example.com/api/v1/live/7/ws");
    assert.equal(liveSocketUrl("http://localhost:5000", 7), "ws://localhost:5000/api/v1/live/7/ws");
    assert.equal(notificationSocketUrl("https://api.example.com"), "wss://api.example.com/api/v1/notifications/ws");
  });
});

// ---------------------------------------------------------------------------
// Worker core: routing + single-socket multiplexing
// ---------------------------------------------------------------------------

describe("RealtimeWorkerCore message routing (Issue #459)", () => {
  it("two tabs sharing one chat channel open a single socket and both receive events", () => {
    const { core } = makeCore();
    const tabA = initTab(core, "tab-a");
    const tabB = initTab(core, "tab-b");

    core.handleMessage("tab-a", { type: "subscribe", channel: chatChannel });
    core.handleMessage("tab-b", { type: "subscribe", channel: chatChannel });

    assert.equal(FakeWebSocket.instances.length, 1, "one socket for two tabs on the same channel");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ready", leagueId: "league-1", userId: "user-1" });

    const frame = { type: "message", message: { id: "m1", body: "hello" } };
    socket.receive(frame);

    const eventsA = tabA.received.filter((m) => m.type === "event");
    const eventsB = tabB.received.filter((m) => m.type === "event");
    assert.equal(eventsA.length, 1);
    assert.equal(eventsB.length, 1);
    assert.deepEqual((eventsA[0] as { frame: unknown }).frame, frame);
    assert.deepEqual((eventsB[0] as { frame: unknown }).frame, frame);
    assert.equal(core.getStats().openSockets, 1);
    assert.equal(core.getStats().subscriptions, 2);
  });

  it("live and notification channels use separate sockets and route independently", () => {
    const { core } = makeCore();
    const tabA = initTab(core, "tab-a");
    const tabB = initTab(core, "tab-b");

    const liveSocket = subscribeReady(core, "tab-a", liveChannel);
    const notifSocket = subscribeReady(core, "tab-b", notificationsChannel);
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.ok(liveSocket.url.includes("/live/7/ws"));
    assert.ok(notifSocket.url.includes("/notifications/ws"));

    liveSocket.receive({ type: "delta", topic: "matchday:7", events: [{ entity: "player-1", data: { points: 5 } }] });
    assert.equal(tabA.received.filter((m) => m.type === "event").length, 1);
    assert.equal(tabB.received.filter((m) => m.type === "event").length, 0);

    notifSocket.receive({ type: "notification", notification: { id: "n1" } });
    assert.equal(tabB.received.filter((m) => m.type === "event").length, 1);
    assert.equal(tabA.received.filter((m) => m.type === "event").length, 1);
  });

  it("send forwards to the channel socket; send with no open socket errors to the sender only", () => {
    const { core } = makeCore();
    const tabA = initTab(core, "tab-a");
    const socket = subscribeReady(core, "tab-a", chatChannel);

    core.handleMessage("tab-a", {
      type: "send",
      channel: chatChannel,
      payload: { type: "message", body: "hi", clientId: "c1" },
    });
    // sent[0] is the auth frame from socket open; sent[1] is the forwarded chat message.
    assert.equal(socket.sent.length, 2);
    assert.deepEqual(JSON.parse(socket.sent[0]), { type: "auth", token: "test-token" });
    assert.deepEqual(JSON.parse(socket.sent[1]), { type: "message", body: "hi", clientId: "c1" });

    // A fresh channel whose socket has not opened yet cannot send.
    const tabB = initTab(core, "tab-b");
    core.handleMessage("tab-b", { type: "subscribe", channel: liveChannel });
    core.handleMessage("tab-b", { type: "send", channel: liveChannel, payload: { type: "ping" } });
    const errors = tabB.received.filter((m) => m.type === "error");
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as { code: string }).code, "socket-not-ready");
    assert.equal(tabA.received.filter((m) => m.type === "error").length, 0);
  });

  it("fan-out latency stays under the 50ms budget in the harness", () => {
    const { core } = makeCore();
    const tabA = initTab(core, "tab-a");
    initTab(core, "tab-b");
    const socket = subscribeReady(core, "tab-a", liveChannel);
    core.handleMessage("tab-b", { type: "subscribe", channel: liveChannel });

    const start = performance.now();
    socket.receive({ type: "delta", topic: "matchday:7", events: [] });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `fan-out took ${elapsed}ms, budget is 50ms`);

    const event = tabA.received.find((m) => m.type === "event") as { dispatchedAt: number } | undefined;
    assert.ok(event && typeof event.dispatchedAt === "number");
    assert.ok(Date.now() - event.dispatchedAt < 50);
  });
});

// ---------------------------------------------------------------------------
// Worker core: tab lifecycle
// ---------------------------------------------------------------------------

describe("RealtimeWorkerCore tab lifecycle (Issue #459)", () => {
  it("unsubscribing the last tab closes the socket; unsubscribing one of two keeps it", () => {
    const { core } = makeCore();
    initTab(core, "tab-a");
    initTab(core, "tab-b");
    const socket = subscribeReady(core, "tab-a", chatChannel);
    core.handleMessage("tab-b", { type: "subscribe", channel: chatChannel });

    core.handleMessage("tab-a", { type: "unsubscribe", channel: chatChannel });
    assert.equal(socket.closed, false, "socket stays open while tab-b is subscribed");
    assert.equal(core.getStats().openSockets, 1);

    core.handleMessage("tab-b", { type: "unsubscribe", channel: chatChannel });
    assert.equal(socket.closed, true, "socket closes when the last subscriber leaves");
    assert.equal(core.getStats().openSockets, 0);
  });

  it("removing a tab cleans up its subscriptions and closes orphaned sockets", () => {
    const { core } = makeCore();
    initTab(core, "tab-a");
    initTab(core, "tab-b");
    const socket = subscribeReady(core, "tab-a", chatChannel);
    core.handleMessage("tab-b", { type: "subscribe", channel: chatChannel });

    core.removePort("tab-a");
    assert.equal(socket.closed, false, "tab-b still subscribed");
    core.removePort("tab-b");
    assert.equal(socket.closed, true, "last tab gone closes the socket");
    assert.equal(core.tabCount, 0);
    assert.deepEqual(core.getStats(), { tabs: 0, channels: 0, openSockets: 0, subscriptions: 0 });
  });

  it("abnormal close schedules a reconnect with backoff; terminal close does not", () => {
    const { core, timers } = makeCore();
    const tabA = initTab(core, "tab-a");
    const socket = subscribeReady(core, "tab-a", chatChannel);

    socket.drop(1006);
    assert.equal(timers.scheduled.length, 1, "reconnect scheduled after abnormal close");
    assert.equal(timers.scheduled[0].ms, 1000, "first backoff step is 1s");
    assert.ok(tabA.received.some((m) => m.type === "status" && m.state === "reconnecting"));

    timers.runAll();
    assert.equal(FakeWebSocket.instances.length, 2, "reconnect opens a fresh socket");
    const socket2 = FakeWebSocket.instances[1];
    socket2.open();
    socket2.receive({ type: "ready", userId: "user-1" });

    socket2.drop(4401);
    assert.equal(timers.scheduled.length, 0, "terminal close never reconnects");
    assert.ok(
      tabA.received.some((m) => m.type === "status" && m.state === "unavailable"),
      "subscribers are told the channel is unavailable"
    );
  });
});

// ---------------------------------------------------------------------------
// Worker core: auth sync
// ---------------------------------------------------------------------------

describe("RealtimeWorkerCore auth sync (Issue #459)", () => {
  it("logout from one tab closes every socket and fans auth-logout to every tab", () => {
    const { core } = makeCore();
    const tabA = initTab(core, "tab-a");
    const tabB = initTab(core, "tab-b");
    const chatSocket = subscribeReady(core, "tab-a", chatChannel);
    const liveSocket = subscribeReady(core, "tab-b", liveChannel);
    core.handleMessage("tab-b", { type: "subscribe", channel: chatChannel });

    core.handleMessage("tab-a", { type: "logout" });

    assert.equal(chatSocket.closed, true);
    assert.equal(liveSocket.closed, true);
    assert.ok(tabA.received.some((m) => m.type === "auth-logout"));
    assert.ok(tabB.received.some((m) => m.type === "auth-logout"));
    assert.deepEqual(core.getStats(), { tabs: 2, channels: 0, openSockets: 0, subscriptions: 0 });
  });

  it("close-sockets drops local sockets without fanning out (broadcast-only tabs)", () => {
    const { core } = makeCore();
    const tabA = initTab(core, "tab-a");
    const socket = subscribeReady(core, "tab-a", liveChannel);

    core.handleMessage("tab-a", { type: "close-sockets" });
    assert.equal(socket.closed, true);
    assert.equal(tabA.received.filter((m) => m.type === "auth-logout").length, 0);
  });
});

// ---------------------------------------------------------------------------
// Bus: fallback ladder
// ---------------------------------------------------------------------------

describe("RealtimeBus fallback selection (Issue #459)", () => {
  it("detectRealtimeMode prefers SharedWorker, then Worker, then broadcast-only", () => {
    assert.equal(detectRealtimeMode({ SharedWorker: function () {}, Worker: function () {} }), "shared-worker");
    assert.equal(detectRealtimeMode({ Worker: function () {} }), "dedicated-worker");
    assert.equal(detectRealtimeMode({}), "broadcast-only");
  });

  it("shared-worker mode subscribes through the port and routes worker events", async () => {
    const posted: unknown[] = [];
    // Holder object: a plain `let` would be narrowed to `null` by control flow.
    const portHandler: { fn: ((event: { data: unknown }) => void) | null } = { fn: null };
    const port = {
      postMessage: (message: unknown) => posted.push(message),
      set onmessage(fn: ((event: { data: unknown }) => void) | null) {
        portHandler.fn = fn;
      },
      get onmessage() {
        return portHandler.fn;
      },
      start: () => {},
    };
    const bus = new RealtimeBus("https://api.example.com", () => "test-token", {
      createSharedWorker: () => ({ port }),
    });
    assert.equal(bus.mode, "shared-worker");

    const seen: unknown[] = [];
    bus.connect();
    bus.subscribe(chatChannel, (frame) => seen.push(frame));
    assert.ok(posted.some((m) => (m as { type: string }).type === "init"));
    assert.ok(posted.some((m) => (m as { type: string }).type === "subscribe"));

    portHandler.fn?.({
      data: {
        type: "event",
        channel: chatChannel,
        frame: { type: "message", message: { id: "m1" } },
        dispatchedAt: Date.now(),
      } satisfies WorkerToTabMessage,
    });
    assert.equal(seen.length, 1);
    assert.ok(bus.getLastLatencyMs() !== null && (bus.getLastLatencyMs() as number) < 50);

    let loggedOut = false;
    bus.onAuthLogout(() => {
      loggedOut = true;
    });
    portHandler.fn?.({ data: { type: "auth-logout", timestamp: Date.now() } satisfies WorkerToTabMessage });
    assert.equal(loggedOut, true);
    bus.disconnect();
  });

  it("dedicated-worker mode is selected when SharedWorker is missing", () => {
    const posted: unknown[] = [];
    const workerHandler: { fn: ((event: { data: unknown }) => void) | null } = { fn: null };
    const worker = {
      postMessage: (message: unknown) => posted.push(message),
      set onmessage(fn: ((event: { data: unknown }) => void) | null) {
        workerHandler.fn = fn;
      },
      get onmessage() {
        return workerHandler.fn;
      },
      terminate: () => {},
    };
    const bus = new RealtimeBus("https://api.example.com", () => "test-token", {
      createWorker: () => worker,
    });
    assert.equal(bus.mode, "dedicated-worker");
    bus.connect();
    bus.subscribe(liveChannel, () => {});
    assert.ok(posted.some((m) => (m as { type: string }).type === "subscribe"));
    bus.disconnect();
  });

  it("broadcast-only mode runs the core in-tab with one socket per channel", () => {
    const bus = new RealtimeBus("https://api.example.com", () => "test-token", {
      createSocket: fakeSocketFactory,
    });
    assert.equal(bus.mode, "broadcast-only");
    bus.connect();

    const seen: unknown[] = [];
    bus.subscribe(liveChannel, (frame) => seen.push(frame));
    bus.subscribe(liveChannel, () => {}); // second local subscriber, same channel
    assert.equal(FakeWebSocket.instances.length, 1, "one in-tab socket for the channel");

    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ready", gameweekId: 7 });
    socket.receive({ type: "delta", topic: "matchday:7", events: [{ entity: "p1", data: { points: 2 } }] });
    assert.equal(seen.length, 1);
    assert.ok((bus.getLastLatencyMs() as number) < 50);
    bus.disconnect();
  });

  it("local subscribe refcounting posts one subscribe and one unsubscribe per channel", () => {
    const posted: unknown[] = [];
    const port = {
      postMessage: (message: unknown) => posted.push(message),
      onmessage: null as ((event: { data: unknown }) => void) | null,
      start: () => {},
    };
    const bus = new RealtimeBus("https://api.example.com", () => "test-token", {
      createSharedWorker: () => ({ port }),
    });
    bus.connect();
    const unsub1 = bus.subscribe(chatChannel, () => {});
    const unsub2 = bus.subscribe(chatChannel, () => {});
    assert.equal(posted.filter((m) => (m as { type: string }).type === "subscribe").length, 1);
    unsub1();
    assert.equal(posted.filter((m) => (m as { type: string }).type === "unsubscribe").length, 0);
    unsub2();
    assert.equal(posted.filter((m) => (m as { type: string }).type === "unsubscribe").length, 1);
    bus.disconnect();
  });

  it("ping measures a finite worker round-trip", async () => {
    const posted: unknown[] = [];
    const portHandler: { fn: ((event: { data: unknown }) => void) | null } = { fn: null };
    const port = {
      postMessage: (message: unknown) => {
        posted.push(message);
        const ping = message as { type: string; id?: string };
        if (ping.type === "ping") {
          portHandler.fn?.({ data: { type: "pong", id: ping.id, at: Date.now() } });
        }
      },
      set onmessage(fn: ((event: { data: unknown }) => void) | null) {
        portHandler.fn = fn;
      },
      get onmessage() {
        return portHandler.fn;
      },
      start: () => {},
    };
    const bus = new RealtimeBus("https://api.example.com", () => "test-token", {
      createSharedWorker: () => ({ port }),
    });
    bus.connect();
    const ms = await bus.ping();
    assert.ok(Number.isFinite(ms) && ms < 50, `ping took ${ms}ms`);
    bus.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Bus: cross-tab auth fan-out over BroadcastChannel
// ---------------------------------------------------------------------------

describe("RealtimeBus cross-tab logout (Issue #459)", () => {
  it("logout in one broadcast-only tab signs out the other via BroadcastChannel and closes local sockets", () => {
    const hub = new FakeBroadcastHub();
    const makeBus = () =>
      new RealtimeBus("https://api.example.com", () => "test-token", {
        createSocket: fakeSocketFactory,
        createBroadcastChannel: () => new FakeBroadcastChannel(hub),
      });

    const busA = makeBus();
    const busB = makeBus();
    busA.connect();
    busB.connect();

    busA.subscribe(liveChannel, () => {});
    assert.equal(FakeWebSocket.instances.length, 1);
    const socketA = FakeWebSocket.instances[0];
    socketA.open();
    socketA.receive({ type: "ready", gameweekId: 7 });

    let busBLoggedOut = false;
    busB.onAuthLogout(() => {
      busBLoggedOut = true;
    });

    busA.notifyLogout();
    assert.equal(busBLoggedOut, true, "tab B signs out when tab A logs out");
    assert.equal(socketA.closed, true, "tab A's sockets close on logout");
    busA.disconnect();
    busB.disconnect();
  });
});
