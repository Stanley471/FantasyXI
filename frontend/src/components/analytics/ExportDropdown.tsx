"use client";

import { useState } from "react";
import type { PerformanceAnalytics } from "@/types";
import { buildPerformanceCsv, buildPerformanceJson } from "@/lib/performanceExport";

export interface ExportDropdownProps {
  analytics: PerformanceAnalytics;
}

export function ExportDropdown({ analytics }: ExportDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!analytics.squadId) return null;

  const download = (format: "csv" | "json") => {
    const content = format === "csv"
      ? buildPerformanceCsv(analytics)
      : buildPerformanceJson(analytics);
    const mimeType = format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
    const blobUrl = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `fantasyxi-performance-squad-${analytics.squadId}.${format}`;
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
        className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-pitch-border bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-100 hover:border-emerald-500/50 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
      >
        Export data
        <span aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label="Export performance data"
          className="absolute right-0 z-10 mt-2 min-w-36 rounded-lg border border-pitch-border bg-slate-900 p-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => download("csv")}
            className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800 focus:bg-slate-800 focus:outline-none"
          >
            Export CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => download("json")}
            className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800 focus:bg-slate-800 focus:outline-none"
          >
            Export JSON
          </button>
        </div>
      )}
    </div>
  );
}
