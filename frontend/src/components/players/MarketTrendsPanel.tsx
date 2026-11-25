"use client";

import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Trend {
  playerId: number;
  displayName: string;
  teamShortName: string;
  price: number;
  netTransfers: number;
  netVelocityPerHour: number;
  targetProgress: number;
}

interface MarketData {
  rising: Trend[];
  falling: Trend[];
  generatedAt: string;
}

export function MarketTrendsPanel() {
  const [active, setActive] = useState<"rising" | "falling">("rising");
  const [data, setData] = useState<MarketData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.get<{ success: boolean; data: MarketData }>("/api/v1/players/market-trends")
      .then((response) => { if (!cancelled) setData(response.data); })
      .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const rows = data?.[active] ?? [];
  return (
    <section className="bg-white border border-slate-200/80 rounded-3xl shadow-sm overflow-hidden" aria-label="Player market trends">
      <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-100">
        <div>
          <h2 className="text-sm font-black uppercase text-slate-900">Market Trends</h2>
          <p className="text-[11px] text-slate-500">Live transfer momentum toward the next estimated price move</p>
        </div>
        <div className="flex rounded-lg border border-slate-200 p-1" role="tablist">
          {(["rising", "falling"] as const).map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={active === tab} onClick={() => setActive(tab)}
              className={`px-3 py-1.5 text-[11px] font-bold uppercase rounded-md ${active === tab ? "bg-slate-900 text-white" : "text-slate-500"}`}>
              {tab}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
            <tr><th className="text-left px-5 py-2.5">Player</th><th className="text-right px-3">Net transfers</th><th className="text-right px-3">Velocity</th><th className="text-left px-5 min-w-44">Target</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.slice(0, 10).map((trend) => {
              const magnitude = Math.abs(trend.targetProgress);
              return <tr key={trend.playerId}>
                <td className="px-5 py-3"><span className="font-bold text-slate-900">{trend.displayName}</span><span className="ml-2 text-slate-400">{trend.teamShortName} · £{trend.price.toFixed(1)}m</span></td>
                <td className={`px-3 text-right font-mono font-bold ${trend.netTransfers >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{trend.netTransfers > 0 ? "+" : ""}{trend.netTransfers}</td>
                <td className="px-3 text-right font-mono text-slate-600">{trend.netVelocityPerHour > 0 ? "+" : ""}{trend.netVelocityPerHour}/h</td>
                <td className="px-5"><div className="flex items-center gap-2"><div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full ${active === "rising" ? "bg-emerald-500" : "bg-rose-500"}`} style={{ width: `${magnitude}%` }} /></div><span className="w-10 text-right font-mono font-bold">{trend.targetProgress}%</span></div></td>
              </tr>;
            })}
            {data && rows.length === 0 && <tr><td colSpan={4} className="px-5 py-8 text-center text-slate-400">No strong candidates in this sync window.</td></tr>}
            {!data && <tr><td colSpan={4} className="px-5 py-8 text-center text-slate-400">Loading market signals...</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
