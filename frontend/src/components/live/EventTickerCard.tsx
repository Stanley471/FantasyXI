"use client";

import React, { useEffect, useState } from "react";
import { IconFootball, IconShield, IconStar, IconAlertCircle } from "@/components/ui/Icons";
import type { TimelineEvent } from "@/types";

interface EventTickerCardProps {
  event: TimelineEvent;
  isInUserTeam?: boolean;
  isCaptain?: boolean;
  isViceCaptain?: boolean;
  onRemove?: (eventId: string) => void;
  autoRemoveAfterMs?: number;
  /** Apply additional CSS classes for custom styling */
  className?: string;
}

/**
 * Animated event card for the live ticker.
 * Slides in from the top with a 3D perspective effect.
 * Auto-removes after duration unless dismissed by user.
 */
export function EventTickerCard({
  event,
  isInUserTeam = false,
  isCaptain = false,
  isViceCaptain = false,
  onRemove,
  autoRemoveAfterMs = 8000,
  className = "",
}: EventTickerCardProps) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      const hideTimer = setTimeout(() => {
        onRemove?.(event.id);
      }, 300); // Allow animation to complete before removing DOM
      return () => clearTimeout(hideTimer);
    }, autoRemoveAfterMs);

    return () => clearTimeout(timer);
  }, [event.id, autoRemoveAfterMs, onRemove]);

  const getEventIcon = () => {
    switch (event.type) {
      case "GOAL":
        return <IconFootball className="w-5 h-5 text-emerald-400" title="Goal" />;
      case "ASSIST":
        return (
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800 text-xs font-black">
            A
          </span>
        );
      case "YELLOW_CARD":
        return (
          <span
            className="inline-block w-3.5 h-5 rounded-xs bg-amber-400 border border-amber-500 shadow-md"
            title="Yellow Card"
          />
        );
      case "RED_CARD":
        return (
          <span className="inline-block w-3.5 h-5 rounded-xs bg-red-600 border border-red-700 shadow-md" title="Red Card" />
        );
      case "SAVE":
        return <IconShield className="w-5 h-5 text-indigo-400" title="Save" />;
      case "BONUS":
        return <IconStar className="w-5 h-5 text-amber-300" title="Bonus Points" />;
      case "PENALTY_SAVED":
        return <IconShield className="w-5 h-5 text-purple-400" title="Penalty Saved" />;
      case "OWN_GOAL":
        return <span className="text-sm font-bold text-rose-400">OG</span>;
      default:
        return <span className="text-xs text-gray-400">•</span>;
    }
  };

  const getEventLabel = () => {
    const baseLabel = event.type.replace(/_/g, " ");
    if (event.type === "GOAL" && event.detail?.includes("penalty")) return "Penalty Goal";
    if (event.type === "ASSIST") return "Assist";
    if (event.type === "YELLOW_CARD") return "Yellow Card";
    if (event.type === "RED_CARD") return "Red Card";
    if (event.type === "SAVE") return "Save";
    if (event.type === "BONUS") return `${event.detail ? event.detail : "Bonus"}`;
    return baseLabel;
  };

  const getPointsBadgeClass = () => {
    if (event.pointsAwarded > 0) return "bg-emerald-900/70 text-emerald-300 border-emerald-600";
    if (event.pointsAwarded < 0) return "bg-rose-900/70 text-rose-300 border-rose-600";
    return "bg-gray-800 text-gray-300 border-gray-700";
  };

  const getBackgroundClass = () => {
    if (isInUserTeam) {
      return "bg-gradient-to-r from-emerald-950/80 to-emerald-900/50 border-emerald-600/60";
    }
    return "bg-gradient-to-r from-gray-950/90 to-gray-900/50 border-gray-700/60";
  };

  return (
    <div
      className={`
        transform transition-all duration-300 ease-out
        ${isVisible ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0"}
        perspective
        ${className}
      `}
      style={{
        perspective: "1000px",
        transformStyle: "preserve-3d",
      }}
      role="status"
      aria-live="polite"
      aria-label={`${getEventLabel()} by ${event.playerName} at ${event.minute}'`}
    >
      <div
        className={`
          relative flex items-start gap-3 p-4 rounded-lg border shadow-xl backdrop-blur-sm
          ${getBackgroundClass()}
          before:absolute before:inset-0 before:rounded-lg before:bg-gradient-to-r
          before:from-white/5 before:to-transparent before:pointer-events-none
        `}
      >
        {/* Event Icon */}
        <div className="shrink-0 p-2.5 rounded-md bg-gray-900/60 border border-gray-800/80 flex items-center justify-center">
          {getEventIcon()}
        </div>

        {/* Main Content */}
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-sm font-bold text-white truncate">{event.playerName}</span>
            <span className="text-xs text-gray-400 font-medium">
              ({event.teamShortName})
            </span>
            {isInUserTeam && (
              <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wide">
                Your squad
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-emerald-400 bg-emerald-950/50 px-2 py-0.5 rounded">
              {getEventLabel()}
            </span>
            <span className="text-xs text-gray-300 font-mono">{event.minute}&apos;</span>
            {event.detail && <span className="text-xs text-gray-400 truncate">{event.detail}</span>}
          </div>

          {/* Badge and captain status */}
          {(isCaptain || isViceCaptain) && (
            <div className="mt-2 flex items-center gap-1">
              {isCaptain && (
                <span className="bg-amber-400 text-gray-900 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">
                  C
                </span>
              )}
              {isViceCaptain && (
                <span className="bg-gray-300 text-gray-900 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">
                  V
                </span>
              )}
            </div>
          )}
        </div>

        {/* Points Badge */}
        <div className="shrink-0">
          <div className={`text-sm font-bold px-2.5 py-1 rounded border ${getPointsBadgeClass()}`}>
            {event.pointsAwarded > 0 ? `+${event.pointsAwarded}` : event.pointsAwarded} pts
          </div>
        </div>

        {/* Close Button */}
        <button
          onClick={() => {
            setIsVisible(false);
            setTimeout(() => onRemove?.(event.id), 300);
          }}
          className="shrink-0 p-1 text-gray-500 hover:text-white transition-colors"
          aria-label="Dismiss event"
          title="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default EventTickerCard;
