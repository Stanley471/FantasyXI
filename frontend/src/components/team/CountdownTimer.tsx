"use client";

import React, { useEffect, useState } from "react";
import { countdownTone, formatCountdown, remainingUntil, type CountdownTone } from "@/lib/countdown";

const TONE_CLASSES: Record<Exclude<CountdownTone, "expired">, string> = {
  normal: "text-emerald-400 border-emerald-500/40 bg-emerald-950/30",
  amber: "text-amber-400 border-amber-500/50 bg-amber-950/40",
  red: "text-red-400 border-red-500/50 bg-red-950/40",
};

/** Stateless view of the deadline countdown for a given remaining duration. */
export const CountdownDisplay: React.FC<{ remainingMs: number }> = ({ remainingMs }) => {
  const tone = countdownTone(remainingMs);
  if (tone === "expired") {
    return (
      <span
        data-testid="deadline-locked"
        className="px-2.5 py-1 rounded-md border border-red-500/50 bg-red-950/40 text-red-400 text-[11px] font-bold uppercase tracking-wider"
      >
        Deadline Passed - Squad Locked
      </span>
    );
  }
  return (
    <span
      data-testid="deadline-countdown"
      data-tone={tone}
      className={`px-2.5 py-1 rounded-md border font-mono font-bold text-xs ${TONE_CLASSES[tone]}`}
    >
      <span className="text-slate-400 uppercase tracking-wider text-[10px] mr-1.5">Deadline</span>
      {formatCountdown(remainingMs)}
    </span>
  );
};

/**
 * Ticks every second until `deadline`, reporting expiry so the caller can
 * lock squad editing.
 */
export const CountdownTimer: React.FC<{
  deadline: string;
  onExpiredChange?: (expired: boolean) => void;
}> = ({ deadline, onExpiredChange }) => {
  const [remainingMs, setRemainingMs] = useState(() => remainingUntil(deadline));

  useEffect(() => {
    const tick = () => setRemainingMs(remainingUntil(deadline));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  const expired = remainingMs <= 0;
  useEffect(() => {
    onExpiredChange?.(expired);
  }, [expired, onExpiredChange]);

  return <CountdownDisplay remainingMs={remainingMs} />;
};
