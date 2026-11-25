"use client";

import React, { useState, useEffect, useRef } from "react";
import { Player, Position, Team, SQUAD_RULES } from "@/types";
import { api } from "@/lib/api";
import { PositionBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconSearch, IconClose, IconCheck, IconAlertCircle } from "@/components/ui/Icons";
import { useVirtualList } from "@/hooks/useVirtualList";

/**
 * Slider ceiling in £m, matching the top end of real FPL player prices.
 * This is the same unit the `/api/v1/players?maxPrice=` filter compares
 * against server-side, so no conversion is needed when building the query.
 */
const MAX_PRICE_CEILING_M = 15;

export interface PlayerPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  requiredPosition?: Position | null;
  currentSquadPlayerIds: number[];
  clubCounts: Record<number | string, number>;
  remainingBudget: number; // in tenths (e.g. 150 = £15.0m)
  replacingPlayer?: Player | null;
  onSelectPlayer: (player: Player) => void;
}

export const PlayerPickerModal: React.FC<PlayerPickerModalProps> = ({
  isOpen,
  onClose,
  requiredPosition = null,
  currentSquadPlayerIds,
  clubCounts,
  remainingBudget,
  replacingPlayer = null,
  onSelectPlayer,
}) => {
  const [players, setPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState("");
  const [selectedPosition, setSelectedPosition] = useState<string>(requiredPosition || "ALL");
  const [selectedTeamId, setSelectedTeamId] = useState<string>("ALL");
  const [maxPriceM, setMaxPriceM] = useState<number>(MAX_PRICE_CEILING_M);
  const [sortBy, setSortBy] = useState<string>("totalPoints");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Ref on the scrollable list container for the virtualiser
  const listRef = useRef<HTMLDivElement>(null);

  // Virtualise: 64 px per row, 8-row overscan
  const { virtualItems, totalHeight } = useVirtualList(players, 64, listRef, 8);

  // Sync selectedPosition when requiredPosition changes
  useEffect(() => {
    if (requiredPosition) {
      setSelectedPosition(requiredPosition);
    } else {
      setSelectedPosition("ALL");
    }
  }, [requiredPosition, isOpen]);

  // Fetch clubs once for the club filter dropdown
  useEffect(() => {
    async function loadTeams() {
      try {
        const res = await api.get<{ success: boolean; data: Team[] }>("/api/v1/teams");
        if (res?.data) setTeams(res.data);
      } catch (err) {
        console.error("Failed to load clubs for picker:", err);
      }
    }
    loadTeams();
  }, []);

  // Fetch players with debounced search — all filters (search, position, club,
  // max price) combine into one request so e.g. DEF + Arsenal + Max £6.0m
  // apply together.
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("search", search.trim());
        if (selectedPosition !== "ALL") params.set("position", selectedPosition);
        if (selectedTeamId !== "ALL") params.set("teamId", selectedTeamId);
        if (maxPriceM < MAX_PRICE_CEILING_M) params.set("maxPrice", String(maxPriceM));
        params.set("sortBy", sortBy);
        params.set("sortOrder", "desc");
        params.set("limit", "40");

        const res = await api.get<{
          success: boolean;
          data: { players: Player[] } | Player[];
        }>(`/api/v1/players?${params.toString()}`);

        if (res?.data) {
          const fetched = Array.isArray(res.data) ? res.data : (res.data as any).players || [];
          setPlayers(fetched);
        }
      } catch (err) {
        console.error("Failed to load players for picker:", err);
      } finally {
        setIsLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [isOpen, search, selectedPosition, selectedTeamId, maxPriceM, sortBy]);

  if (!isOpen) return null;

  // Effective budget considering replacing player's price
  const effectiveBudget = remainingBudget + (replacingPlayer ? replacingPlayer.price : 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-2xl bg-white border border-slate-200/90 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
          <div>
            <h2 className="text-lg font-black text-slate-900 uppercase tracking-tight">
              {replacingPlayer
                ? `Transfer: Replace ${replacingPlayer.displayName}`
                : "Player Scouting Database"}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 font-medium">
              Available budget:{" "}
              <span className="font-mono font-bold text-emerald-700">
                £{(effectiveBudget / 10).toFixed(1)}m
              </span>
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        {/* Filter Toolbar */}
        <div className="p-4 sm:p-5 border-b border-slate-100 bg-white space-y-3">
          {/* Search Input */}
          <div className="relative">
            <IconSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search player name or club..."
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-xs focus:outline-none focus:border-[#37003c] focus:ring-1 focus:ring-[#37003c]"
            />
          </div>

          {/* Position & Sort Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Position Tabs */}
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200/80">
              {(requiredPosition ? [requiredPosition] : ["ALL", "GKP", "DEF", "MID", "FWD"]).map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => setSelectedPosition(pos)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold uppercase transition-colors ${
                    selectedPosition === pos
                      ? "bg-[#37003c] text-white shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>

            {/* Sort Select */}
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-bold uppercase tracking-wider text-[10px]">Sort by:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1 text-slate-800 text-xs focus:outline-none focus:border-[#37003c]"
              >
                <option value="totalPoints">Total Points</option>
                <option value="price">Price (High to Low)</option>
                <option value="goalsScored">Goals Scored</option>
                <option value="assists">Assists</option>
                <option value="form">Recent Form</option>
              </select>
            </div>
          </div>

          {/* Club & Max Price Filter Bar */}
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            {/* Club Dropdown */}
            <div className="flex items-center gap-2 text-xs text-slate-500 min-w-0">
              <span className="font-bold uppercase tracking-wider text-[10px] shrink-0">Club:</span>
              <select
                value={selectedTeamId}
                onChange={(e) => setSelectedTeamId(e.target.value)}
                className="min-w-0 flex-1 sm:flex-none bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1 text-slate-800 text-xs focus:outline-none focus:border-[#37003c]"
              >
                <option value="ALL">All Clubs</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Max Price Slider */}
            <div className="flex items-center gap-2 text-xs text-slate-500 min-w-0 flex-1 sm:flex-none">
              <span className="font-bold uppercase tracking-wider text-[10px] shrink-0">
                Max Price:
              </span>
              <input
                type="range"
                min={4}
                max={MAX_PRICE_CEILING_M}
                step={0.5}
                value={maxPriceM}
                onChange={(e) => setMaxPriceM(Number(e.target.value))}
                aria-label="Maximum player price"
                className="flex-1 min-w-[100px] accent-[#37003c] cursor-pointer"
              />
              <span className="font-mono font-bold text-slate-800 shrink-0 w-14 text-right">
                {maxPriceM >= MAX_PRICE_CEILING_M ? "No limit" : `£${maxPriceM.toFixed(1)}m`}
              </span>
            </div>
          </div>
        </div>

        {/* Players List — virtualised */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto p-2"
          style={{ position: "relative" }}
        >
          {isLoading ? (
            <div className="py-16 text-center text-slate-400">
              <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-2" />
              <p className="text-xs">Scouting available footballers...</p>
            </div>
          ) : players.length > 0 ? (
            /* Full logical-height spacer so the scrollbar reflects the true list size */
            <div style={{ position: "relative", height: totalHeight, willChange: "transform" }}>
              {virtualItems.map(({ index, item: p, offsetTop }) => {
                const isAlreadyInSquad = currentSquadPlayerIds.includes(p.id);
                const isReplacingSame = replacingPlayer?.id === p.id;
                const isOverBudget = p.price > effectiveBudget;

                const currentClubCount = clubCounts[p.teamId] || 0;
                const isSameClubAsReplacement = replacingPlayer?.teamId === p.teamId;
                const exceedsClubLimit =
                  !isSameClubAsReplacement && currentClubCount >= SQUAD_RULES.MAX_PER_TEAM;

                const isDisabled =
                  (isAlreadyInSquad && !isReplacingSame) || isOverBudget || exceedsClubLimit;

                return (
                  <div
                    key={p.id}
                    style={{
                      position: "absolute",
                      top: offsetTop,
                      width: "100%",
                      height: 64,
                    }}
                    className={`flex items-center justify-between px-3 rounded-xl transition-colors ${
                      isDisabled ? "opacity-40 bg-slate-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <PositionBadge position={p.position} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-slate-900 truncate">
                            {p.displayName || `${p.firstName} ${p.lastName}`}
                          </span>
                          <span className="text-xs font-mono uppercase text-slate-500 shrink-0 font-medium">
                            {p.team?.shortName || "PL"}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 text-[11px] text-slate-500 mt-0.5 font-mono">
                          <span>Form: {p.form ?? "—"}</span>
                          <span>Goals: {p.goalsScored}</span>
                          <span>Assists: {p.assists}</span>
                          {isAlreadyInSquad && !isReplacingSame && (
                            <span className="text-amber-600 font-semibold">Already in Squad</span>
                          )}
                          {isOverBudget && (
                            <span className="text-rose-600 font-semibold">Over Budget</span>
                          )}
                          {exceedsClubLimit && (
                            <span className="text-amber-600 font-semibold">Max 3 per Club</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <div className="font-mono font-bold text-slate-900 text-sm">
                          £{(p.price / 10).toFixed(1)}m
                        </div>
                        <div className="font-mono text-emerald-700 font-bold text-xs">
                          {p.totalPoints} pts
                        </div>
                      </div>

                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={isDisabled}
                        onClick={() => {
                          onSelectPlayer(p);
                          onClose();
                        }}
                        className="text-xs uppercase font-bold px-3 py-1.5"
                      >
                        {isReplacingSame ? "Selected" : "Pick"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-16 text-center text-slate-500 text-xs">
              No players found matching current filters.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between text-xs text-slate-500">
          <span>Max 3 players per club &bull; Premier League official FPL data</span>
          <Button variant="secondary" size="sm" onClick={onClose} className="text-xs font-semibold">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};
