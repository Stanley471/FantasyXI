"use client";

import React, { useId, useState } from "react";
import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/chat";

export interface ChatComposerProps {
  onSend: (body: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}

/** Shows the remaining-character count once a message gets this close to the limit */
const COUNTER_THRESHOLD = 50;

/**
 * Message input: Enter sends, Shift+Enter adds a new line. The remaining
 * character count appears (and is announced) only near the limit.
 */
export const ChatComposer: React.FC<ChatComposerProps> = ({ onSend, disabled = false, disabledReason }) => {
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const hintId = useId();
  const remaining = MAX_CHAT_MESSAGE_LENGTH - [...draft].length;
  const canSend = !disabled && draft.trim().length > 0 && remaining >= 0;

  const submit = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-start gap-2"
    >
      <div className="flex-1">
        <label htmlFor={inputId} className="sr-only">
          Message the league
        </label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          maxLength={MAX_CHAT_MESSAGE_LENGTH}
          disabled={disabled}
          aria-describedby={hintId}
          placeholder={disabled ? disabledReason ?? "Chat unavailable" : "Talk some trash…"}
          className="block max-h-32 min-h-11 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <p id={hintId} className="mt-1 flex justify-between gap-2 px-1 text-[11px] text-slate-400">
          <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
          {remaining <= COUNTER_THRESHOLD && (
            <span aria-live="polite" className={`ml-auto ${remaining < 0 ? "text-rose-300" : ""}`}>
              {remaining} characters left
            </span>
          )}
        </p>
      </div>
      <button
        type="submit"
        disabled={!canSend}
        className="min-h-11 rounded-xl bg-emerald-700 px-4 text-sm font-bold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
};
