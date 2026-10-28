"use client";

import React, { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { IconCheck, IconCopy } from "@/components/ui/Icons";

export const COPIED_FEEDBACK_MS = 2000;

/**
 * One-click copy button with a transient "Copied!" tooltip. The confirmation
 * is also announced through a polite ARIA live region for screen readers.
 */
export const CopyButton: React.FC<{
  value: string;
  ariaLabel: string;
  className?: string;
}> = ({ value, ariaLabel, className = "" }) => {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    setCopied(ok);
    setFailed(!ok);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, COPIED_FEEDBACK_MS);
  };

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={ariaLabel}
        title={ariaLabel}
        data-testid="copy-button"
        className={`inline-flex items-center justify-center px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 transition-colors ${className}`}
      >
        {copied ? <IconCheck className="w-3.5 h-3.5 text-emerald-400" /> : <IconCopy className="w-3.5 h-3.5" />}
      </button>
      {(copied || failed) && (
        <span
          aria-hidden="true"
          className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-1 rounded-md bg-slate-950 border border-slate-700 text-[11px] font-semibold text-emerald-300 shadow-lg animate-fadeIn"
        >
          {copied ? "Copied!" : "Copy failed"}
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only" data-testid="copy-status">
        {copied ? "Copied to clipboard!" : failed ? "Copy failed" : ""}
      </span>
    </span>
  );
};
