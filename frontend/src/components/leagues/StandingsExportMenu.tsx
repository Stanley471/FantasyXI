"use client";

import { useState } from "react";
import type { LeagueStandingsEntry } from "@/types";
import {
  toStandingsExportRows,
  buildStandingsCsv,
  buildStandingsJson,
  buildStandingsExportFilename,
} from "@/lib/standingsExport";

export interface StandingsExportMenuProps {
  standings: LeagueStandingsEntry[];
  leagueName: string;
  gameweekLabel?: string | null;
  livePoints?: Record<string, number>;
}

/** One-click CSV/JSON export for whichever standings view is on screen (issue #498). */
export function StandingsExportMenu({
  standings,
  leagueName,
  gameweekLabel,
  livePoints,
}: StandingsExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (standings.length === 0) return null;

  const download = (format: "csv" | "json") => {
    const rows = toStandingsExportRows(standings, livePoints);
    const content = format === "csv" ? buildStandingsCsv(rows) : buildStandingsJson(rows);
    const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
    const blobUrl = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = buildStandingsExportFilename(leagueName, gameweekLabel, format);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    setIsOpen(false);
  };

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-pitch-border bg-pitch-surface/70 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-300 hover:border-slate-500 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
      >
        Export
        <span aria-hidden="true" className="text-slate-500">▾</span>
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label="Export league standings"
          className="absolute right-0 z-10 mt-2 min-w-32 rounded-xl border border-pitch-border bg-pitch-surface p-1.5 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => download("csv")}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white focus:bg-slate-800 focus:outline-none"
          >
            Export CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => download("json")}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white focus:bg-slate-800 focus:outline-none"
          >
            Export JSON
          </button>
        </div>
      )}
    </div>
  );
}

export default StandingsExportMenu;
