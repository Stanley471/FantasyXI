"use client";

import React from "react";
import { Position } from "@/types";

interface PlayerCardSkeletonProps {
  positionSlot: Position;
  isStarter?: boolean;
  benchIndex?: number;
}

export const PlayerCardSkeleton: React.FC<PlayerCardSkeletonProps> = ({
  positionSlot,
  isStarter = true,
  benchIndex,
}) => {
  void positionSlot;

  return (
    <div className="relative flex flex-col items-center" aria-label="Loading player card" aria-busy="true">
      <div className="group relative flex flex-col items-center">
        <div className="relative w-11 h-11 sm:w-12 sm:h-12 rounded-xl border border-slate-700/80 bg-slate-800/90 shadow-lg animate-pulse" />

        <div className="mt-1 h-4 w-20 sm:w-24 rounded bg-slate-800/90 border border-slate-700/80 animate-pulse" />
        <div className="w-20 sm:w-24 h-[18px] mt-0 rounded-b bg-slate-900/90 border-x border-b border-slate-800 animate-pulse" />

        {benchIndex !== undefined && (
          <div className="mt-1 h-2.5 w-12 rounded bg-slate-700/80 animate-pulse" />
        )}
        {!isStarter && benchIndex === undefined && (
          <div className="mt-1 h-2.5 w-10 rounded bg-slate-700/80 animate-pulse" />
        )}
      </div>
    </div>
  );
};
