"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_BASE_URL, ApiError } from "@/lib/api";
import {
  chatSocketUrl,
  createClientId,
  dropDeliveredDrafts,
  mergeMessages,
  reconnectDelay,
  TERMINAL_CLOSE_CODES,
} from "@/lib/chat";
import { ChatConnectionState, ChatEntry, ChatMessage } from "@/types";

interface HistoryResponse {
  success: boolean;
  data: ChatMessage[];
  meta: { hasMore: boolean };
}

type ServerFrame =
  | { type: "ready"; leagueId: string; userId: string }
  | { type: "message"; message: ChatMessage }
  | { type: "ack"; clientId?: string; message: ChatMessage }
  | { type: "error"; code: string; message: string; clientId?: string; retryAfterMs?: number };

const UNAVAILABLE_REASONS: Record<number, string> = {
  4401: "Your session has expired. Sign in again to chat.",
  4403: "Only members of this league can use the chat.",
  4404: "This league no longer exists.",
};

const CONNECTION_LOST = "Connection lost before the message was confirmed.";

export interface UseLeagueChatResult {
  messages: ChatEntry[];
  connection: ChatConnectionState;
  unavailableReason: string | null;
  historyError: string | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  send: (body: string) => void;
  retry: (clientId: string) => void;
  loadOlder: () => void;
}

/**
 * Real-time league chat: loads persisted history over HTTP, then streams new
 * messages over a WebSocket. Sends are optimistic and reconciled with the
 * server's acknowledgement; while the socket is not ready, messages are posted
 * over HTTP instead. Dropped connections reconnect with backoff and re-sync
 * history so nothing sent in the meantime is missed.
 */
export function useLeagueChat(leagueId: string, currentUser: { id: string; username: string }): UseLeagueChatResult {
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [connection, setConnection] = useState<ChatConnectionState>("connecting");
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  /** True once the server has authenticated this socket ("ready" frame) */
  const readyRef = useRef(false);
  const messagesRef = useRef<ChatEntry[]>([]);
  const userRef = useRef(currentUser);
  const loadedFirstPage = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    userRef.current = currentUser;
  }, [currentUser]);

  const merge = useCallback((incoming: ChatEntry[]) => {
    setMessages((current) => mergeMessages(current, incoming));
  }, []);

  const markFailed = useCallback((predicate: (m: ChatEntry) => boolean, error: string, lostInFlight = false) => {
    setMessages((current) =>
      current.map((m) =>
        m.status === "sending" && predicate(m) ? { ...m, status: "failed" as const, error, lostInFlight } : m
      )
    );
  }, []);

  const fetchLatest = useCallback(async () => {
    try {
      const res = await api.get<HistoryResponse>(`/api/v1/leagues/${encodeURIComponent(leagueId)}/chat/messages`);
      setMessages((current) => dropDeliveredDrafts(mergeMessages(current, res.data), userRef.current.id));
      // Re-syncs after a reconnect only fill gaps; the first page decides whether older history exists
      if (!loadedFirstPage.current) {
        loadedFirstPage.current = true;
        setHasMore(res.meta.hasMore);
      }
      setHistoryError(null);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : "Chat history could not be loaded.");
    }
  }, [leagueId]);

  // Connection lifecycle
  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const token = localStorage.getItem("token");
      if (!token) {
        setConnection("unavailable");
        setUnavailableReason(UNAVAILABLE_REASONS[4401]);
        return;
      }

      const socket = new WebSocket(chatSocketUrl(API_BASE_URL, leagueId));
      socketRef.current = socket;

      socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));

      socket.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data as string);
        } catch {
          return;
        }
        switch (frame.type) {
          case "ready":
            readyRef.current = true;
            if (attempt > 0) void fetchLatest(); // catch up on anything missed while disconnected
            attempt = 0;
            setConnection("open");
            break;
          case "message":
            merge([frame.message]);
            break;
          case "ack":
            merge([{ ...frame.message, clientId: frame.clientId }]);
            break;
          case "error":
            if (frame.clientId) markFailed((m) => m.clientId === frame.clientId, frame.message);
            break;
        }
      };

      socket.onclose = (event) => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        readyRef.current = false;
        if (disposed) return;
        // Anything still awaiting an ack on this socket is unconfirmed
        markFailed((m) => m.via === "socket", CONNECTION_LOST, true);
        if (TERMINAL_CLOSE_CODES.has(event.code)) {
          setConnection("unavailable");
          setUnavailableReason(UNAVAILABLE_REASONS[event.code]);
          return;
        }
        setConnection("reconnecting");
        reconnectTimer = setTimeout(connect, reconnectDelay(attempt++));
      };
    };

    void fetchLatest();
    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      readyRef.current = false;
      socket?.close(1000, "Leaving chat");
    };
  }, [leagueId, fetchLatest, merge, markFailed]);

  const deliver = useCallback(
    (entry: ChatEntry) => {
      const socket = socketRef.current;
      if (socket && readyRef.current && socket.readyState === WebSocket.OPEN) {
        merge([{ ...entry, via: "socket" }]);
        socket.send(JSON.stringify({ type: "message", body: entry.body, clientId: entry.clientId }));
        return;
      }
      // Socket not ready: fall back to HTTP (the server still broadcasts to everyone else)
      merge([{ ...entry, via: "http" }]);
      api
        .post<{ success: boolean; data: ChatMessage }>(`/api/v1/leagues/${encodeURIComponent(leagueId)}/chat/messages`, {
          body: entry.body,
        })
        .then((res) => merge([{ ...res.data, clientId: entry.clientId }]))
        .catch((err) =>
          markFailed(
            (m) => m.clientId === entry.clientId,
            err instanceof ApiError ? err.message : "Message could not be sent."
          )
        );
    },
    [leagueId, merge, markFailed]
  );

  const send = useCallback(
    (body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const clientId = createClientId();
      deliver({
        id: clientId,
        clientId,
        leagueId,
        userId: userRef.current.id,
        username: userRef.current.username,
        body: trimmed,
        createdAt: new Date().toISOString(),
        status: "sending",
      });
    },
    [leagueId, deliver]
  );

  const retry = useCallback(
    (clientId: string) => {
      const entry = messagesRef.current.find((m) => m.clientId === clientId && m.status === "failed");
      if (entry) deliver({ ...entry, status: "sending", error: undefined, lostInFlight: false });
    },
    [deliver]
  );

  const loadOlder = useCallback(() => {
    const oldest = messagesRef.current.find((m) => !m.status);
    if (!oldest || isLoadingOlder) return;
    setIsLoadingOlder(true);
    api
      .get<HistoryResponse>(
        `/api/v1/leagues/${encodeURIComponent(leagueId)}/chat/messages?before=${encodeURIComponent(oldest.id)}`
      )
      .then((res) => {
        merge(res.data);
        setHasMore(res.meta.hasMore);
      })
      .catch((err) => setHistoryError(err instanceof ApiError ? err.message : "Older messages could not be loaded."))
      .finally(() => setIsLoadingOlder(false));
  }, [leagueId, merge, isLoadingOlder]);

  return { messages, connection, unavailableReason, historyError, hasMore, isLoadingOlder, send, retry, loadOlder };
}
