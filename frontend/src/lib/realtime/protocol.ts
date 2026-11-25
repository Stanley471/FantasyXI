/**
 * Cross-tab realtime protocol (Issue #459)
 *
 * Shared message vocabulary for the SharedWorker broadcast architecture:
 * every open tab talks to one worker, the worker owns the real WebSocket
 * connections, and server frames are fanned out to every subscribed tab.
 *
 * Channels mirror the backend's three realtime endpoints:
 *   live          -> ws(s)://<api>/api/v1/live/:gameweekId/ws
 *   chat          -> ws(s)://<api>/api/v1/leagues/:leagueId/chat/ws
 *   notifications -> ws(s)://<api>/api/v1/notifications/ws
 *   auth          -> no socket; local fan-out only (login/logout sync)
 *
 * The worker and the tab-side bus both import this module, so keep it free
 * of DOM, React and Node-only APIs.
 */

/** One multiplexed stream. Exactly one server socket exists per channel key. */
export type RealtimeChannel =
  | { kind: "live"; gameweekId: number }
  | { kind: "chat"; leagueId: string }
  | { kind: "notifications" }
  | { kind: "auth" };

/** Transport the tab-side bus is running on. */
export type RealtimeMode = "shared-worker" | "dedicated-worker" | "broadcast-only";

/** BroadcastChannel name the bus uses for auth fan-out and fallback sync. */
export const REALTIME_BUS_CHANNEL_NAME = "fantasyxi_realtime_bus";

/** Close codes after which reconnecting cannot help (see backend realtime servers). */
export const REALTIME_TERMINAL_CLOSE_CODES = new Set([4401, 4403, 4404, 4408]);

/** Stable key for a channel: one socket per key, shared by every tab. */
export function channelKey(channel: RealtimeChannel): string {
  switch (channel.kind) {
    case "live":
      return `live:${channel.gameweekId}`;
    case "chat":
      return `chat:${channel.leagueId}`;
    case "notifications":
      return "notifications";
    case "auth":
      return "auth";
  }
}

/** WebSocket URL for a gameweek's live-points stream, derived from the REST API base URL. */
export function liveSocketUrl(apiBaseUrl: string, gameweekId: number): string {
  const url = new URL(`/api/v1/live/${gameweekId}/ws`, apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** WebSocket URL for the per-user notification stream. */
export function notificationSocketUrl(apiBaseUrl: string): string {
  const url = new URL("/api/v1/notifications/ws", apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

// ---------------------------------------------------------------------------
// Tab <-> worker messages
// ---------------------------------------------------------------------------

export type TabToWorkerMessage =
  | { type: "init"; tabId: string; apiBaseUrl: string; token: string | null }
  | { type: "set-token"; token: string | null }
  | { type: "subscribe"; channel: RealtimeChannel }
  | { type: "unsubscribe"; channel: RealtimeChannel }
  | { type: "send"; channel: RealtimeChannel; payload: Record<string, unknown> }
  | { type: "logout" }
  | { type: "close-sockets" }
  | { type: "ping"; id: string }
  | { type: "tab-closing" };

export type WorkerToTabMessage =
  | { type: "subscribed"; channel: RealtimeChannel }
  | { type: "unsubscribed"; channel: RealtimeChannel }
  | { type: "event"; channel: RealtimeChannel; frame: unknown; dispatchedAt: number }
  | { type: "status"; channel: RealtimeChannel; state: "connecting" | "open" | "reconnecting" | "unavailable"; reason?: string }
  | { type: "error"; channel: RealtimeChannel; code: string; message: string }
  | { type: "auth-logout"; timestamp: number }
  | { type: "pong"; id: string; at: number };

/** Messages the bus relays over BroadcastChannel (fallback / auth fan-out). */
export type BusBroadcastMessage =
  | { type: "auth-logout"; timestamp: number; originTabId: string }
  | { type: "event"; channel: RealtimeChannel; frame: unknown; dispatchedAt: number };

export function isTabToWorkerMessage(value: unknown): value is TabToWorkerMessage {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
