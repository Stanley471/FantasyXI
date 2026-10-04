"use client";

import React, { useEffect, useLayoutEffect, useRef } from "react";
import { ChatConnectionState } from "@/types";
import { useLeagueChat } from "./useLeagueChat";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer } from "./ChatComposer";

export interface LeagueChatProps {
  leagueId: string;
  currentUser: { id: string; username: string };
}

const CONNECTION_LABELS: Record<ChatConnectionState, { text: string; dot: string }> = {
  connecting: { text: "Connecting…", dot: "bg-amber-400" },
  open: { text: "Live", dot: "bg-emerald-400" },
  reconnecting: { text: "Reconnecting…", dot: "bg-amber-400" },
  unavailable: { text: "Offline", dot: "bg-slate-500" },
};

/** Distance from the bottom (px) within which new messages keep the view pinned to the latest */
const STICKY_SCROLL_PX = 80;

/**
 * League chat panel embedded in the league dashboard: persisted history,
 * real-time delivery, and a composer for league members.
 */
export const LeagueChat: React.FC<LeagueChatProps> = ({ leagueId, currentUser }) => {
  const chat = useLeagueChat(leagueId, currentUser);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const previousScrollHeight = useRef(0);
  const status = CONNECTION_LABELS[chat.connection];

  const lastMessage = chat.messages[chat.messages.length - 1];
  const lastKey = lastMessage ? `${lastMessage.id}:${lastMessage.status ?? ""}` : "";
  const firstKey = chat.messages[0]?.id ?? "";

  // Follow new messages while the reader is at the bottom; never yank them away from older messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el && (pinnedToBottom.current || lastMessage?.userId === currentUser.id)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastKey, lastMessage?.userId, currentUser.id]);

  // Keep the reader's place when older messages are prepended
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!pinnedToBottom.current && previousScrollHeight.current) {
      el.scrollTop += el.scrollHeight - previousScrollHeight.current;
    }
    previousScrollHeight.current = el.scrollHeight;
  }, [firstKey]);

  return (
    <section
      aria-labelledby="league-chat-heading"
      className="rounded-xl border border-pitch-border bg-pitch-surface p-5 shadow-md"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 id="league-chat-heading" className="text-lg font-bold uppercase tracking-tight text-white">
            League chat
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">Banter with the other managers. Visible to league members only.</p>
        </div>
        <p role="status" className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-slate-300">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${status.dot}`} />
          {status.text}
        </p>
      </div>

      {chat.historyError && (
        <p role="alert" className="mb-3 rounded-lg border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          {chat.historyError}
        </p>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_SCROLL_PX;
        }}
        tabIndex={0}
        aria-label="Chat history"
        className="mb-4 h-80 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 p-3 focus-visible:outline-2 focus-visible:outline-emerald-400 sm:h-96"
      >
        {chat.hasMore && (
          <div className="mb-3 text-center">
            <button
              type="button"
              onClick={chat.loadOlder}
              disabled={chat.isLoadingOlder}
              className="min-h-9 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:opacity-50"
            >
              {chat.isLoadingOlder ? "Loading…" : "Load earlier messages"}
            </button>
          </div>
        )}
        {chat.messages.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-400">No messages yet. Get the banter started!</p>
        ) : (
          <ChatMessageList messages={chat.messages} currentUserId={currentUser.id} onRetry={chat.retry} />
        )}
      </div>

      {chat.unavailableReason && <p className="mb-2 text-xs text-amber-200">{chat.unavailableReason}</p>}

      <ChatComposer
        onSend={chat.send}
        disabled={chat.connection === "unavailable"}
        disabledReason={chat.unavailableReason ?? undefined}
      />
    </section>
  );
};
