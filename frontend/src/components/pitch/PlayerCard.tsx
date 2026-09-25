"use client";

import React from "react";
import { Player, Position } from "@/types";
import { PositionBadge } from "@/components/ui/Badge";
import { IconFootball, IconSwap } from "@/components/ui/Icons";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { validateSubstitution } from "@/lib/formation";
import { useTeamStore } from "@/store/teamStore";

export interface PlayerCardProps {
  player?: Player | null;
  positionSlot: Position;
  isStarter: boolean;
  isCaptain?: boolean;
  isViceCaptain?: boolean;
  benchIndex?: number; // 0 for sub keeper, 1, 2, 3 for outfield
  isSwapCandidate?: boolean;
  isOverlay?: boolean;
  onQuickAction?: (action: "captain" | "vice" | "swap" | "transfer") => void;
}

export const PlayerCard: React.FC<PlayerCardProps> = ({
  player,
  positionSlot,
  isStarter,
  isCaptain = false,
  isViceCaptain = false,
  benchIndex,
  isSwapCandidate = false,
  isOverlay = false,
}) => {
  const isSelectedForSwap = useTeamStore(
    (state) => state.selectedPlayerId !== null && player?.id === state.selectedPlayerId
  );
  const handlePlayerClick = useTeamStore((state) => state.handlePlayerClick);
  const activeDragPlayer = useTeamStore((state) => state.activeDragPlayer);
  const allSquadPlayers = useTeamStore((state) => state.players);

  const onClick = () => handlePlayerClick(player || null, positionSlot);

  // Drag and Drop integration
  const dropId = player?.id?.toString() || `empty-${positionSlot}-${benchIndex ?? "starter"}`;
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({
    id: player?.id?.toString() || "no-drag",
    disabled: !player || isOverlay,
  });

  const { isOver, setNodeRef: setDroppableRef } = useDroppable({
    id: dropId,
    disabled: isOverlay,
  });

  // Combine refs (since the card acts as both draggable item and droppable slot target)
  const setNodeRef = (node: HTMLElement | null) => {
    setDraggableRef(node);
    setDroppableRef(node);
  };

  // Drag state evaluation: is this card an eligible or ineligible target?
  const isDragInProgress = !!activeDragPlayer && !isOverlay;
  const isSelfBeingDragged =
    activeDragPlayer && player && String(activeDragPlayer.playerId) === String(player.id);

  let isSubstitutionEligible = false;
  let invalidReason: string | undefined = undefined;

  if (isDragInProgress && player && !isSelfBeingDragged) {
    const targetSquadPlayer = allSquadPlayers.find(
      (p) => String(p.playerId) === String(player.id)
    );
    if (targetSquadPlayer) {
      const validation = validateSubstitution(
        activeDragPlayer,
        targetSquadPlayer,
        allSquadPlayers
      );
      isSubstitutionEligible = validation.valid;
      invalidReason = validation.reason;
    }
  }

  // Empty slot (when building or drafting)
  if (!player) {
    return (
      <div ref={setNodeRef} className="relative flex flex-col items-center">
        <button
          type="button"
          onClick={onClick}
          className={`group relative flex flex-col items-center justify-center p-2 rounded-xl transition-all duration-200 w-20 sm:w-24 ${
            isSwapCandidate || isOver
              ? "bg-emerald-500/20 border-2 border-dashed border-emerald-400 animate-pulse"
              : "bg-slate-950/40 border border-dashed border-slate-700 hover:border-emerald-400 hover:bg-slate-900/60"
          }`}
        >
          <div className="w-10 h-10 rounded-lg bg-slate-800/80 group-hover:bg-emerald-500/20 text-slate-400 group-hover:text-emerald-400 flex items-center justify-center mb-1.5 transition-colors">
            <span className="text-lg font-bold">+</span>
          </div>
          <PositionBadge position={positionSlot} size="sm" />
          <span className="text-[10px] text-slate-500 mt-1 uppercase font-semibold">
            {benchIndex !== undefined
              ? benchIndex === 0
                ? "Sub GK"
                : `Sub ${benchIndex}`
              : "Add"}
          </span>
        </button>
      </div>
    );
  }

  // Position-specific jersey color gradients for rich authentic feel
  const getJerseyStyle = (pos: Position) => {
    switch (pos) {
      case Position.GKP:
        return "from-amber-600 to-amber-700 border-amber-400 text-amber-100";
      case Position.DEF:
        return "from-sky-700 to-sky-900 border-sky-400 text-sky-100";
      case Position.MID:
        return "from-emerald-700 to-emerald-900 border-emerald-400 text-emerald-100";
      case Position.FWD:
        return "from-rose-700 to-rose-900 border-rose-400 text-rose-100";
      default:
        return "from-slate-700 to-slate-800 border-slate-400 text-slate-100";
    }
  };

  const jerseyStyle = getJerseyStyle(player.position);

  // Dynamic styling based on Drag & Drop and substitution validation
  let interactiveStyles = "hover:scale-105 cursor-grab active:cursor-grabbing";

  if (isOverlay) {
    interactiveStyles = "cursor-grabbing shadow-2xl";
  } else if (isDragging || isSelfBeingDragged) {
    interactiveStyles = "opacity-25 scale-95 cursor-grabbing";
  } else if (isDragInProgress) {
    if (isSubstitutionEligible) {
      if (isOver) {
        interactiveStyles =
          "scale-110 ring-4 ring-emerald-400 bg-emerald-950/90 shadow-[0_0_25px_rgba(52,211,153,0.8)] cursor-pointer";
      } else {
        interactiveStyles =
          "scale-105 ring-2 ring-emerald-400/80 bg-emerald-950/30 animate-pulse cursor-pointer";
      }
    } else {
      if (isOver) {
        interactiveStyles =
          "scale-95 ring-4 ring-rose-500 bg-rose-950/90 shadow-[0_0_20px_rgba(244,63,94,0.8)] cursor-not-allowed";
      } else {
        interactiveStyles =
          "opacity-35 grayscale-[50%] cursor-not-allowed border-rose-900/40";
      }
    }
  } else if (isSelectedForSwap) {
    interactiveStyles = "scale-105 ring-4 ring-emerald-400 rounded-xl bg-emerald-950/60 p-1";
  } else if (isSwapCandidate) {
    interactiveStyles = "scale-105 ring-2 ring-amber-400 rounded-xl bg-amber-950/40 p-1 animate-pulse";
  }

  return (
    <div
      ref={setNodeRef}
      className={`relative flex flex-col items-center transition-all duration-150 ${
        isDragging && !isOverlay ? "opacity-30" : ""
      }`}
    >
      {/* Floating Status Tooltip during Drag */}
      {isDragInProgress && !isSelfBeingDragged && isOver && (
        <div
          className={`absolute -top-7 z-40 text-[10px] font-black px-2.5 py-0.5 rounded-full shadow-xl whitespace-nowrap font-mono pointer-events-none ${
            isSubstitutionEligible
              ? "bg-emerald-500 text-slate-950 animate-bounce"
              : "bg-rose-600 text-white max-w-[210px] truncate"
          }`}
        >
          {isSubstitutionEligible
            ? "✓ Drop to Substitute"
            : `✕ ${invalidReason || "Invalid Move"}`}
        </div>
      )}

      <button
        type="button"
        onClick={onClick}
        {...(!isOverlay ? listeners : {})}
        {...(!isOverlay ? attributes : {})}
        style={!isOverlay ? { touchAction: "none" } : undefined}
        className={`group relative flex flex-col items-center focus:outline-none transition-all duration-200 ${interactiveStyles}`}
      >
        {/* Valid / Invalid Move Indicators during Drag */}
        {isDragInProgress && !isSelfBeingDragged && (
          <div
            className={`absolute -top-1.5 -left-1.5 z-30 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-black shadow ring-1 ring-slate-900 font-mono ${
              isSubstitutionEligible
                ? "bg-emerald-400 text-slate-950"
                : "bg-rose-600 text-white"
            }`}
          >
            {isSubstitutionEligible ? "✓" : "✕"}
          </div>
        )}

        {/* Captain / Vice Captain Badge */}
        {isCaptain && (
          <div className="absolute -top-2 -right-1 z-20 w-5 h-5 rounded-full bg-amber-400 text-slate-950 font-black text-[10px] flex items-center justify-center shadow-md shadow-amber-950 ring-2 ring-slate-900 font-mono">
            C
          </div>
        )}
        {!isCaptain && isViceCaptain && (
          <div className="absolute -top-2 -right-1 z-20 w-5 h-5 rounded-full bg-slate-300 text-slate-950 font-black text-[10px] flex items-center justify-center shadow-md shadow-slate-950 ring-2 ring-slate-900 font-mono">
            V
          </div>
        )}

        {/* Swap Indicator if selected */}
        {isSelectedForSwap && (
          <div className="absolute -top-2 -left-1 z-20 w-5 h-5 rounded-full bg-emerald-400 text-slate-950 flex items-center justify-center shadow-md">
            <IconSwap className="w-3 h-3" />
          </div>
        )}

        {/* Tactical Jersey Token */}
        <div
          className={`relative w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-b ${jerseyStyle} border shadow-lg flex items-center justify-center transition-transform group-hover:brightness-110`}
        >
          {/* Subtle kit collar stripe */}
          <div className="absolute top-0 inset-x-2 h-1 bg-white/30 rounded-b-sm" />
          <span className="text-xs sm:text-sm font-black tracking-tight font-mono">
            {player.team?.shortName || player.position}
          </span>
        </div>

        {/* Player Name Pill */}
        <div className="mt-1 w-20 sm:w-24 bg-slate-900/95 border border-slate-800 rounded px-1.5 py-0.5 text-center shadow-md truncate">
          <span className="text-[11px] sm:text-xs font-bold text-white uppercase tracking-tight truncate block">
            {player.displayName || player.lastName}
          </span>
        </div>

        {/* Price & Points Footer */}
        <div className="w-20 sm:w-24 flex items-center justify-between bg-slate-950/90 border-x border-b border-slate-800 rounded-b px-1.5 py-0.5 text-[9px] sm:text-[10px] font-mono">
          <span className="text-slate-400">£{(player.price / 10).toFixed(1)}m</span>
          <span className="font-bold text-emerald-400">{player.totalPoints} pts</span>
        </div>

        {/* Bench Order Label */}
        {benchIndex !== undefined && (
          <div className="mt-1 text-[9px] font-bold text-slate-400 uppercase tracking-wider">
            {benchIndex === 0 ? "Sub GK" : `Sub ${benchIndex}`}
          </div>
        )}
      </button>
    </div>
  );
};
