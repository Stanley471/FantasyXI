"use client";

import React, { useEffect, useState } from "react";

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
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6 md:p-12">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <header className="border-b border-slate-800 pb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Global Player Ownership & Performance Analytics
            </h1>
            <p className="text-slate-400 mt-1">
              Macro-level analytics dashboard tracking player ownership, total points, and price efficiency across all squads.
            </p>
          </div>
          <div className="bg-slate-800 px-4 py-2 rounded-lg border border-slate-700 text-sm">
            Total Squads Analyzed: <span className="font-semibold text-emerald-400">{stats?.totalSquads ?? 0}</span>
          </div>
        </header>

        {loading && (
          <div className="flex justify-center items-center py-20 text-slate-400">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500 mr-3"></div>
            Loading analytics dashboard...
          </div>
        )}

        {error && (
          <div className="bg-red-950/50 border border-red-800 text-red-300 p-4 rounded-lg">
            Error loading stats: {error}
          </div>
        )}

        {!loading && !error && stats && (
          <div className="space-y-12">
            {/* Top 20 Most Owned Players Bar Chart */}
            <section className="bg-slate-800/60 p-6 rounded-xl border border-slate-700/60">
              <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
                <span className="text-emerald-400">📊</span> Top 20 Most Owned Players
              </h2>
              <div className="space-y-3">
                {stats.topOwned.map((player, idx) => {
                  const maxPercent = Math.max(...stats.topOwned.map((p) => p.selectedByPercent), 1);
                  const barWidthPercent = Math.max((player.selectedByPercent / maxPercent) * 100, 2);

                  return (
                    <div key={player.id} className="flex items-center text-sm gap-4">
                      <span className="w-6 text-slate-500 font-mono text-right">{idx + 1}.</span>
                      <span className="w-40 font-medium truncate text-slate-200">{player.displayName}</span>
                      <span className="w-14 text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 text-center font-mono">
                        {player.position}
                      </span>
                      <span className="w-24 text-xs text-slate-400 truncate">{player.teamName}</span>
                      <div className="flex-1 bg-slate-900 rounded-full h-4 overflow-hidden border border-slate-700/50 relative">
                        <div
                          className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                          style={{ width: `${barWidthPercent}%` }}
                        />
                      </div>
                      <span className="w-16 font-mono text-right text-emerald-400 font-semibold">
                        {player.selectedByPercent}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Scatter Plot / Ownership vs Price & Points */}
            <section className="bg-slate-800/60 p-6 rounded-xl border border-slate-700/60 space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  <span className="text-sky-400">📈</span> Price vs. Total Points & Value Efficiency (PPM)
                </h2>
                {/* Position Filter */}
                <div className="flex gap-2 bg-slate-900 p-1 rounded-lg border border-slate-700 text-xs">
                  {["ALL", "GKP", "DEF", "MID", "FWD"].map((pos) => (
                    <button
                      key={pos}
                      onClick={() => setSelectedPosition(pos)}
                      className={`px-3 py-1.5 rounded-md font-medium transition ${
                        selectedPosition === pos
                          ? "bg-emerald-600 text-white shadow"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {pos}
                    </button>
                  ))}
                </div>
              </div>

              {/* Data Table / Interactive Scatter Matrix */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="text-xs uppercase bg-slate-900/80 text-slate-400 border-b border-slate-700">
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
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredVsPrice.slice(0, 50).map((player) => (
                      <tr key={player.id} className="hover:bg-slate-800/40 transition">
                        <td className="py-3 px-4 font-medium text-white">{player.displayName}</td>
                        <td className="py-3 px-4">
                          <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                            {player.position}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-400">{player.teamName}</td>
                        <td className="py-3 px-4 text-right font-mono">£{player.price.toFixed(1)}m</td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-sky-400">
                          {player.totalPoints}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-emerald-400">
                          {player.selectedByPercent}%
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-amber-400 font-semibold">
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
