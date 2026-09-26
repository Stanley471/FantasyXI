"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
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
import { useVirtualList } from "@/hooks/useVirtualList";

export default function PlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState("");
  const [selectedPosition, setSelectedPosition] = useState<string>("ALL");
  const [selectedTeamId, setSelectedTeamId] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<string>("totalPoints");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Ref on the scrollable table wrapper for the virtualiser
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Players are already filtered + sorted by the API; memoize to keep a
  // stable reference so useVirtualList only recomputes when data changes.
  const filteredPlayers = useMemo(() => players, [players]);

  // Virtualise: 52 px per row, 10-row overscan buffer
  const { virtualItems, totalHeight } = useVirtualList(
    filteredPlayers,
    52,
    tableContainerRef,
    10
  );

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
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Scouting Intelligence
            </span>
            <span className="text-xs text-slate-500 font-mono">&bull; Premier League Telemetry</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-white uppercase tracking-tight">
            Player Browser
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Analyze fantasy form, goal contributions, and market values to optimize your £100m squad.
          </p>
        </div>

        <Link href="/team">
          <Button variant="primary" size="md" className="uppercase font-bold tracking-wide text-xs">
            <IconFootball className="w-4 h-4" />
            <span>Manage My Squad</span>
          </Button>
        </Link>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-4 shadow-md space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Search Input */}
          <div className="relative sm:col-span-1">
            <IconSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search player by name..."
              className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Club Dropdown */}
          <div>
            <select
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
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
          <div>
            <select
              value={`${sortBy}-${sortOrder}`}
              onChange={(e) => {
                const [sb, so] = e.target.value.split("-");
                setSortBy(sb);
                setSortOrder(so as "desc" | "asc");
              }}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
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
        <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
          <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800">
            {["ALL", "GKP", "DEF", "MID", "FWD"].map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => setSelectedPosition(pos)}
                className={`px-3 py-1 rounded text-xs font-bold uppercase transition-colors ${
                  selectedPosition === pos
                    ? "bg-emerald-500 text-slate-950 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {pos}
              </button>
            ))}
          </div>

          <div className="text-xs font-mono text-slate-400">
            Showing {players.length} players
          </div>
        </div>
      </div>

      {/* Players Data Table — virtualised */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl shadow-md overflow-hidden">
        {isLoading ? (
          <div className="py-24 text-center text-slate-400">
            <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-xs">Loading footballer statistics...</p>
          </div>
        ) : filteredPlayers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
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
            </table>
            {/*
              Scrollable virtualisation container.
              - Fixed height caps the visible area (17 rows × 52 px ≈ 884 px)
              - overflow-y-auto owns the scroll event that useVirtualList listens to
              - The inner div is the full logical height so the scrollbar is correct
            */}
            <div
              ref={tableContainerRef}
              className="overflow-y-auto"
              style={{ maxHeight: "884px" }}
            >
              {/* Spacer div expands to the total logical height */}
              <div style={{ position: "relative", height: totalHeight, willChange: "transform" }}>
                <table className="w-full text-left border-collapse text-xs">
                  <tbody className="font-medium">
                    {virtualItems.map(({ index, item: p, offsetTop }) => (
                      <tr
                        key={p.id}
                        className="hover:bg-slate-900/40 transition-colors border-b border-slate-800/60"
                        style={{
                          position: "absolute",
                          top: offsetTop,
                          width: "100%",
                          height: 52,
                          display: "table",
                          tableLayout: "fixed",
                        }}
                      >
                        {/* Name */}
                        <td className="py-3 px-4" style={{ width: "22%" }}>
                          <div className="font-bold text-white text-sm truncate">
                            {p.displayName || `${p.firstName} ${p.lastName}`}
                          </div>
                          <div className="text-[10px] text-slate-500 font-sans truncate">
                            {p.firstName} {p.lastName}
                          </div>
                        </td>

                        {/* Position */}
                        <td className="py-3 px-3" style={{ width: "9%" }}>
                          <PositionBadge position={p.position} />
                        </td>

                        {/* Club */}
                        <td className="py-3 px-3 font-mono font-medium text-slate-300" style={{ width: "10%" }}>
                          {p.team?.shortName || `Team ${p.teamId}`}
                        </td>

                        {/* Price */}
                        <td className="py-3 px-3 text-right font-mono font-bold text-white" style={{ width: "9%" }}>
                          £{(p.price / 10).toFixed(1)}m
                        </td>

                        {/* Points */}
                        <td className="py-3 px-3 text-right font-mono font-black text-emerald-400 text-sm" style={{ width: "9%" }}>
                          {p.totalPoints}
                        </td>

                        {/* Form */}
                        <td className="py-3 px-3 text-center font-mono text-slate-300" style={{ width: "9%" }}>
                          {p.form ?? "—"}
                        </td>

                        {/* Goals */}
                        <td className="py-3 px-3 text-center font-mono text-slate-300" style={{ width: "8%" }}>
                          {p.goalsScored}
                        </td>

                        {/* Assists */}
                        <td className="py-3 px-3 text-center font-mono text-slate-300" style={{ width: "8%" }}>
                          {p.assists}
                        </td>

                        {/* Clean Sheets */}
                        <td className="py-3 px-3 text-center font-mono text-slate-300" style={{ width: "8%" }}>
                          {p.cleanSheets}
                        </td>

                        {/* Minutes */}
                        <td className="py-3 px-3 text-right font-mono text-slate-400" style={{ width: "8%" }}>
                          {p.minutesPlayed.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-20 text-center text-slate-500 text-xs">
            No footballers found matching the specified filters.
          </div>
        )}
      </div>
    </div>
  );
}
