"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Player, Position, Team } from "@/types";
import { PositionBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  IconSearch,
  IconFootball,
  IconTrophy,
  IconUsers,
} from "@/components/ui/Icons";

export default function PlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState("");
  const [selectedPosition, setSelectedPosition] = useState<string>("ALL");
  const [selectedTeamId, setSelectedTeamId] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<string>("totalPoints");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Fetch teams for club filter
  useEffect(() => {
    async function loadTeams() {
      try {
        const res = await api.get<{ success: boolean; data: Team[] }>("/api/v1/teams");
        if (res?.data) {
          setTeams(res.data);
        }
      } catch (err) {
        console.error("Failed to load teams:", err);
      }
    }
    loadTeams();
  }, []);

  // Fetch players with debounced search
  useEffect(() => {
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("search", search.trim());
        if (selectedPosition !== "ALL") params.set("position", selectedPosition);
        if (selectedTeamId !== "ALL") params.set("teamId", selectedTeamId);
        params.set("sortBy", sortBy);
        params.set("sortOrder", sortOrder);
        params.set("limit", "100");

        const res = await api.get<{
          success: boolean;
          data: { players: Player[] } | Player[];
        }>(`/api/v1/players?${params.toString()}`);

        if (res?.data) {
          const fetched = Array.isArray(res.data) ? res.data : (res.data as any).players || [];
          setPlayers(fetched);
        }
      } catch (err) {
        console.error("Failed to fetch players:", err);
      } finally {
        setIsLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [search, selectedPosition, selectedTeamId, sortBy, sortOrder]);

  return (
    <div className="space-y-6 pb-12 max-w-full overflow-x-hidden">
      {/* Header */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-4 sm:p-6 shadow-lg flex flex-col gap-4 sm:flex-row sm:items-center justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-emerald-400">
              Scouting Intelligence
            </span>
            <span className="text-[10px] sm:text-xs text-slate-500 font-mono">&bull; Premier League Telemetry</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-white uppercase tracking-tight leading-tight">
            Player Browser
          </h1>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-1 max-w-xl leading-relaxed">
            Analyze fantasy form, goal contributions, and market values to optimize your £100m squad.
          </p>
        </div>

        <Link href="/team" className="w-full sm:w-auto">
          <Button variant="primary" size="md" className="w-full sm:w-auto uppercase font-bold tracking-wide text-[10px] sm:text-xs">
            <IconFootball className="w-4 h-4" />
            <span>Manage My Squad</span>
          </Button>
        </Link>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-3 sm:p-4 shadow-md space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Search Input */}
          <div className="relative sm:col-span-1 min-w-0">
            <IconSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search player by name..."
              className="w-full min-w-0 pl-9 pr-3 py-2.5 sm:py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 text-[11px] sm:text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Club Dropdown */}
          <div className="min-w-0">
            <select
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              className="w-full min-w-0 px-3 py-2.5 sm:py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-[11px] sm:text-xs focus:outline-none focus:border-emerald-500"
            >
              <option value="ALL">All Premier League Clubs</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {/* Sort Dropdown */}
          <div className="min-w-0">
            <select
              value={`${sortBy}-${sortOrder}`}
              onChange={(e) => {
                const [sb, so] = e.target.value.split("-");
                setSortBy(sb);
                setSortOrder(so as "desc" | "asc");
              }}
              className="w-full min-w-0 px-3 py-2.5 sm:py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-[11px] sm:text-xs focus:outline-none focus:border-emerald-500"
            >
              <option value="totalPoints-desc">Total Points (High &rarr; Low)</option>
              <option value="price-desc">Price (Most Expensive)</option>
              <option value="price-asc">Price (Budget Gems)</option>
              <option value="goalsScored-desc">Goals Scored</option>
              <option value="assists-desc">Assists</option>
              <option value="cleanSheets-desc">Clean Sheets</option>
              <option value="form-desc">Recent Form</option>
            </select>
          </div>
        </div>

        {/* Position Filter Tabs */}
        <div className="flex flex-col gap-2 pt-2 border-t border-slate-800/80 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800">
            {["ALL", "GKP", "DEF", "MID", "FWD"].map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => setSelectedPosition(pos)}
                className={`px-2.5 py-1.5 sm:px-3 sm:py-1 rounded text-[10px] sm:text-xs font-bold uppercase transition-colors ${
                  selectedPosition === pos
                    ? "bg-emerald-500 text-slate-950 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {pos}
              </button>
            ))}
          </div>

          <div className="text-[10px] sm:text-xs font-mono text-slate-400">
            Showing {players.length} players
          </div>
        </div>
      </div>

      {/* Players Data Table */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl shadow-md overflow-hidden">
        {isLoading ? (
          <div className="py-24 text-center text-slate-400">
            <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-[11px] sm:text-xs">Loading footballer statistics...</p>
          </div>
        ) : players.length > 0 ? (
          <>
            <div className="sm:hidden">
              <div className="divide-y divide-slate-800/60">
                {players.map((p) => (
                  <div key={p.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-white text-sm leading-tight break-words">
                          {p.displayName || `${p.firstName} ${p.lastName}`}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-500 font-sans break-words">
                          {p.firstName} {p.lastName}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="font-mono font-black text-emerald-400 text-sm">
                          {p.totalPoints}
                        </div>
                        <div className="text-[9px] text-slate-500 uppercase tracking-wide">pts</div>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <PositionBadge position={p.position} />
                      <span className="text-[10px] font-mono text-slate-300">
                        {p.team?.shortName || `Team ${p.teamId}`}
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-4 gap-2 text-center text-[10px] text-slate-300">
                      <div className="rounded-md bg-slate-950/60 px-1.5 py-1.5">
                        <div className="text-slate-400 uppercase tracking-wide">£</div>
                        <div className="font-mono font-bold text-white text-[11px] pt-0.5">
                          {(p.price / 10).toFixed(1)}m
                        </div>
                      </div>
                      <div className="rounded-md bg-slate-950/60 px-1.5 py-1.5">
                        <div className="text-slate-400 uppercase tracking-wide">G</div>
                        <div className="font-mono font-bold text-white text-[11px] pt-0.5">{p.goalsScored}</div>
                      </div>
                      <div className="rounded-md bg-slate-950/60 px-1.5 py-1.5">
                        <div className="text-slate-400 uppercase tracking-wide">A</div>
                        <div className="font-mono font-bold text-white text-[11px] pt-0.5">{p.assists}</div>
                      </div>
                      <div className="rounded-md bg-slate-950/60 px-1.5 py-1.5">
                        <div className="text-slate-400 uppercase tracking-wide">CS</div>
                        <div className="font-mono font-bold text-white text-[11px] pt-0.5">{p.cleanSheets}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full min-w-[760px] text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-pitch-border text-slate-400 uppercase font-semibold text-[11px] bg-slate-950/70">
                    <th className="py-3 px-4">Player</th>
                    <th className="py-3 px-3">Position</th>
                    <th className="py-3 px-3">Club</th>
                    <th className="py-3 px-3 text-right">Price</th>
                    <th className="py-3 px-3 text-right">Points</th>
                    <th className="py-3 px-3 text-center">Form</th>
                    <th className="py-3 px-3 text-center">G</th>
                    <th className="py-3 px-3 text-center">A</th>
                    <th className="py-3 px-3 text-center">CS</th>
                    <th className="py-3 px-3 text-right">Mins</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-medium">
                  {players.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-900/40 transition-colors">
                      {/* Name */}
                      <td className="py-3 px-4">
                        <div className="font-bold text-white text-sm">
                          {p.displayName || `${p.firstName} ${p.lastName}`}
                        </div>
                        <div className="text-[10px] text-slate-500 font-sans">
                          {p.firstName} {p.lastName}
                        </div>
                      </td>

                      {/* Position */}
                      <td className="py-3 px-3">
                        <PositionBadge position={p.position} />
                      </td>

                      {/* Club */}
                      <td className="py-3 px-3 font-mono font-medium text-slate-300">
                        {p.team?.shortName || `Team ${p.teamId}`}
                      </td>

                      {/* Price */}
                      <td className="py-3 px-3 text-right font-mono font-bold text-white">
                        £{(p.price / 10).toFixed(1)}m
                      </td>

                      {/* Points */}
                      <td className="py-3 px-3 text-right font-mono font-black text-emerald-400 text-sm">
                        {p.totalPoints}
                      </td>

                      {/* Form */}
                      <td className="py-3 px-3 text-center font-mono text-slate-300">
                        {p.form ?? "—"}
                      </td>

                      {/* Goals */}
                      <td className="py-3 px-3 text-center font-mono text-slate-300">
                        {p.goalsScored}
                      </td>

                      {/* Assists */}
                      <td className="py-3 px-3 text-center font-mono text-slate-300">
                        {p.assists}
                      </td>

                      {/* Clean Sheets */}
                      <td className="py-3 px-3 text-center font-mono text-slate-300">
                        {p.cleanSheets}
                      </td>

                      {/* Minutes */}
                      <td className="py-3 px-3 text-right font-mono text-slate-400">
                        {p.minutesPlayed.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="py-20 text-center text-slate-500 text-xs">
            No footballers found matching the specified filters.
          </div>
        )}
      </div>
    </div>
  );
}
