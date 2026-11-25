/**
 * RealtimeBus (Issue #459)
 *
 * Tab-side client for the SharedWorker broadcast architecture. Each tab
 * talks to one worker; the worker owns the server sockets and fans frames
 * out to every subscribed tab.
 *
 * Fallback ladder (Safari / iOS restrict SharedWorker):
 *   1. shared-worker     — one SharedWorker for the whole origin; N tabs
 *                          share one socket per channel.
 *   2. dedicated-worker  — same worker script as a plain Worker; the socket
 *                          still lives off the main thread, but each tab
 *                          gets its own worker (and its own sockets).
 *   3. broadcast-only    — no worker at all; the multiplexing core runs
 *                          in-tab and cross-tab sync rides BroadcastChannel
 *                          (+ the localStorage fallback in
 *                          useCrossTabSessionSync).
 *
 * Auth sync: `notifyLogout()` tells the worker to close every socket and
 * fan `auth-logout` to every tab, and also posts to BroadcastChannel so
 * tabs in fallback modes (or with a dead worker) still sign out instantly.
 * Handlers must be idempotent: the originating tab receives its own
 * logout fan-out as well.
 */

import { RealtimeWorkerCore, type MinimalWebSocketFactory } from "./workerCore";
import {
  channelKey,
  REALTIME_BUS_CHANNEL_NAME,
  type BusBroadcastMessage,
  type RealtimeChannel,
  type RealtimeMode,
  type TabToWorkerMessage,
  type WorkerToTabMessage,
} from "./protocol";
import { createClientId } from "../chat";

export function detectRealtimeMode(env: {
  SharedWorker?: unknown;
  Worker?: unknown;
}): RealtimeMode {
  if (typeof env.SharedWorker !== "undefined") return "shared-worker";
  if (typeof env.Worker !== "undefined") return "dedicated-worker";
  return "broadcast-only";
}

export type RealtimeEventHandler = (frame: unknown, meta: { dispatchedAt: number; latencyMs: number }) => void;

interface Transport {
  postMessage(message: TabToWorkerMessage): void;
  terminate(): void;
}

interface BusDeps {
  createSharedWorker?: (url: URL) => {
    port: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null; start?: () => void };
  };
  createWorker?: (url: URL) => {
    postMessage: (m: unknown) => void;
    onmessage: ((e: { data: unknown }) => void) | null;
    terminate: () => void;
  };
  createBroadcastChannel?: (name: string) => {
    postMessage: (m: unknown) => void;
    onmessage: ((e: { data: unknown }) => void) | null;
    close: () => void;
  };
  createSocket?: MinimalWebSocketFactory;
  now?: () => number;
}

const WORKER_URL = new URL("../../workers/sharedRealtime.worker.ts", import.meta.url);

export class RealtimeBus {
  readonly mode: RealtimeMode;
  readonly tabId: string;

  private readonly apiBaseUrl: string;
  private readonly getToken: () => string | null;
  private readonly deps: BusDeps;
  private readonly now: () => number;

  private transport: Transport | null = null;
  private broadcastChannel: { postMessage: (m: unknown) => void; close: () => void } | null = null;
  private connected = false;
  /** Hook instances sharing this singleton; teardown happens at zero. */
  private connectCount = 0;

  private readonly handlers = new Map<string, Set<RealtimeEventHandler>>();
  private readonly authLogoutHandlers = new Set<() => void>();
  private readonly pendingPings = new Map<string, { sentAt: number; resolve: (ms: number) => void }>();
  private lastLatencyMs: number | null = null;

  constructor(apiBaseUrl: string, getToken: () => string | null, deps: BusDeps = {}) {
    this.apiBaseUrl = apiBaseUrl;
    this.getToken = getToken;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.tabId = createClientId();
    this.mode = detectRealtimeMode({
      SharedWorker: deps.createSharedWorker ? function () {} : (globalThis as { SharedWorker?: unknown }).SharedWorker,
      Worker: deps.createWorker ? function () {} : (globalThis as { Worker?: unknown }).Worker,
    });
  }

  /** Open the worker / in-tab core and the BroadcastChannel. Refcounted: every connect() needs a matching disconnect(). */
  connect(): void {
    if (typeof window === "undefined") return;
    this.connectCount += 1;
    if (this.connected) return;
    this.connected = true;
    this.transport = this.createTransport();
    this.transport.postMessage({ type: "init", tabId: this.tabId, apiBaseUrl: this.apiBaseUrl, token: this.getToken() });
    // Re-announce subscriptions that were registered before connect().
    for (const key of this.handlers.keys()) {
      const channel = this.channelFromKey(key);
      if (channel) this.transport.postMessage({ type: "subscribe", channel });
    }

    if (this.deps.createBroadcastChannel) {
      const channel = this.deps.createBroadcastChannel(REALTIME_BUS_CHANNEL_NAME);
      channel.onmessage = (event) => this.handleBroadcastMessage(event.data as BusBroadcastMessage);
      this.broadcastChannel = channel;
    } else if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(REALTIME_BUS_CHANNEL_NAME);
      channel.onmessage = (event) => this.handleBroadcastMessage(event.data as BusBroadcastMessage);
      this.broadcastChannel = channel;
    }
  }

  /** Tear down the worker connection and BroadcastChannel once the last holder disconnects. */
  disconnect(): void {
    if (this.connectCount > 0) this.connectCount -= 1;
    if (this.connectCount > 0 || !this.connected) return;
    this.connected = false;
    try {
      this.transport?.postMessage({ type: "tab-closing" });
    } catch {
      // transport already gone
    }
    this.transport?.terminate();
    this.transport = null;
    this.broadcastChannel?.close();
    this.broadcastChannel = null;
    this.pendingPings.clear();
  }

  /**
   * Subscribe to a channel. Locally refcounted: the worker only hears
   * about the first subscriber in this tab and the last unsubscribe.
   */
  subscribe(channel: RealtimeChannel, handler: RealtimeEventHandler): () => void {
    const key = channelKey(channel);
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
      this.transport?.postMessage({ type: "subscribe", channel });
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(key);
        this.transport?.postMessage({ type: "unsubscribe", channel });
      }
    };
  }

  /** Send a payload to the server over the channel's socket (e.g. a chat message). */
  send(channel: RealtimeChannel, payload: Record<string, unknown>): void {
    this.transport?.postMessage({ type: "send", channel, payload });
  }

  /** Push a fresh auth token to the worker (login / refresh). */
  setToken(token: string | null): void {
    this.transport?.postMessage({ type: "set-token", token });
  }

  /**
   * Log out everywhere: the worker closes every socket and fans
   * `auth-logout` to all tabs, and BroadcastChannel covers tabs whose
   * worker is down or in broadcast-only mode.
   */
  notifyLogout(): void {
    this.transport?.postMessage({ type: "logout" });
    const message: BusBroadcastMessage = { type: "auth-logout", timestamp: this.now(), originTabId: this.tabId };
    try {
      this.broadcastChannel?.postMessage(message);
    } catch {
      // channel closed; worker fan-out still covers connected tabs
    }
  }

  /** Register a handler for logouts broadcast from other tabs. */
  onAuthLogout(handler: () => void): () => void {
    this.authLogoutHandlers.add(handler);
    return () => {
      this.authLogoutHandlers.delete(handler);
    };
  }

  /** Worker round-trip in ms; used to prove the <50ms delivery budget in tests. */
  ping(): Promise<number> {
    return new Promise((resolve) => {
      if (!this.transport) {
        resolve(Number.POSITIVE_INFINITY);
        return;
      }
      const id = createClientId();
      this.pendingPings.set(id, { sentAt: this.now(), resolve });
      this.transport?.postMessage({ type: "ping", id });
    });
  }

  /** Last measured worker-to-tab fan-out latency, if any event has arrived. */
  getLastLatencyMs(): number | null {
    return this.lastLatencyMs;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -- internals -------------------------------------------------------------

  private createTransport(): Transport {
    if (this.mode === "shared-worker") {
      const worker = this.deps.createSharedWorker
        ? this.deps.createSharedWorker(WORKER_URL)
        : new SharedWorker(WORKER_URL);
      worker.port.onmessage = (event: { data: unknown }) => this.handleWorkerMessage(event.data as WorkerToTabMessage);
      worker.port.start?.();
      return {
        postMessage: (message) => worker.port.postMessage(message),
        terminate: () => {
          // SharedWorkers have no terminate; closing the port drops this tab.
          worker.port.onmessage = null;
        },
      };
    }

    if (this.mode === "dedicated-worker") {
      const worker = this.deps.createWorker
        ? this.deps.createWorker(WORKER_URL)
        : new Worker(WORKER_URL);
      worker.onmessage = (event: { data: unknown }) => this.handleWorkerMessage(event.data as WorkerToTabMessage);
      return {
        postMessage: (message) => worker.postMessage(message),
        terminate: () => worker.terminate(),
      };
    }

    // broadcast-only: run the core in-tab behind a loopback port pair.
    const createSocket: MinimalWebSocketFactory =
      this.deps.createSocket ??
      (Object.assign((url: string) => new WebSocket(url), {
        OPEN: WebSocket.OPEN,
        CONNECTING: WebSocket.CONNECTING,
      }) as unknown as MinimalWebSocketFactory);
    const core = new RealtimeWorkerCore({ createSocket, now: this.now });
    const portId = `intab-${this.tabId}`;
    core.addPort(portId, {
      postMessage: (message) => this.handleWorkerMessage(message),
    });
    return {
      postMessage: (message) => core.handleMessage(portId, message),
      terminate: () => core.removePort(portId),
    };
  }

  private handleWorkerMessage(message: WorkerToTabMessage): void {
    switch (message.type) {
      case "event": {
        const latencyMs = Math.max(0, this.now() - message.dispatchedAt);
        this.lastLatencyMs = latencyMs;
        const set = this.handlers.get(channelKey(message.channel));
        if (!set) return;
        for (const handler of [...set]) {
          handler(message.frame, { dispatchedAt: message.dispatchedAt, latencyMs });
        }
        break;
      }
      case "auth-logout": {
        this.closeLocalSocketsIfBroadcastOnly();
        for (const handler of [...this.authLogoutHandlers]) handler();
        break;
      }
      case "pong": {
        const pending = this.pendingPings.get(message.id);
        if (pending) {
          this.pendingPings.delete(message.id);
          pending.resolve(Math.max(0, this.now() - pending.sentAt));
        }
        break;
      }
      case "subscribed":
      case "unsubscribed":
      case "status":
      case "error":
        // Delivered to subscribers via the hook layer when needed; the bus
        // itself only routes events and auth fan-out.
        break;
    }
  }

  private handleBroadcastMessage(message: BusBroadcastMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "auth-logout") {
      if (message.originTabId === this.tabId) return; // own echo
      this.closeLocalSocketsIfBroadcastOnly();
      for (const handler of [...this.authLogoutHandlers]) handler();
    }
  }

  /**
   * In broadcast-only mode each tab runs its own core, so a logout seen
   * from another tab must close this tab's sockets too. Worker modes
   * already closed every socket on the originating tab's logout.
   */
  private closeLocalSocketsIfBroadcastOnly(): void {
    if (this.mode === "broadcast-only") {
      this.transport?.postMessage({ type: "close-sockets" });
    }
  }

  private channelFromKey(key: string): RealtimeChannel | null {
    if (key === "notifications") return { kind: "notifications" };
    if (key === "auth") return { kind: "auth" };
    if (key.startsWith("live:")) {
      const gameweekId = Number(key.slice("live:".length));
      return Number.isSafeInteger(gameweekId) ? { kind: "live", gameweekId } : null;
    }
    if (key.startsWith("chat:")) return { kind: "chat", leagueId: key.slice("chat:".length) };
    return null;
  }
}

let singleton: RealtimeBus | null = null;

/** Process-wide tab bus. Callers must call `connect()` (the hook does). */
export function getRealtimeBus(apiBaseUrl: string, getToken: () => string | null): RealtimeBus {
  if (!singleton) singleton = new RealtimeBus(apiBaseUrl, getToken);
  return singleton;
}
