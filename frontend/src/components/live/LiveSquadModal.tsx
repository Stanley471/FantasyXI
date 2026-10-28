"use client";

import React, { useEffect } from "react";
import { LivePlayerEvent, LiveStandingsEntry } from "@/types";
import { IconClose } from "@/components/ui/Icons";
import { LivePitchCanvas } from "@/components/pitch/LivePitchCanvas";

export interface LiveSquadModalProps {
  entry: LiveStandingsEntry;
  /** Live per-player event counters, animated on the pitch as they change. */
  events?: LivePlayerEvent[];
  onClose: () => void;
}

/**
 * Live starting XI of a manager with per-player points and captain multipliers.
 */
export const LiveSquadModal: React.FC<LiveSquadModalProps> = ({ entry, events, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Players counting this gameweek: starters not subbed out + bench players subbed in
  const counting = entry.lineup.filter((p) => (p.isStarter && !p.subbedOut) || p.subbedIn);
  const others = entry.lineup.filter((p) => !counting.includes(p));

  const renderRow = (p: LiveStandingsEntry["lineup"][number], muted = false) => (
    <tr key={p.playerId} className={muted ? "text-slate-500" : "text-slate-200"}>
      <td className="py-1.5 pr-2 text-[10px] font-mono text-slate-500">{p.position}</td>
      <td className="py-1.5 pr-2">
        <span className="font-semibold">{p.name}</span>
        <span className="text-[10px] text-slate-500 ml-1">{p.teamShortName}</span>
        {p.multiplier > 1 && (
          <span className="ml-1.5 text-[10px] font-black px-1 rounded bg-amber-400 text-slate-950">
            {p.multiplier === 3 ? "TC" : "C"} x{p.multiplier}
          </span>
        )}
        {p.isViceCaptain && p.multiplier === 1 && (
          <span className="ml-1.5 text-[10px] font-bold px-1 rounded border border-slate-600 text-slate-400">V</span>
        )}
        {p.subbedIn && <span className="ml-1.5 text-[10px] text-emerald-400">Sub in</span>}
        {p.subbedOut && <span className="ml-1.5 text-[10px] text-rose-400">Sub out</span>}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono text-[11px] text-slate-500">{p.minutesPlayed}&apos;</td>
      <td className="py-1.5 text-right font-mono font-bold tabular-nums">
        {muted ? p.rawPoints : p.effectivePoints}
      </td>
    </tr>
  );

  return (
    // No backdrop blur: a backdrop filter is recomputed on every frame the
    // animated pitch paints (measured: 6.8 fps with the blur vs 28 fps without)
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${entry.squadName} live points`}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto bg-slate-900 border border-pitch-border rounded-xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-black text-white">{entry.squadName}</h3>
            <p className="text-xs text-slate-400">@{entry.username}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-2xl font-black font-mono text-emerald-400 tabular-nums">{entry.livePoints}</div>
              <div className="text-[10px] uppercase text-slate-500 font-semibold">Live pts</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-white"
              aria-label="Close"
            >
              <IconClose className="w-5 h-5" />
            </button>
          </div>
        </div>

        <LivePitchCanvas lineup={entry.lineup} events={events} className="mb-4" />

        <table className="w-full text-xs">
          <tbody className="divide-y divide-slate-800/60">{counting.map((p) => renderRow(p))}</tbody>
        </table>

        {others.length > 0 && (
          <>
            <div className="text-[10px] uppercase text-slate-500 font-semibold mt-4 mb-1">Bench</div>
            <table className="w-full text-xs">
              <tbody className="divide-y divide-slate-800/60">{others.map((p) => renderRow(p, true))}</tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
};
