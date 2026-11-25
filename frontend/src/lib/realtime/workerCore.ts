/**
 * RealtimeWorkerCore (Issue #459)
 *
 * The multiplexing engine that runs inside the SharedWorker (and, in
 * fallback modes, inside a dedicated Worker or directly on the tab's main
 * thread). It owns exactly one WebSocket per channel key and fans every
 * server frame out to all tabs subscribed to that channel.
 *
 * Design notes:
 * - Environment-agnostic: sockets, timers and the clock are injected, so
 *   the same core is unit-testable with fakes and runs unchanged in a
 *   SharedWorker, a dedicated Worker, or the main thread.
 * - One socket per channel key: two tabs watching the same league chat or
 *   the same gameweek share one server connection; the socket only closes
 *   when the last subscriber leaves (or its tab disconnects).
 * - Auth is a local channel: a `logout` from any tab closes every socket
 *   and fans an `auth-logout` frame to every connected port, so all tabs
 *   sign out instantly without a reload.
 * - Reconnects reuse the chat backoff (`reconnectDelay` from lib/chat):
 *   1s, 2s, 4s ... capped at 30s with jitter. Terminal close codes
 *   (4401/4403/4404/4408) never reconnect; subscribers are told the
 *   channel is unavailable instead.
 */

import { chatSocketUrl, reconnectDelay, TERMINAL_CLOSE_CODES } from "../chat";
import {
  channelKey,
  liveSocketUrl,
  notificationSocketUrl,
  REALTIME_TERMINAL_CLOSE_CODES,
  type RealtimeChannel,
  type TabToWorkerMessage,
  type WorkerToTabMessage,
} from "./protocol";

/** Minimal surface of WebSocket the core needs (real or fake). */
export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface MinimalWebSocketFactory {
  (url: string): MinimalWebSocket;
  readonly OPEN: number;
  readonly CONNECTING: number;
}

/** Minimal surface of a MessagePort (real or fake). */
export interface MinimalPort {
  postMessage(message: WorkerToTabMessage): void;
}

export interface WorkerCoreDeps {
  createSocket: MinimalWebSocketFactory;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  random?: () => number;
  /** Test/observability hook: called every time a server socket is opened. */
  onSocketOpened?: (url: string, channel: RealtimeChannel) => void;
  /** Test/observability hook: called every time a server socket is closed. */
  onSocketClosed?: (url: string, channel: RealtimeChannel) => void;
}

interface PortRecord {
  port: MinimalPort;
  subscriptions: Set<string>;
}

interface ChannelRecord {
  channel: RealtimeChannel;
  socket: MinimalWebSocket | null;
  socketUrl: string | null;
  state: "connecting" | "open" | "reconnecting" | "unavailable";
  attempt: number;
  reconnectTimer: unknown | null;
  subscribers: Set<string>;
}

export interface WorkerCoreStats {
  tabs: number;
  channels: number;
  openSockets: number;
  subscriptions: number;
}

export class RealtimeWorkerCore {
  private readonly createSocket: MinimalWebSocketFactory;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (id: unknown) => void;
  private readonly random: () => number;
  private readonly onSocketOpened?: (url: string, channel: RealtimeChannel) => void;
  private readonly onSocketClosed?: (url: string, channel: RealtimeChannel) => void;

  private apiBaseUrl: string | null = null;
  private token: string | null = null;
  private readonly ports = new Map<string, PortRecord>();
  private readonly channels = new Map<string, ChannelRecord>();

  constructor(deps: WorkerCoreDeps) {
    this.createSocket = deps.createSocket;
    this.now = deps.now ?? (() => Date.now());
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.random = deps.random ?? Math.random;
    this.onSocketOpened = deps.onSocketOpened;
    this.onSocketClosed = deps.onSocketClosed;
  }

  // -- tab lifecycle -------------------------------------------------------

  /** Register a tab's port. The tab must send `init` before subscribing. */
  addPort(tabId: string, port: MinimalPort): void {
    this.ports.set(tabId, { port, subscriptions: new Set() });
  }

  /**
   * Drop a tab: unsubscribe it from everything and close any socket left
   * with no subscribers. Called when a tab closes or its port errors.
   */
  removePort(tabId: string): void {
    const record = this.ports.get(tabId);
    if (!record) return;
    this.ports.delete(tabId);
    for (const key of [...record.subscriptions]) {
      const channel = this.channels.get(key);
      if (!channel) continue;
      channel.subscribers.delete(tabId);
      if (channel.subscribers.size === 0) this.teardownChannel(key);
    }
  }

  /** Number of tabs currently connected. */
  get tabCount(): number {
    return this.ports.size;
  }

  getStats(): WorkerCoreStats {
    let subscriptions = 0;
    let openSockets = 0;
    for (const channel of this.channels.values()) {
      subscriptions += channel.subscribers.size;
      if (channel.socket) openSockets += 1;
    }
    return { tabs: this.ports.size, channels: this.channels.size, openSockets, subscriptions };
  }

  // -- message handling ----------------------------------------------------

  handleMessage(tabId: string, message: TabToWorkerMessage): void {
    const record = this.ports.get(tabId);
    if (!record && message.type !== "init") return;

    switch (message.type) {
      case "init": {
        this.apiBaseUrl = message.apiBaseUrl;
        this.token = message.token;
        if (!record) {
          // init arrived before addPort in dedicated-Worker mode; the port
          // is attached by the caller right after, subscriptions queue below
        }
        break;
      }
      case "set-token": {
        this.token = message.token;
        break;
      }
      case "subscribe": {
        if (!record) return;
        if (message.channel.kind === "auth") {
          record.subscriptions.add(channelKey(message.channel));
          this.postTo(tabId, { type: "subscribed", channel: message.channel });
          break;
        }
        this.subscribe(tabId, message.channel);
        break;
      }
      case "unsubscribe": {
        this.unsubscribe(tabId, message.channel);
        break;
      }
      case "send": {
        this.forwardToServer(tabId, message.channel, message.payload);
        break;
      }
      case "logout": {
        this.broadcastLogout();
        break;
      }
      case "close-sockets": {
        // A logout observed from another tab (broadcast-only mode, where
        // each tab runs its own core): drop the local sockets without
        // fanning anything out again.
        for (const key of [...this.channels.keys()]) this.teardownChannel(key);
        break;
      }
      case "ping": {
        this.postTo(tabId, { type: "pong", id: message.id, at: this.now() });
        break;
      }
      case "tab-closing": {
        this.removePort(tabId);
        break;
      }
    }
  }

  // -- subscriptions ---------------------------------------------------------

  private subscribe(tabId: string, channel: RealtimeChannel): void {
    const record = this.ports.get(tabId);
    if (!record) return;
    const key = channelKey(channel);
    record.subscriptions.add(key);

    let entry = this.channels.get(key);
    if (!entry) {
      entry = {
        channel,
        socket: null,
        socketUrl: null,
        state: "connecting",
        attempt: 0,
        reconnectTimer: null,
        subscribers: new Set(),
      };
      this.channels.set(key, entry);
    }
    entry.subscribers.add(tabId);

    if (!entry.socket) {
      this.openSocket(key, entry);
    } else {
      this.postTo(tabId, {
        type: "status",
        channel,
        state: entry.state,
      });
    }
    this.postTo(tabId, { type: "subscribed", channel });
  }

  private unsubscribe(tabId: string, channel: RealtimeChannel): void {
    const record = this.ports.get(tabId);
    const key = channelKey(channel);
    record?.subscriptions.delete(key);
    const entry = this.channels.get(key);
    if (!entry) return;
    entry.subscribers.delete(tabId);
    this.postTo(tabId, { type: "unsubscribed", channel });
    if (entry.subscribers.size === 0) this.teardownChannel(key);
  }

  // -- sockets ---------------------------------------------------------------

  private socketUrlFor(channel: RealtimeChannel): string | null {
    if (!this.apiBaseUrl) return null;
    switch (channel.kind) {
      case "live":
        return liveSocketUrl(this.apiBaseUrl, channel.gameweekId);
      case "chat":
        return chatSocketUrl(this.apiBaseUrl, channel.leagueId);
      case "notifications":
        return notificationSocketUrl(this.apiBaseUrl);
      case "auth":
        return null;
    }
  }

  private openSocket(key: string, entry: ChannelRecord): void {
    const url = this.socketUrlFor(entry.channel);
    if (!url) {
      entry.state = "unavailable";
      this.broadcastToChannel(key, {
        type: "status",
        channel: entry.channel,
        state: "unavailable",
        reason: "Realtime worker has no API base URL yet (missing init).",
      });
      return;
    }
    entry.socketUrl = url;
    entry.state = "connecting";
    const socket = this.createSocket(url);
    entry.socket = socket;
    this.onSocketOpened?.(url, entry.channel);
    this.broadcastToChannel(key, { type: "status", channel: entry.channel, state: "connecting" });

    socket.onopen = () => {
      if (this.token) {
        socket.send(JSON.stringify({ type: "auth", token: this.token }));
      } else {
        // No token: the server closes unauthenticated sockets (4401) and
        // the close handler reports the channel unavailable.
        socket.close(4401, "No auth token");
      }
    };

    socket.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame && typeof frame === "object" && (frame as { type?: unknown }).type === "ready") {
        entry.state = "open";
        entry.attempt = 0;
        this.broadcastToChannel(key, { type: "status", channel: entry.channel, state: "open" });
        return;
      }
      // Fan every other server frame out to all subscribed tabs, stamped
      // so tabs can measure end-to-end delivery latency.
      this.broadcastToChannel(key, {
        type: "event",
        channel: entry.channel,
        frame,
        dispatchedAt: this.now(),
      });
    };

    socket.onclose = (event) => {
      if (entry.socket !== socket) return; // superseded by a newer socket
      entry.socket = null;
      this.onSocketClosed?.(url, entry.channel);
      if (entry.subscribers.size === 0) {
        this.channels.delete(key);
        return;
      }
      if (TERMINAL_CLOSE_CODES.has(event.code) || REALTIME_TERMINAL_CLOSE_CODES.has(event.code)) {
        entry.state = "unavailable";
        this.broadcastToChannel(key, {
          type: "status",
          channel: entry.channel,
          state: "unavailable",
          reason: `Socket closed with terminal code ${event.code}.`,
        });
        return;
      }
      entry.state = "reconnecting";
      this.broadcastToChannel(key, { type: "status", channel: entry.channel, state: "reconnecting" });
      const delay = reconnectDelay(entry.attempt++, this.random);
      entry.reconnectTimer = this.setTimeoutFn(() => {
        entry.reconnectTimer = null;
        if (entry.subscribers.size > 0 && this.channels.get(key) === entry) {
          this.openSocket(key, entry);
        }
      }, delay);
    };

    socket.onerror = () => {
      // onclose follows and drives reconnect/unavailable handling.
    };
  }

  private teardownChannel(key: string): void {
    const entry = this.channels.get(key);
    if (!entry) return;
    this.channels.delete(key);
    if (entry.reconnectTimer !== null) {
      this.clearTimeoutFn(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.socket) {
      const socket = entry.socket;
      entry.socket = null;
      socket.onclose = null;
      socket.close(1000, "No subscribers left");
    }
  }

  private forwardToServer(tabId: string, channel: RealtimeChannel, payload: Record<string, unknown>): void {
    const entry = this.channels.get(channelKey(channel));
    if (!entry?.socket || entry.socket.readyState !== this.createSocket.OPEN) {
      this.postTo(tabId, {
        type: "error",
        channel,
        code: "socket-not-ready",
        message: "Realtime socket is not open; the message was not sent.",
      });
      return;
    }
    entry.socket.send(JSON.stringify(payload));
  }

  // -- auth fan-out ------------------------------------------------------------

  /**
   * A logout in any tab: close every server socket, drop every
   * subscription, and tell every connected tab to sign out now.
   */
  broadcastLogout(): void {
    const timestamp = this.now();
    for (const key of [...this.channels.keys()]) this.teardownChannel(key);
    for (const [tabId] of this.ports) {
      this.postTo(tabId, { type: "auth-logout", timestamp });
    }
  }

  // -- delivery helpers ------------------------------------------------------

  private postTo(tabId: string, message: WorkerToTabMessage): void {
    this.ports.get(tabId)?.port.postMessage(message);
  }

  private broadcastToChannel(key: string, message: WorkerToTabMessage): void {
    const entry = this.channels.get(key);
    if (!entry) return;
    for (const tabId of entry.subscribers) this.postTo(tabId, message);
  }
}
