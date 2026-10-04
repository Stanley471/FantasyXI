import React from "react";
import { ChatEntry } from "@/types";
import { formatMessageTime } from "@/lib/chat";

export interface ChatMessageListProps {
  messages: ChatEntry[];
  currentUserId: string;
  onRetry?: (clientId: string) => void;
  now?: Date;
}

/**
 * Chat transcript. Rendered as an ARIA log so screen readers announce new
 * messages politely; message bodies are plain text (never HTML).
 */
export const ChatMessageList: React.FC<ChatMessageListProps> = ({ messages, currentUserId, onRetry, now }) => (
  <ol role="log" aria-live="polite" aria-relevant="additions" aria-label="Chat messages" className="space-y-3">
    {messages.map((message, index) => {
      const isOwn = message.userId === currentUserId;
      const previous = messages[index - 1];
      // Consecutive messages from the same person share one name label
      const showAuthor = !previous || previous.userId !== message.userId;

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
