"use client";

import React, { useEffect, useState } from "react";
import { Player } from "@/types";
import { api } from "@/lib/api";
import { PositionBadge } from "@/components/ui/Badge";
import { IconClose } from "@/components/ui/Icons";

export interface PlayerCompareModalProps {
  isOpen: boolean;
  onClose: () => void;
  playerA: Player;
  playerB: Player;
}

interface PlayerAnalytics {
  averageFdr: number | null;
}

/** Higher is better unless `lowerIsBetter` is set (e.g. fixture difficulty). */
interface CompareRow {
  label: string;
  valueA: number | null;
  valueB: number | null;
  format: (value: number | null) => string;
  lowerIsBetter?: boolean;
}

function winner(row: CompareRow): "A" | "B" | null {
  if (row.valueA == null || row.valueB == null || row.valueA === row.valueB) return null;
  const aWins = row.lowerIsBetter ? row.valueA < row.valueB : row.valueA > row.valueB;
  return aWins ? "A" : "B";
}

export const PlayerCompareModal: React.FC<PlayerCompareModalProps> = ({
  isOpen,
  onClose,
  playerA,
  playerB,
}) => {
  const [fdrA, setFdrA] = useState<number | null>(null);
  const [fdrB, setFdrB] = useState<number | null>(null);
  const [isLoadingFdr, setIsLoadingFdr] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    async function loadFixtureDifficulty() {
      setIsLoadingFdr(true);
      try {
        const [resA, resB] = await Promise.all([
          api.get<{ success: boolean; data: PlayerAnalytics }>(
            `/api/v1/players/${playerA.id}/analytics?horizon=5`
          ),
          api.get<{ success: boolean; data: PlayerAnalytics }>(
            `/api/v1/players/${playerB.id}/analytics?horizon=5`
          ),
        ]);
        if (!cancelled) {
          setFdrA(resA?.data?.averageFdr ?? null);
          setFdrB(resB?.data?.averageFdr ?? null);
        }
      } catch (err) {
        console.error("Failed to load fixture difficulty:", err);
      } finally {
        if (!cancelled) setIsLoadingFdr(false);
      }
    }
    loadFixtureDifficulty();

    return () => {
      cancelled = true;
    };
  }, [isOpen, playerA.id, playerB.id]);

  if (!isOpen) return null;

  const rows: CompareRow[] = [
    {
      label: "Price",
      valueA: playerA.price,
      valueB: playerB.price,
      format: (v) => (v == null ? "—" : `£${(v / 10).toFixed(1)}m`),
      lowerIsBetter: true,
    },
    {
      label: "Total Points",
      valueA: playerA.totalPoints,
      valueB: playerB.totalPoints,
      format: (v) => (v == null ? "—" : String(v)),
    },
    {
      label: "Form",
      valueA: playerA.form ?? null,
      valueB: playerB.form ?? null,
      format: (v) => (v == null ? "—" : v.toFixed(1)),
    },
    {
      label: "Goals",
      valueA: playerA.goalsScored,
      valueB: playerB.goalsScored,
      format: (v) => (v == null ? "—" : String(v)),
    },
    {
      label: "Assists",
      valueA: playerA.assists,
      valueB: playerB.assists,
      format: (v) => (v == null ? "—" : String(v)),
    },
    {
      label: "Clean Sheets",
      valueA: playerA.cleanSheets,
      valueB: playerB.cleanSheets,
      format: (v) => (v == null ? "—" : String(v)),
    },
    {
      label: "Fixture Difficulty",
      valueA: fdrA,
      valueB: fdrB,
      format: (v) => (v == null ? (isLoadingFdr ? "…" : "—") : v.toFixed(1)),
      lowerIsBetter: true,
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compare players"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fadeIn"
    >
      <div className="relative w-full max-w-2xl bg-white border border-slate-200/90 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
          <h2 className="text-lg font-black text-slate-900 uppercase tracking-tight">
            Player Comparison
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close comparison"
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        {/* Player headers */}
        <div className="grid grid-cols-2 border-b border-slate-100 bg-white">
          {[playerA, playerB].map((p) => (
            <div key={p.id} className="p-3 sm:p-4 min-w-0 text-center border-r border-slate-100 last:border-r-0">
              <div className="font-bold text-slate-900 text-xs sm:text-sm truncate">
                {p.displayName || `${p.firstName} ${p.lastName}`}
              </div>
              <div className="mt-1 flex items-center justify-center gap-1.5">
                <PositionBadge position={p.position} />
                <span className="text-[10px] font-mono text-slate-500">
                  {p.team?.shortName || `Team ${p.teamId}`}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Metric rows */}
        <div className="overflow-y-auto divide-y divide-slate-100">
          {rows.map((row) => {
            const win = winner(row);
            return (
              <div key={row.label} className="grid grid-cols-[1fr_2fr_1fr] sm:grid-cols-[1fr_2.5fr_1fr] items-center text-xs">
                <div
                  data-testid={`cell-${row.label}-A`}
                  className={`py-3 px-2 sm:px-3 text-right font-mono font-bold ${
                    win === "A" ? "bg-emerald-50 text-emerald-700" : "text-slate-700"
                  }`}
                >
                  {row.format(row.valueA)}
                </div>
                <div className="py-3 px-2 text-center text-[10px] sm:text-xs font-bold uppercase tracking-wide text-slate-500">
                  {row.label}
                </div>
                <div
                  data-testid={`cell-${row.label}-B`}
                  className={`py-3 px-2 sm:px-3 text-left font-mono font-bold ${
                    win === "B" ? "bg-emerald-50 text-emerald-700" : "text-slate-700"
                  }`}
                >
                  {row.format(row.valueB)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PlayerCompareModal;
