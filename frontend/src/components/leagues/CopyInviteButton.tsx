"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconCheck, IconCopy } from "@/components/ui/Icons";
import { emitToast } from "@/context/ToastContext";

export const COPY_TOOLTIP_DURATION_MS = 2000;

/**
 * Copies text to the clipboard using `navigator.clipboard.writeText` with a
 * graceful fallback to `document.execCommand("copy")` for older browsers or
 * non-HTTPS contexts.
 */
export async function copyToClipboardWithFallback(text: string): Promise<boolean> {
  if (!text) return false;

  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }

  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const succeeded =
        typeof document.execCommand === "function" ? document.execCommand("copy") : false;
      document.body.removeChild(textarea);
      return Boolean(succeeded);
    } catch {
      return false;
    }
  }

  return false;
}

export interface CopyInviteButtonProps {
  /** The invitation URL or invite token to copy */
  valueToCopy: string;
  /** Accessible label for screen readers (default: "Copy invitation link") */
  ariaLabel?: string;
  /** Optional toast confirmation message */
  toastMessage?: string;
  /** Optional initial copied state (useful for deterministic SSR/static markup tests) */
  initialCopied?: boolean;
  /** Optional callback fired when copy completes */
  onCopied?: (copiedValue: string, success: boolean) => void;
  className?: string;
}

/**
 * Accessible one-click copy-to-clipboard button with animated 'Copied!' /
 * 'Copied to clipboard!' tooltip feedback and ARIA live region announcement.
 */
export const CopyInviteButton: React.FC<CopyInviteButtonProps> = ({
  valueToCopy,
  ariaLabel = "Copy invitation link",
  toastMessage = "Copied to clipboard!",
  initialCopied = false,
  onCopied,
  className = "",
}) => {
  const [copied, setCopied] = useState<boolean>(initialCopied);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const triggerCopy = useCallback(async () => {
    const ok = await copyToClipboardWithFallback(valueToCopy);
    if (ok) {
      setCopied(true);
      emitToast.success(toastMessage);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, COPY_TOOLTIP_DURATION_MS);
    }
    onCopied?.(valueToCopy, ok);
  }, [valueToCopy, toastMessage, onCopied]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void triggerCopy();
      }
    },
    [triggerCopy]
  );

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void triggerCopy()}
        onKeyDown={handleKeyDown}
        aria-label={ariaLabel}
        title={ariaLabel}
        className="text-xs gap-1.5"
      >
        {copied ? (
          <>
            <IconCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-emerald-300 font-semibold">Copied!</span>
          </>
        ) : (
          <IconCopy className="w-3.5 h-3.5" />
        )}
      </Button>

      {copied && (
        <span
          role="tooltip"
          className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-emerald-950/95 border border-emerald-500/40 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 shadow-lg transition-opacity duration-150"
        >
          Copied to clipboard!
        </span>
      )}

      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard!" : ""}
      </span>
    </div>
  );
};
