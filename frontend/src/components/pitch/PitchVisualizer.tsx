"use client";

import React, { useMemo, useState, useCallback } from "react";
import { Position, Player } from "@/types";
import { useTeamStore, LocalSquadPlayer } from "@/store/teamStore";
import {
  calculateSubstitutionPaths,
  getTacticalSlotCoordinates,
  SubstitutionPathsResult,
} from "@/lib/pitch/substitutionPathSolver";
import { detectFormation } from "@/lib/formation";

interface PitchVisualizerProps {
  onPlayerClick?: (player: LocalSquadPlayer) => void;
  isLoading?: boolean;
}

export const PitchVisualizer: React.FC<PitchVisualizerProps> = ({
  onPlayerClick,
  isLoading = false,
}) => {
  const players = useTeamStore((state) => state.players);
  const handleSwap = useTeamStore((state) => state.handleSwap);
  const selectedPlayerId = useTeamStore((state) => state.selectedPlayerId);
  const setSelectedPlayerId = useTeamStore((state) => state.setSelectedPlayerId);
  const activeDragPlayer = useTeamStore((state) => state.activeDragPlayer);
  const setActiveDragPlayer = useTeamStore((state) => state.setActiveDragPlayer);
  const setSubstitutionFeedback = useTeamStore((state) => state.setSubstitutionFeedback);

  const [dragOverPlayerId, setDragOverPlayerId] = useState<number | null>(null);

  // Derive starters and bench
  const starters = useMemo(
    () => players.filter((p) => p.isStarter).sort((a, b) => a.positionOrder - b.positionOrder),
    [players]
  );

  const bench = useMemo(
    () => players.filter((p) => !p.isStarter).sort((a, b) => a.positionOrder - b.positionOrder),
    [players]
  );

  const currentFormation = useMemo(() => detectFormation(starters as any), [starters]);

  // Active player is either the dragged player or the tap-selected player
  const activeSourcePlayer = useMemo(() => {
    if (activeDragPlayer) return activeDragPlayer;
    if (selectedPlayerId !== null) {
      return players.find((p) => p.playerId === selectedPlayerId) ?? null;
    }
    return null;
  }, [activeDragPlayer, selectedPlayerId, players]);

  // Real-time substitution path solver
  const pathsResult: SubstitutionPathsResult | null = useMemo(() => {
    if (!activeSourcePlayer) return null;
    return calculateSubstitutionPaths(activeSourcePlayer, players);
  }, [activeSourcePlayer, players]);

  // Group starters by tactical rows
  const gkpStarters = useMemo(() => starters.filter((s) => s.player.position === Position.GKP), [starters]);
  const defStarters = useMemo(() => starters.filter((s) => s.player.position === Position.DEF), [starters]);
  const midStarters = useMemo(() => starters.filter((s) => s.player.position === Position.MID), [starters]);
  const fwdStarters = useMemo(() => starters.filter((s) => s.player.position === Position.FWD), [starters]);

  // Tactical Swap Handler
  const executeSwap = useCallback(
    (sourceId: number, targetId: number) => {
      const success = handleSwap(sourceId, targetId);
      if (success) {
        setSelectedPlayerId(null);
        setActiveDragPlayer(null);
        setDragOverPlayerId(null);
      }
    },
    [handleSwap, setSelectedPlayerId, setActiveDragPlayer]
  );

  // Click / Tap Handler
  const handleSlotClick = useCallback(
    (player: LocalSquadPlayer) => {
      if (onPlayerClick) {
        onPlayerClick(player);
      }

      if (!activeSourcePlayer) {
        // Select as source
        setSelectedPlayerId(player.playerId);
        setSubstitutionFeedback(null);
      } else if (activeSourcePlayer.playerId === player.playerId) {
        // Deselect
        setSelectedPlayerId(null);
        setSubstitutionFeedback(null);
      } else {
        // Attempt substitution
        const targetPath = pathsResult?.allTargets.get(player.playerId);
        if (targetPath?.isEligible) {
          executeSwap(activeSourcePlayer.playerId, player.playerId);
        } else {
          setSubstitutionFeedback({
            type: "error",
            message: targetPath?.reason || "Ineligible substitution target.",
          });
        }
      }
    },
    [activeSourcePlayer, pathsResult, setSelectedPlayerId, setSubstitutionFeedback, executeSwap, onPlayerClick]
  );

  // Drag Event Handlers
  const handleDragStart = (e: React.DragEvent, player: LocalSquadPlayer) => {
    e.dataTransfer.setData("text/plain", String(player.playerId));
    e.dataTransfer.effectAllowed = "move";
    setActiveDragPlayer(player);
    setSelectedPlayerId(player.playerId);
  };

  const handleDragEnd = () => {
    setActiveDragPlayer(null);
    setDragOverPlayerId(null);
  };

  const handleDragOver = (e: React.DragEvent, targetPlayerId: number) => {
    e.preventDefault();
    if (dragOverPlayerId !== targetPlayerId) {
      setDragOverPlayerId(targetPlayerId);
    }
  };

  const handleDrop = (e: React.DragEvent, targetPlayer: LocalSquadPlayer) => {
    e.preventDefault();
    const sourceId = activeDragPlayer?.playerId || Number(e.dataTransfer.getData("text/plain"));
    if (sourceId && sourceId !== targetPlayer.playerId) {
      const targetPath = pathsResult?.allTargets.get(targetPlayer.playerId);
      if (targetPath?.isEligible) {
        executeSwap(sourceId, targetPlayer.playerId);
      } else {
        setSubstitutionFeedback({
          type: "error",
          message: targetPath?.reason || "Ineligible substitution target.",
        });
      }
    }
    setActiveDragPlayer(null);
    setDragOverPlayerId(null);
  };

  // Render a player token
  const renderPlayerNode = (
    player: LocalSquadPlayer,
    isStarterSlot: boolean,
    coords?: { x: number; y: number }
  ) => {
    const isSelected = activeSourcePlayer?.playerId === player.playerId;
    const pathTarget = pathsResult?.allTargets.get(player.playerId);
    const isEligibleTarget = !!pathTarget?.isEligible;
    const isIneligibleTarget = activeSourcePlayer && !isSelected && !isEligibleTarget;
    const isDragOver = dragOverPlayerId === player.playerId;

    const morphInfo = pathsResult?.possibleFormationMorphs.find(
      (m) => m.targetPlayerId === player.playerId
    );

    return (
      <div
        key={player.playerId}
        draggable
        onDragStart={(e) => handleDragStart(e, player)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => handleDragOver(e, player.playerId)}
        onDrop={(e) => handleDrop(e, player)}
        onClick={() => handleSlotClick(player)}
        tabIndex={0}
        role="button"
        aria-label={`${player.player.displayName}, ${player.player.position}, £${(player.player.price / 10).toFixed(1)}m. ${isEligibleTarget ? "Eligible swap target." : ""}`}
        aria-pressed={isSelected}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleSlotClick(player);
          } else if (e.key === "Escape") {
            setSelectedPlayerId(null);
            setActiveDragPlayer(null);
          }
        }}
        style={
          coords
            ? {
                left: `${coords.x}%`,
                top: `${coords.y}%`,
                transform: "translate(-50%, -50%)",
                transition: "all 400ms cubic-bezier(0.4, 0, 0.2, 1)",
              }
            : undefined
        }
        className={`group cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 rounded-xl transition-all ${
          coords ? "absolute" : "relative"
        } ${
          isSelected
            ? "scale-110 z-30 ring-2 ring-emerald-400 shadow-lg shadow-emerald-500/30"
            : isEligibleTarget
            ? "scale-105 z-20 ring-2 ring-emerald-500/80 shadow-md shadow-emerald-500/20 animate-pulse"
            : isIneligibleTarget
            ? "opacity-35 grayscale z-10"
            : "hover:scale-105 z-10"
        } ${isDragOver && isEligibleTarget ? "scale-115 ring-4 ring-emerald-300" : ""}`}
        data-testid={`player-node-${player.playerId}`}
        data-eligible={isEligibleTarget}
        data-ineligible={isIneligibleTarget}
      >
        <div className="flex flex-col items-center">
          {/* Tactical Morph Badge */}
          {morphInfo && (
            <span className="mb-1 text-[9px] font-black tracking-wider uppercase px-1.5 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-500/50 shadow">
              ➔ {morphInfo.newFormation}
            </span>
          )}

          {/* Swap Indicator Badge */}
          {isEligibleTarget && !morphInfo && (
            <span className="mb-1 text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded-full bg-emerald-500 text-slate-950 shadow">
              SWAP
            </span>
          )}

          {/* Jersey / Token Avatar */}
          <div
            className={`w-11 h-11 sm:w-13 sm:h-13 rounded-full flex items-center justify-center font-bold text-xs shadow-md border-2 ${
              player.player.position === Position.GKP
                ? "bg-amber-600 border-amber-300 text-amber-50"
                : player.player.position === Position.DEF
                ? "bg-blue-600 border-blue-300 text-blue-50"
                : player.player.position === Position.MID
                ? "bg-emerald-600 border-emerald-300 text-emerald-50"
                : "bg-rose-600 border-rose-300 text-rose-50"
            }`}
          >
            {player.player.position}
            {player.isCaptain && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 text-slate-950 font-black text-[9px] flex items-center justify-center shadow">
                C
              </span>
            )}
            {player.isViceCaptain && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-slate-200 text-slate-950 font-black text-[9px] flex items-center justify-center shadow">
                V
              </span>
            )}
          </div>

          {/* Player Name Card */}
          <div className="mt-1 px-1.5 py-0.5 bg-slate-900/90 backdrop-blur rounded border border-slate-700/80 text-center max-w-[85px] truncate">
            <p className="text-[10px] sm:text-[11px] font-semibold text-slate-100 truncate">
              {player.player.displayName || player.player.lastName}
            </p>
            <p className="text-[9px] text-slate-400">
              £{(player.player.price / 10).toFixed(1)}m
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className="w-full flex flex-col items-center bg-slate-950 text-slate-100 rounded-3xl p-3 sm:p-6 shadow-2xl border border-slate-800"
      role="region"
      aria-label="Tactical Pitch Visualizer"
    >
      {/* Top Bar with Formation and Instructions */}
      <div className="w-full flex items-center justify-between mb-3 px-2">
        <div className="flex items-center space-x-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Active Formation:
          </span>
          <span
            className="px-2.5 py-0.5 bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono font-bold text-sm rounded-lg"
            data-testid="formation-badge"
          >
            {currentFormation}
          </span>
        </div>

        {activeSourcePlayer && (
          <div className="flex items-center space-x-2">
            <span className="text-xs text-amber-300 font-medium">
              Substituting: {activeSourcePlayer.player.displayName}
            </span>
            <button
              onClick={() => {
                setSelectedPlayerId(null);
                setActiveDragPlayer(null);
                setSubstitutionFeedback(null);
              }}
              className="text-[11px] px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* SVG Tactical Pitch Field */}
      <div className="relative w-full max-w-[620px] aspect-[3/4] rounded-2xl overflow-hidden border-2 border-emerald-900 shadow-inner bg-gradient-to-b from-emerald-900 via-emerald-850 to-emerald-950">
        {/* SVG Pitch Markings */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none opacity-40"
          viewBox="0 0 100 133"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Pitch Outer Boundary */}
          <rect x="2" y="2" width="96" height="129" fill="none" stroke="#fff" strokeWidth="0.8" />

          {/* Halfway Line */}
          <line x1="2" y1="66.5" x2="98" y2="66.5" stroke="#fff" strokeWidth="0.8" />

          {/* Center Circle & Spot */}
          <circle cx="50" cy="66.5" r="14" fill="none" stroke="#fff" strokeWidth="0.8" />
          <circle cx="50" cy="66.5" r="0.8" fill="#fff" />

          {/* Top Penalty Box (Forward Area) */}
          <rect x="22" y="2" width="56" height="22" fill="none" stroke="#fff" strokeWidth="0.8" />
          <rect x="36" y="2" width="28" height="8" fill="none" stroke="#fff" strokeWidth="0.8" />
          <circle cx="50" cy="16" r="0.8" fill="#fff" />
          <path d="M 40 24 A 10 10 0 0 0 60 24" fill="none" stroke="#fff" strokeWidth="0.8" />

          {/* Bottom Penalty Box (Goalkeeper Area) */}
          <rect x="22" y="109" width="56" height="22" fill="none" stroke="#fff" strokeWidth="0.8" />
          <rect x="36" y="123" width="28" height="8" fill="none" stroke="#fff" strokeWidth="0.8" />
          <circle cx="50" cy="117" r="0.8" fill="#fff" />
          <path d="M 40 109 A 10 10 0 0 1 60 109" fill="none" stroke="#fff" strokeWidth="0.8" />

          {/* Corner Arcs */}
          <path d="M 2 5 A 3 3 0 0 0 5 2" fill="none" stroke="#fff" strokeWidth="0.8" />
          <path d="M 95 2 A 3 3 0 0 0 98 5" fill="none" stroke="#fff" strokeWidth="0.8" />
          <path d="M 2 128 A 3 3 0 0 1 5 131" fill="none" stroke="#fff" strokeWidth="0.8" />
          <path d="M 95 131 A 3 3 0 0 1 98 128" fill="none" stroke="#fff" strokeWidth="0.8" />
        </svg>

        {/* Dynamic Starter Players on Pitch */}
        <div className="absolute inset-0">
          {/* Forwards */}
          {fwdStarters.map((player, idx) => {
            const coords = getTacticalSlotCoordinates(Position.FWD, idx, fwdStarters.length);
            return renderPlayerNode(player, true, coords);
          })}

          {/* Midfielders */}
          {midStarters.map((player, idx) => {
            const coords = getTacticalSlotCoordinates(Position.MID, idx, midStarters.length);
            return renderPlayerNode(player, true, coords);
          })}

          {/* Defenders */}
          {defStarters.map((player, idx) => {
            const coords = getTacticalSlotCoordinates(Position.DEF, idx, defStarters.length);
            return renderPlayerNode(player, true, coords);
          })}

          {/* Goalkeepers */}
          {gkpStarters.map((player, idx) => {
            const coords = getTacticalSlotCoordinates(Position.GKP, idx, gkpStarters.length);
            return renderPlayerNode(player, true, coords);
          })}
        </div>
      </div>

      {/* Tactile Substitutes Bench */}
      <div className="w-full max-w-[620px] mt-4 p-3 bg-slate-900/70 border border-slate-800 rounded-2xl flex flex-col items-center">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
          Substitutes Bench
        </span>
        <div className="w-full flex items-center justify-around gap-2 px-2">
          {bench.map((subPlayer) => renderPlayerNode(subPlayer, false))}
        </div>
      </div>
    </div>
  );
};
