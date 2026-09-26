"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { ToastItem, ToastType } from "@/types";
import {
  IconCheck,
  IconAlertCircle,
  IconInfo,
  IconAlertTriangle,
  IconClose,
} from "@/components/ui/Icons";

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const TOAST_ICONS: Record<ToastType, React.ReactNode> = {
  success: <IconCheck className="w-4 h-4 text-emerald-400" />,
  error: <IconAlertCircle className="w-4 h-4 text-rose-400" />,
  info: <IconInfo className="w-4 h-4 text-sky-400" />,
  warning: <IconAlertTriangle className="w-4 h-4 text-amber-400" />,
};

const TOAST_THEMES: Record<
  ToastType,
  {
    border: string;
    bg: string;
    iconBg: string;
    progressBar: string;
    titleColor: string;
  }
> = {
  success: {
    border: "border-emerald-500/40 shadow-emerald-950/20",
    bg: "bg-slate-900/95",
    iconBg: "bg-emerald-500/10 text-emerald-400",
    progressBar: "bg-emerald-500",
    titleColor: "text-emerald-400",
  },
  error: {
    border: "border-rose-500/40 shadow-rose-950/20",
    bg: "bg-slate-900/95",
    iconBg: "bg-rose-500/10 text-rose-400",
    progressBar: "bg-rose-500",
    titleColor: "text-rose-400",
  },
  info: {
    border: "border-sky-500/40 shadow-sky-950/20",
    bg: "bg-slate-900/95",
    iconBg: "bg-sky-500/10 text-sky-400",
    progressBar: "bg-sky-500",
    titleColor: "text-sky-400",
  },
  warning: {
    border: "border-amber-500/40 shadow-amber-950/20",
    bg: "bg-slate-900/95",
    iconBg: "bg-amber-500/10 text-amber-400",
    progressBar: "bg-amber-500",
    titleColor: "text-amber-400",
  },
};

const ToastCard: React.FC<{
  toast: ToastItem;
  onDismiss: (id: string) => void;
}> = ({ toast, onDismiss }) => {
  const [isPaused, setIsPaused] = useState(false);
  const remainingTimeRef = useRef(toast.duration);
  const startTimeRef = useRef<number>(0);
  const timerIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startTimer = useCallback(() => {
    if (remainingTimeRef.current <= 0 || toast.duration <= 0) return;
    startTimeRef.current = Date.now();
    timerIdRef.current = setTimeout(() => {
      onDismiss(toast.id);
    }, remainingTimeRef.current);
  }, [onDismiss, toast.id, toast.duration]);

  const pauseTimer = useCallback(() => {
    if (timerIdRef.current) {
      clearTimeout(timerIdRef.current);
      timerIdRef.current = null;
      const elapsed = Date.now() - startTimeRef.current;
      remainingTimeRef.current = Math.max(0, remainingTimeRef.current - elapsed);
    }
  }, []);

  useEffect(() => {
    startTimer();
    return () => {
      if (timerIdRef.current) clearTimeout(timerIdRef.current);
    };
  }, [startTimer]);

  const handleMouseEnter = () => {
    setIsPaused(true);
    pauseTimer();
  };

  const handleMouseLeave = () => {
    setIsPaused(false);
    startTimer();
  };

  const theme = TOAST_THEMES[toast.type] || TOAST_THEMES.info;
  const isAlert = toast.type === "error";

  return (
    <div
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      aria-atomic="true"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`pointer-events-auto relative overflow-hidden flex flex-col w-full rounded-xl border backdrop-blur-md shadow-xl transition-all duration-200 animate-toast-in ${theme.bg} ${theme.border}`}
    >
      <div className="flex items-start gap-3 p-3.5 sm:p-4">
        {/* Status Icon */}
        <div
          className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${theme.iconBg}`}
        >
          {TOAST_ICONS[toast.type]}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pr-1">
          {toast.title && (
            <p className={`text-xs font-bold uppercase tracking-wider mb-0.5 ${theme.titleColor}`}>
              {toast.title}
            </p>
          )}
          <p className="text-xs text-slate-200 leading-relaxed break-words font-medium">
            {toast.message}
          </p>

          {/* Action button if provided */}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
              className="mt-2 inline-flex items-center px-2.5 py-1 text-[11px] font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-md transition-colors border border-slate-700"
            >
              {toast.action.label}
            </button>
          )}
        </div>

        {/* Dismiss Button */}
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          className="flex-shrink-0 -mr-1 -mt-1 p-1 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800/60 transition-colors focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <IconClose className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Progress Bar (if auto-dismissing) */}
      {toast.duration > 0 && (
        <div className="h-0.5 w-full bg-slate-800/80 overflow-hidden">
          <div
            className={`h-full w-full origin-left ${theme.progressBar}`}
            style={{
              animation: `toast-progress ${toast.duration}ms linear forwards`,
              animationPlayState: isPaused ? "paused" : "running",
            }}
          />
        </div>
      )}
    </div>
  );
};

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <aside
      aria-label="Notifications"
      className="fixed top-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none px-4 sm:px-0"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </aside>
  );
};
