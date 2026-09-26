"use client";

import React, { useMemo } from "react";
import { Position, SquadPlayer, Player } from "@/types";
import { PlayerCard } from "./PlayerCard";
import { detectFormation } from "@/lib/formation";

import { useTeamStore } from "@/store/teamStore";

export const Pitch: React.FC = () => {
  // Select the raw players array and derive `starters` with useMemo rather than
  // inside the selector: a selector that returns a freshly filtered/sorted array
  // on every call breaks useSyncExternalStore's reference-equality check and
  // causes an infinite re-render loop ("Maximum update depth exceeded").
  const players = useTeamStore((state) => state.players);
  const starters = useMemo(
    () => players.filter((p) => p.isStarter).sort((a, b) => a.positionOrder - b.positionOrder),
    [players]
  );

  // Group starters by position
  const gkpStarters = starters.filter(
    (s) => s.player?.position === Position.GKP
  );
  const defStarters = starters.filter(
    (s) => s.player?.position === Position.DEF
  );
  const midStarters = starters.filter(
    (s) => s.player?.position === Position.MID
  );
  const fwdStarters = starters.filter(
    (s) => s.player?.position === Position.FWD
  );

  // If squad is not fully selected yet, fill placeholder slots according to standard 4-4-2
  const gkpSlots = gkpStarters.length > 0 ? gkpStarters : [null];
  const defSlots = defStarters.length > 0 ? defStarters : [null, null, null, null];
  const midSlots = midStarters.length > 0 ? midStarters : [null, null, null, null];
  const fwdSlots = fwdStarters.length > 0 ? fwdStarters : [null, null];

  const currentFormation = detectFormation(starters as any);

  return (
    <div className="w-full relative rounded-2xl overflow-hidden shadow-2xl border border-pitch-border bg-slate-950" data-testid="pitch">
      {/* Tactical Grass Pitch Canvas */}
      <div className="pitch-grass relative w-full min-h-[580px] sm:min-h-[660px] flex flex-col justify-between py-6 px-2 sm:px-6">
        {/* Pitch Tactical Line Markings */}
        <div className="absolute inset-0 pointer-events-none opacity-40">
          {/* Halfway line */}
          <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-white/40 -translate-y-1/2" />
          {/* Center circle */}
          <div className="absolute top-1/2 left-1/2 w-32 h-32 sm:w-40 sm:h-40 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/40" />
          {/* Center spot */}
          <div className="absolute top-1/2 left-1/2 w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/60" />
          {/* Top Penalty Box (Keeper Area) */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 sm:w-64 h-24 sm:h-28 border-b-2 border-x-2 border-white/30 rounded-b-lg" />
          {/* Bottom Penalty Box */}
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-48 sm:w-64 h-24 sm:h-28 border-t-2 border-x-2 border-white/30 rounded-t-lg" />
        </div>

        {/* Pitch Status Header */}
        <div className="relative z-10 flex items-center justify-between px-3 py-1.5 mb-2 border-b border-white/10 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 uppercase tracking-wider text-[11px]">Formation</span>
            <span className="text-emerald-400 font-bold">{currentFormation}</span>
          </div>

          <div className="text-[11px] text-slate-300 tracking-wide">
            <span className="text-white font-semibold">{starters.filter((s) => !!s.player).length}</span>
            <span className="text-slate-400"> / 11 Starters</span>
          </div>
        </div>

        {/* Row 1: Goalkeeper (GKP) */}
        <div className="relative z-10 flex justify-center items-center py-2">
          {gkpSlots.map((item, idx) => {
            return (
              <PlayerCard
                key={`gkp-${idx}`}
                player={item?.player}
                positionSlot={Position.GKP}
                isStarter={true}
                isCaptain={item?.isCaptain}
                isViceCaptain={item?.isViceCaptain}
              />
            );
          })}
        </div>

        {/* Row 2: Defenders (DEF) */}
        <div className="relative z-10 flex justify-around items-center py-2 gap-1 sm:gap-2">
          {defSlots.map((item, idx) => {
            return (
              <PlayerCard
                key={`def-${idx}`}
                player={item?.player}
                positionSlot={Position.DEF}
                isStarter={true}
                isCaptain={item?.isCaptain}
                isViceCaptain={item?.isViceCaptain}
              />
            );
          })}
        </div>

        {/* Row 3: Midfielders (MID) */}
        <div className="relative z-10 flex justify-around items-center py-2 gap-1 sm:gap-2">
          {midSlots.map((item, idx) => {
            return (
              <PlayerCard
                key={`mid-${idx}`}
                player={item?.player}
                positionSlot={Position.MID}
                isStarter={true}
                isCaptain={item?.isCaptain}
                isViceCaptain={item?.isViceCaptain}
              />
            );
          })}
        </div>

        {/* Row 4: Forwards (FWD) */}
        <div className="relative z-10 flex justify-around items-center py-2 gap-1 sm:gap-2">
          {fwdSlots.map((item, idx) => {
            return (
              <PlayerCard
                key={`fwd-${idx}`}
                player={item?.player}
                positionSlot={Position.FWD}
                isStarter={true}
                isCaptain={item?.isCaptain}
                isViceCaptain={item?.isViceCaptain}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};
