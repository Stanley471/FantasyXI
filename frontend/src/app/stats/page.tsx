"use client";

import React, { useEffect, useState } from "react";
import { IconChart, IconTrendingUp } from "@/components/ui/Icons";
import { PositionBadge } from "@/components/ui/PositionBadge";

interface PlayerStat {
  id: number;
  displayName: string;
  position: string;
  teamName: string;
  price: number;
  totalPoints: number;
  selectedCount: number;
  selectedByPercent: number;
  ppm: number;
}

interface OwnershipStatsResponse {
  totalSquads: number;
  topOwned: PlayerStat[];
  ownershipVsPrice: PlayerStat[];
}

export default function StatsDashboardPage() {
  const [stats, setStats] = useState<OwnershipStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<string>("ALL");

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
        const res = await fetch(`${apiUrl}/api/v1/players/ownership-stats`);
        if (!res.ok) throw new Error("Failed to fetch player ownership statistics");
        const json = await res.json();
        setStats(json.data);
      } catch (err: any) {
        setError(err.message || "An error occurred");
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  const filteredVsPrice = stats?.ownershipVsPrice.filter((p) =>
    selectedPosition === "ALL" ? true : p.position === selectedPosition
  ) || [];

  return (
    <div className="space-y-6 pb-12">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header Banner */}
        <header className="bg-white border border-slate-200/80 p-6 sm:p-8 rounded-3xl shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
              Player Ownership &amp; Performance
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 mt-1 max-w-2xl leading-relaxed">
              Macro-level analytics dashboard tracking player ownership, total points, and price efficiency across all squads.
            </p>
          </div>
          <div className="bg-purple-50 px-4 py-2 rounded-xl border border-purple-200/60 text-xs font-semibold text-[#37003c]">
            Total Squads Analyzed: <span className="font-bold text-slate-900">{stats?.totalSquads ?? 0}</span>
          </div>
        </header>

        {loading && (
          <div className="flex justify-center items-center py-20 text-slate-500 text-xs font-semibold">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#37003c] border-t-transparent mr-3"></div>
            Loading analytics dashboard...
          </div>
        )}

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-4 rounded-xl text-xs font-semibold">
            Error loading stats: {error}
          </div>
        )}

        {!loading && !error && stats && (
          <div className="space-y-6">
            {/* Top 20 Most Owned Players Bar Chart */}
            <section className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm">
              <h2 className="text-base font-bold text-slate-900 mb-4 flex items-center gap-2">
                <IconChart className="text-[#37003c] w-4 h-4" /> Top 20 Most Owned Players
              </h2>
              <div className="space-y-3">
                {stats.topOwned.map((player, idx) => {
                  const maxPercent = Math.max(...stats.topOwned.map((p) => p.selectedByPercent), 1);
                  const barWidthPercent = Math.max((player.selectedByPercent / maxPercent) * 100, 2);

                  return (
                    <div key={player.id} className="flex items-center text-xs gap-4">
                      <span className="w-6 text-slate-400 font-mono text-right font-bold">{idx + 1}.</span>
                      <span className="w-40 font-bold truncate text-slate-900">{player.displayName}</span>
                      <span className="w-14 flex justify-center">
                        <PositionBadge position={player.position} />
                      </span>
                      <span className="w-24 text-xs text-slate-500 truncate">{player.teamName}</span>
                      <div className="flex-1 bg-slate-100 rounded-full h-3 overflow-hidden border border-slate-200 relative">
                        <div
                          className="bg-[#00ff87] h-full rounded-full transition-all duration-500"
                          style={{ width: `${barWidthPercent}%` }}
                        />
                      </div>
                      <span className="w-16 font-mono text-right text-emerald-700 font-bold">
                        {player.selectedByPercent}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Scatter Plot / Ownership vs Price & Points */}
            <section className="bg-white p-6 rounded-3xl border border-slate-200/80 shadow-sm space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <IconTrendingUp className="text-[#37003c] w-4 h-4" /> Price vs. Total Points &amp; Value Efficiency (PPM)
                </h2>
                {/* Position Filter */}
                <div className="flex gap-1.5 bg-slate-100 p-1 rounded-xl text-xs">
                  {["ALL", "GKP", "DEF", "MID", "FWD"].map((pos) => (
                    <button
                      key={pos}
                      onClick={() => setSelectedPosition(pos)}
                      className={`px-3 py-1 rounded-lg font-bold text-xs transition ${
                        selectedPosition === pos
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      {pos}
                    </button>
                  ))}
                </div>
              </div>

              {/* Data Table / Interactive Scatter Matrix */}
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-xs text-slate-700">
                  <thead className="text-[10px] uppercase bg-slate-50 text-slate-500 font-bold tracking-wider border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-4">Player</th>
                      <th className="py-3 px-4">Pos</th>
                      <th className="py-3 px-4">Team</th>
                      <th className="py-3 px-4 text-right">Price (£m)</th>
                      <th className="py-3 px-4 text-right">Total Points</th>
                      <th className="py-3 px-4 text-right">Ownership %</th>
                      <th className="py-3 px-4 text-right">PPM (Points / £m)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredVsPrice.slice(0, 50).map((player) => (
                      <tr key={player.id} className="hover:bg-slate-50 transition">
                        <td className="py-2.5 px-4 font-bold text-slate-900">{player.displayName}</td>
                        <td className="py-2.5 px-4">
                          <PositionBadge position={player.position} />
                        </td>
                        <td className="py-2.5 px-4 text-slate-500">{player.teamName}</td>
                        <td className="py-2.5 px-4 text-right font-mono font-medium">£{player.price.toFixed(1)}m</td>
                        <td className="py-2.5 px-4 text-right font-mono font-bold text-slate-900">
                          {player.totalPoints}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-bold text-emerald-700">
                          {player.selectedByPercent}%
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-bold text-amber-700">
                          {player.ppm}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
