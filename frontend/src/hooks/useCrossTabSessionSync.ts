/**
 * Cross-Tab and Multi-Device Session Invalidation Sync Hook
 *
 * Implements:
 * 1. Client-side storage listeners syncing logouts across open tabs.
 * 2. BroadcastChannel cross-tab message bus.
 * 3. SSE event listener for instant remote multi-device revocations.
 */

import { useEffect, useRef } from "react";

export const SESSION_SYNC_STORAGE_KEY = "fantasyxi_session_sync";
export const SESSION_SYNC_CHANNEL_NAME = "fantasyxi_session_channel";

export interface SessionSyncMessage {
  type: "LOGOUT" | "SESSION_REVOKED" | "TOKEN_EXPIRED";
  userId?: string;
  sessionId?: string;
  timestamp: number;
}

export function broadcastSessionRevocation(message: SessionSyncMessage): void {
  if (typeof window === "undefined") return;

  try {
    // 1. BroadcastChannel (modern fast inter-tab bus)
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(SESSION_SYNC_CHANNEL_NAME);
      channel.postMessage(message);
      channel.close();
    }

    // 2. localStorage event (fallback compatible across all browsers/same-origin tabs)
    localStorage.setItem(SESSION_SYNC_STORAGE_KEY, JSON.stringify(message));
  } catch (err) {
    console.warn("[session-sync] Failed to broadcast session event:", err);
  }
}

export function useCrossTabSessionSync(options: {
  onSessionRevoked: (message: SessionSyncMessage) => void;
  token?: string | null;
  enableSse?: boolean;
}): void {
  const { onSessionRevoked, token, enableSse = true } = options;
  const callbackRef = useRef(onSessionRevoked);
  callbackRef.current = onSessionRevoked;

  useEffect(() => {
    if (typeof window === "undefined") return;

    // 1. Storage Event Listener (triggers in all other tabs when localStorage changes)
    const handleStorage = (event: StorageEvent) => {
      if (event.key === SESSION_SYNC_STORAGE_KEY && event.newValue) {
        try {
          const parsed: SessionSyncMessage = JSON.parse(event.newValue);
          callbackRef.current(parsed);
        } catch {
          // ignore parsing error
        }
      }
    };
    window.addEventListener("storage", handleStorage);

    // 2. BroadcastChannel Listener
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(SESSION_SYNC_CHANNEL_NAME);
        channel.onmessage = (event) => {
          if (event.data) {
            callbackRef.current(event.data);
          }
        };
      } catch {
        // BroadcastChannel unavailable
      }
    }

    // 3. Optional SSE stream for remote device revocation
    let eventSource: EventSource | null = null;
    if (enableSse && token && typeof EventSource !== "undefined") {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
        eventSource = new EventSource(`${apiUrl}/api/v1/auth/sessions/events`);
        eventSource.addEventListener("session_revoked", (e) => {
          try {
            const data = JSON.parse(e.data);
            callbackRef.current({
              type: "SESSION_REVOKED",
              sessionId: data.revokedSessionId,
              timestamp: Date.now(),
            });
          } catch {}
        });
      } catch {
        // SSE connection failure
      }
    }

    return () => {
      window.removeEventListener("storage", handleStorage);
      if (channel) {
        channel.close();
      }
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [token, enableSse]);
}
