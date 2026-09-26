"use client";

import React from "react";
import { Position, SquadPlayer, Player } from "@/types";
import { PlayerCard } from "./PlayerCard";

import { useTeamStore } from "@/store/teamStore";

interface BenchProps {
  isLoading?: boolean;
}

export const Bench: React.FC<BenchProps> = ({ isLoading = false }) => {
  const benchPlayers = useTeamStore((state) => 
    state.players.filter((p) => !p.isStarter).sort((a, b) => a.positionOrder - b.positionOrder)
  );
  // Ensure exactly 4 slots (1 GK, 3 Outfield)
  const defaultSlots: Position[] = [
    Position.GKP,
    Position.DEF,
    Position.MID,
    Position.FWD,
  ];

  return (
    <div className="w-full bg-slate-950/90 border border-pitch-border rounded-xl p-4 sm:p-5 shadow-inner">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Dugout Substitutes
          </span>
        </div>
        <span className="text-[11px] text-slate-500 font-mono">
          Priority Order: Left &rarr; Right
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 sm:gap-4 justify-items-center">
        {[0, 1, 2, 3].map((idx) => {
          const item = benchPlayers[idx];
          const slotPos = item?.player?.position || defaultSlots[idx];
          return (
            <PlayerCard
              key={idx}
              player={isLoading ? null : item?.player}
              positionSlot={slotPos}
              isStarter={false}
              isCaptain={item?.isCaptain}
              isViceCaptain={item?.isViceCaptain}
              benchIndex={idx}
              isLoading={isLoading}
            />
          );
        })}
      </div>
    </div>
  );
};
