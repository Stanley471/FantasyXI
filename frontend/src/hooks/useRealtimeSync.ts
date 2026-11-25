/**
 * useRealtimeSync (Issue #459)
 *
 * React binding for the SharedWorker broadcast bus. Components subscribe to
 * live points, notification badges, chat, or auth-sync events; the bus
 * multiplexes them over the worker's single socket per channel and fans
 * updates out to every open tab.
 *
 * The hook owns the bus connection for the tab: it connects on mount (once
 * a token is available, so the worker can authenticate its sockets) and
 * disconnects on unmount. The bus itself is refcounted, so several mounted
 * hooks share one connection. Auth logout in any tab arrives via the bus
 * and fires `onAuthLogout` — AuthContext wires that to its sign-out path.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api";
import { getRealtimeBus, type RealtimeBus, type RealtimeEventHandler } from "@/lib/realtime/realtimeBus";
import type { RealtimeChannel, RealtimeMode } from "@/lib/realtime/protocol";

export interface UseRealtimeSyncOptions {
  token?: string | null;
  /** Channels to subscribe to while mounted (e.g. live gameweek, league chat). */
  channels?: RealtimeChannel[];
  onEvent?: (channel: RealtimeChannel, frame: unknown, meta: { dispatchedAt: number; latencyMs: number }) => void;
  onNotification?: (notification: unknown, meta: { dispatchedAt: number; latencyMs: number }) => void;
  onAuthLogout?: () => void;
}

export interface UseRealtimeSyncResult {
  bus: RealtimeBus;
  mode: RealtimeMode;
  connected: boolean;
  /** Last measured worker-to-tab fan-out latency, if any event has arrived. */
  lastLatencyMs: number | null;
}

export function useRealtimeSync(options: UseRealtimeSyncOptions = {}): UseRealtimeSyncResult {
  const { token, channels, onEvent, onNotification, onAuthLogout } = options;
  const [connected, setConnected] = useState(false);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [bus] = useState(() =>
    getRealtimeBus(API_BASE_URL, () => (typeof window === "undefined" ? null : localStorage.getItem("token")))
  );

  // Latest callbacks/channels, read inside effects only (never during render).
  const latestRef = useRef({ onEvent, onNotification, onAuthLogout, channels });
  useEffect(() => {
    latestRef.current = { onEvent, onNotification, onAuthLogout, channels };
  });

  useEffect(() => {
    bus.connect();
    // Syncing state after connect: defer so the effect body itself does not
    // call setState synchronously.
    queueMicrotask(() => setConnected(bus.isConnected()));
    bus.setToken(token ?? null);

    const latest = latestRef.current;
    const unsubscribes = (latest.channels ?? []).map((channel) =>
      bus.subscribe(channel, (frame, meta) => {
        setLastLatencyMs(meta.latencyMs);
        latestRef.current.onEvent?.(channel, frame, meta);
        if (channel.kind === "notifications") latestRef.current.onNotification?.(frame, meta);
      })
    );
    const unsubscribeAuth = bus.onAuthLogout(() => latestRef.current.onAuthLogout?.());

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      unsubscribeAuth();
      bus.disconnect();
      queueMicrotask(() => setConnected(false));
    };
    // Re-connect only when the token identity changes; channel changes are
    // handled by the caller's own subscribe calls on the returned bus.
  }, [bus, token]);

  return { bus, mode: bus.mode, connected, lastLatencyMs };
}

/** Convenience handler type for components subscribing directly to the bus. */
export type { RealtimeEventHandler };
