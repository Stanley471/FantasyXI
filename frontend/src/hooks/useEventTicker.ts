import { useEffect, useRef, useCallback, useState } from "react";
import type { TimelineEvent } from "@/types";

interface EventTickerFrame {
  type: "delta" | "ready" | "error";
  gameweekId?: number;
  resyncRequired?: boolean;
  topic?: string;
  events?: TimelineEvent[];
  message?: string;
}

type EventCallback = (event: TimelineEvent) => void;
type ConnectionStateCallback = (state: "connecting" | "open" | "reconnecting" | "closed") => void;

interface EventTickerOptions {
  gameweekId: number;
  onEvent?: EventCallback;
  onConnectionState?: ConnectionStateCallback;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

/**
 * useEventTicker manages WebSocket connection to live match event stream.
 * Delivers events individually with automatic reconnection and error handling.
 */
export function useEventTicker({
  gameweekId,
  onEvent,
  onConnectionState,
  onError,
  autoReconnect = true,
  maxReconnectAttempts = 5,
  reconnectDelayMs = 2000,
}: EventTickerOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingEventsRef = useRef<Set<string>>(new Set()); // Deduplication by event ID
  const [isConnected, setIsConnected] = useState(false);

  const setConnectionState = useCallback(
    (state: "connecting" | "open" | "reconnecting" | "closed") => {
      onConnectionState?.(state);
    },
    [onConnectionState]
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    setConnectionState("connecting");
    setIsConnected(false);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
    const wsProtocol = apiUrl.startsWith("https") ? "wss" : "ws";
    const wsUrl = `${wsProtocol}://${apiUrl.replace(/^https?:\/\//, "")}/api/v1/live/${gameweekId}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        // Send auth frame
        const token = localStorage.getItem("authToken");
        ws.send(JSON.stringify({ type: "auth", token: token || "" }));
      };

      ws.onmessage = (e) => {
        try {
          const frame: EventTickerFrame = JSON.parse(e.data);

          if (frame.type === "ready") {
            reconnectAttemptsRef.current = 0;
            setConnectionState("open");
            setIsConnected(true);
          } else if (frame.type === "delta" && frame.events) {
            // Deliver events individually, deduplicating by ID
            for (const event of frame.events) {
              if (!pendingEventsRef.current.has(event.id)) {
                pendingEventsRef.current.add(event.id);
                // Keep dedup set bounded
                if (pendingEventsRef.current.size > 1000) {
                  const firstKey = pendingEventsRef.current.values().next().value;
                  pendingEventsRef.current.delete(firstKey);
                }
                onEvent?.(event);
              }
            }
          } else if (frame.type === "error") {
            const error = new Error(frame.message || "WebSocket error");
            onError?.(error);
          }
        } catch (err) {
          onError?.(new Error(`Failed to parse WebSocket message: ${(err as Error).message}`));
        }
      };

      ws.onerror = () => {
        const error = new Error("WebSocket connection error");
        onError?.(error);
        setIsConnected(false);
      };

      ws.onclose = () => {
        setConnectionState("closed");
        setIsConnected(false);

        if (autoReconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
          setConnectionState("reconnecting");
          reconnectAttemptsRef.current++;
          reconnectTimerRef.current = setTimeout(connect, reconnectDelayMs * Math.pow(2, reconnectAttemptsRef.current - 1));
        }
      };

      wsRef.current = ws;
    } catch (err) {
      const error = new Error(`WebSocket connection failed: ${(err as Error).message}`);
      onError?.(error);
      setIsConnected(false);

      if (autoReconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
        setConnectionState("reconnecting");
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(connect, reconnectDelayMs * Math.pow(2, reconnectAttemptsRef.current - 1));
      }
    }
  }, [gameweekId, onEvent, onConnectionState, onError, autoReconnect, maxReconnectAttempts, reconnectDelayMs, setConnectionState]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnectionState("closed");
    };
  }, [connect, setConnectionState]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionState("closed");
    setIsConnected(false);
  }, [setConnectionState]);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    disconnect();
    connect();
  }, [connect, disconnect]);

  return {
    isConnected,
    disconnect,
    reconnect,
  };
}
