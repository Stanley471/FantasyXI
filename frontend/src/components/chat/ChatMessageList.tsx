import React from "react";
import { ChatEntry } from "@/types";
import { DEFAULT_CHAT_REACTIONS, formatMessageTime } from "@/lib/chat";

export interface ChatMessageListProps {
  messages: ChatEntry[];
  currentUserId: string;
  onRetry?: (clientId: string) => void;
  onRollback?: (clientId: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  now?: Date;
}

/**
 * Chat transcript. Rendered as an ARIA log so screen readers announce new
 * messages politely; message bodies are plain text (never HTML).
 */
export const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages,
  currentUserId,
  onRetry,
  onRollback,
  onReact,
  now,
}) => (
  <ol role="log" aria-live="polite" aria-relevant="additions" aria-label="Chat messages" className="space-y-3">
    {messages.map((message, index) => {
      const isOwn = message.userId === currentUserId;
      const previous = messages[index - 1];
      // Consecutive messages from the same person share one name label
      const showAuthor = !previous || previous.userId !== message.userId;
      const activeReactions = message.reactions ? Object.values(message.reactions).filter((r) => r.count > 0) : [];

      return (
        <li
          key={message.status ? `draft-${message.clientId}` : message.id}
          className={`flex flex-col ${isOwn ? "items-end" : "items-start"} ${showAuthor ? "" : "-mt-2"}`}
        >
          {showAuthor && (
            <span className="mb-1 px-1 text-xs font-semibold text-slate-400">{isOwn ? "You" : `@${message.username}`}</span>
          )}
          <div
            className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
              isOwn ? "rounded-br-md bg-emerald-800 text-white" : "rounded-bl-md bg-slate-800 text-slate-100"
            } ${message.status === "failed" ? "ring-1 ring-rose-400" : ""} ${message.status === "sending" ? "opacity-70" : ""}`}
          >
            {!showAuthor && <span className="sr-only">{isOwn ? "You: " : `@${message.username}: `}</span>}
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</p>
          </div>
          {!message.status && (activeReactions.length > 0 || onReact) && (
            <div className="mt-1 flex flex-wrap items-center gap-1 px-1" aria-label="Message reactions">
              {(onReact
                ? Array.from(new Set([...DEFAULT_CHAT_REACTIONS, ...activeReactions.map((r) => r.emoji)]))
                : activeReactions.map((r) => r.emoji)
              ).map((emoji) => {
                const reaction = message.reactions?.[emoji];
                const count = reaction?.count ?? 0;
                const reacted = reaction?.userIds.includes(currentUserId) ?? false;
                return (
                  <button
                    key={emoji}
                    type="button"
                    aria-pressed={reacted}
                    aria-label={`React with ${emoji}${count > 0 ? ` (${count})` : ""}`}
                    onClick={() => onReact?.(message.id, emoji)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                      reacted
                        ? "border-emerald-500/60 bg-emerald-950/60 text-emerald-200"
                        : "border-slate-700/80 bg-slate-900/60 text-slate-300 hover:border-slate-600"
                    } ${reaction?.pending ? "opacity-80" : ""}`}
                  >
                    <span>{emoji}</span>
                    {count > 0 && <span className="font-semibold">{count}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-2 px-1 text-[11px] text-slate-400">
            {message.status === "sending" ? (
              <span>Sending…</span>
            ) : message.status === "failed" ? (
              <>
                <span className="text-rose-300">Not sent{message.error ? `: ${message.error}` : ""}</span>
                {onRetry && message.clientId && (
                  <button
                    type="button"
                    onClick={() => onRetry(message.clientId!)}
                    className="rounded font-semibold text-emerald-300 underline underline-offset-2 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-emerald-400"
                  >
                    Retry
                  </button>
                )}
                {onRollback && message.clientId && (
                  <button
                    type="button"
                    onClick={() => onRollback(message.clientId!)}
                    className="rounded font-semibold text-slate-300 underline underline-offset-2 hover:text-white focus-visible:outline-2 focus-visible:outline-slate-400"
                  >
                    Dismiss
                  </button>
                )}
              </>
            ) : (
              <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt, now)}</time>
            )}
          </div>
        </li>
      );
    })}
  </ol>
);
