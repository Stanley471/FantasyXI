"use client";

import React from "react";
import {
  getPlayerAvailabilityBadge,
  PlayerAvailabilityInput,
  AvailabilityBadgeColor,
} from "@/lib/playerStatus";
import { IconAlertTriangle } from "@/components/ui/Icons";

const COLOR_CLASSES: Record<AvailabilityBadgeColor, string> = {
  red: "bg-rose-600 text-white ring-rose-950",
  orange: "bg-orange-500 text-slate-950 ring-orange-950",
  yellow: "bg-yellow-400 text-slate-950 ring-yellow-950",
};

export interface PlayerStatusBadgeProps {
  player: PlayerAvailabilityInput;
  className?: string;
}

/**
 * Small fitness-doubt indicator for a player card: a color-coded dot with a
 * tooltip containing the official FPL injury news (issue #494).
 */
export const PlayerStatusBadge: React.FC<PlayerStatusBadgeProps> = ({ player, className = "" }) => {
  const badge = getPlayerAvailabilityBadge(player);
  if (!badge) return null;

  return (
    <div
      data-testid="player-status-badge"
      data-color={badge.color}
      title={badge.tooltip}
      className={`absolute -bottom-1.5 -right-1.5 z-20 flex items-center justify-center h-4 w-4 rounded-full ring-2 ring-slate-900 shadow font-mono text-[8px] font-black ${COLOR_CLASSES[badge.color]} ${className}`}
    >
      <IconAlertTriangle className="w-2.5 h-2.5" />
      <span className="sr-only">{badge.label}</span>
    </div>
  );
};
