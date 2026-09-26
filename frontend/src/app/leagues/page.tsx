"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { League, Squad, LeagueStatus, LeagueSearchMeta, LeagueSortField } from "@/types";
import { Badge, LeagueStatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  IconTrophy,
  IconPlus,
  IconShield,
  IconAlertCircle,
  IconSearch,
  IconChevronLeft,
  IconChevronRight,
} from "@/components/ui/Icons";

const PAGE_SIZE = 12;

interface LeagueFilters {
  minEntryFee: string;
  maxEntryFee: string;
  minSize: string;
  maxSize: string;
  status: LeagueStatus | "";
  hasOpenSlots: boolean;
  sortBy: LeagueSortField;
}

const DEFAULT_FILTERS: LeagueFilters = {
  minEntryFee: "",
  maxEntryFee: "",
  minSize: "",
  maxSize: "",
  status: "",
  hasOpenSlots: false,
  sortBy: "newest",
};

const SORT_OPTIONS: Array<{ value: LeagueSortField; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "entryFee", label: "Entry fee" },
  { value: "prizePool", label: "Prize pool" },
  { value: "size", label: "League size" },
  { value: "members", label: "Members joined" },
];

const STATUS_OPTIONS: Array<{ value: LeagueStatus | ""; label: string }> = [
  { value: "", label: "All Statuses" },
  { value: LeagueStatus.UPCOMING, label: "Open / Upcoming" },
  { value: LeagueStatus.ACTIVE, label: "In Progress" },
  { value: LeagueStatus.COMPLETED, label: "Completed" },
  { value: LeagueStatus.CANCELLED, label: "Cancelled" },
];

/**
 * Extracts an invitation token from a pasted invite link or raw token.
 * Returns null for short invite codes.
 */
function parseInvitationToken(input: string): string | null {
  const trimmed = input.trim();
  const fromLink = trimmed.match(/\/leagues\/invite\/([A-Za-z0-9_-]+)/);
  if (fromLink) return fromLink[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}

export default function LeaguesPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();

  const [leagues, setLeagues] = useState<League[]>([]);
  const [meta, setMeta] = useState<LeagueSearchMeta | null>(null);
  const [userSquads, setUserSquads] = useState<Squad[]>([]);
  const [activeTab, setActiveTab] = useState<"all" | "my">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = useState<LeagueFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Join with code / invite link state
  const [joinCode, setJoinCode] = useState("");
  const [selectedSquadId, setSelectedSquadId] = useState<string>("");
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [showJoinModal, setShowJoinModal] = useState(false);

  // Debounce the name search so typing doesn't fire a request per keystroke.
  // Every search, filter or tab change starts again from the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch leagues matching the current search and filters
  useEffect(() => {
    let cancelled = false;

    async function loadLeagues() {
      setIsLoading(true);
      setLoadError(null);

      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        sortBy: filters.sortBy,
        sortOrder: filters.sortBy === "entryFee" ? "asc" : "desc",
      });
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (filters.minEntryFee) params.set("minEntryFee", filters.minEntryFee);
      if (filters.maxEntryFee) params.set("maxEntryFee", filters.maxEntryFee);
      if (filters.minSize) params.set("minSize", filters.minSize);
      if (filters.maxSize) params.set("maxSize", filters.maxSize);
      if (filters.status) params.set("status", filters.status);
      if (filters.hasOpenSlots) params.set("hasOpenSlots", "true");
      if (activeTab === "my" && user?.id) params.set("creatorId", user.id);

      try {
        const res = await api.get<{ success: boolean; data: League[]; meta: LeagueSearchMeta }>(
          `/api/v1/leagues?${params.toString()}`
        );
        if (!cancelled) {
          setLeagues(res?.data ?? []);
          setMeta(res?.meta ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setLeagues([]);
          setMeta(null);
          setLoadError(err instanceof ApiError ? err.message : "Failed to load leagues.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadLeagues();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, filters, activeTab, page, user?.id]);

  // Fetch user squads if authenticated
  useEffect(() => {
    if (!isAuthenticated) return;
    api
      .get<{ success: boolean; data: Squad[] }>("/api/v1/squads/me")
      .then((squadRes) => {
        if (squadRes?.data) {
          setUserSquads(squadRes.data);
          if (squadRes.data.length > 0) {
            setSelectedSquadId(squadRes.data[0].id);
          }
        }
      })
      .catch((err) => console.error("Failed to load squads:", err));
  }, [isAuthenticated]);

  const updateFilter = <K extends keyof LeagueFilters>(key: K, value: LeagueFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };

  const switchTab = (tab: "all" | "my") => {
    setActiveTab(tab);
    setPage(1);
  };

  const activeFilterCount =
    [filters.minEntryFee, filters.maxEntryFee, filters.minSize, filters.maxSize, filters.status].filter(Boolean)
      .length + (filters.hasOpenSlots ? 1 : 0);

  // Handle joining with an invite link or a public league code
  const handleJoinWithCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setJoinError(null);

    if (!joinCode.trim()) {
      setJoinError("Please enter an invite code or paste an invitation link.");
      return;
    }

    // Private league invitation links are redeemed on their own page
    const token = parseInvitationToken(joinCode);
    if (token) {
      setShowJoinModal(false);
      router.push(`/leagues/invite/${encodeURIComponent(token)}`);
      return;
    }

    if (!isAuthenticated) {
      router.push(`/login?returnTo=/leagues`);
      return;
    }

    if (!selectedSquadId) {
      setJoinError("Please select a squad to enter this league.");
      return;
    }

    setIsJoining(true);

    try {
      const code = joinCode.trim().toUpperCase();
      const lookup = await api.get<{ success: boolean; data: League[] }>(
        `/api/v1/leagues?code=${encodeURIComponent(code)}&pageSize=1`
      );
      const target = lookup?.data?.[0];

      if (!target) {
        setJoinError("Invalid invite code. Private leagues require an invitation link.");
        return;
      }

      await api.post(`/api/v1/leagues/${target.id}/join`, {
        squadId: selectedSquadId,
      });

      setShowJoinModal(false);
      router.push(`/leagues/${target.id}`);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setJoinError(err.message || "Failed to join league.");
      } else {
        setJoinError("An unexpected error occurred while joining.");
      }
    } finally {
      setIsJoining(false);
    }
  };

  const inputClass =
    "w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500";
  const labelClass = "block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1";

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-pitch-surface border border-pitch-border p-6 rounded-xl shadow-lg">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Fantasy Competitions
            </span>
            <span className="text-xs text-slate-500 font-mono">&bull; On-Chain Escrow</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-white uppercase tracking-tight">
            Leagues Hub
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Compete in classic fantasy leagues. Prize pools are secured in Stellar Soroban escrow.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="md"
            onClick={() => setShowJoinModal(true)}
            className="uppercase font-bold tracking-wide text-xs"
          >
            <span>Join with Code</span>
          </Button>

          <Link href="/leagues/create">
            <Button
              variant="primary"
              size="md"
              className="uppercase font-bold tracking-wide text-xs"
            >
              <IconPlus className="w-4 h-4" />
              <span>Create League</span>
            </Button>
          </Link>
        </div>
      </div>

      {/* Tabs & Search Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-pitch-border pb-1">
          <button
            type="button"
            onClick={() => switchTab("all")}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
              activeTab === "all"
                ? "border-emerald-500 text-emerald-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Explore Public Leagues{activeTab === "all" && meta ? ` (${meta.total})` : ""}
          </button>

          {isAuthenticated && (
            <button
              type="button"
              onClick={() => switchTab("my")}
              className={`px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                activeTab === "my"
                  ? "border-emerald-500 text-emerald-400"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              My Leagues
            </button>
          )}
        </div>

        {/* Search & Quick Status Filter */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <IconSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              maxLength={60}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leagues by name..."
              aria-label="Search leagues by name"
              className="w-full pl-9 pr-3 py-1.5 bg-pitch-surface border border-pitch-border rounded-lg text-slate-200 placeholder-slate-500 text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          <select
            value={filters.status}
            onChange={(e) => updateFilter("status", e.target.value as LeagueStatus | "")}
            aria-label="Filter leagues by status"
            className="px-2.5 py-1.5 bg-pitch-surface border border-pitch-border rounded-lg text-slate-200 text-xs focus:outline-none focus:border-emerald-500"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            className="text-xs uppercase font-bold whitespace-nowrap"
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </Button>
        </div>
      </div>

      {/* Advanced filters */}
      {showFilters && (
        <div className="bg-pitch-surface border border-pitch-border rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 items-end">
          <div>
            <label className={labelClass}>Min fee (USDC)</label>
            <input
              type="number"
              min={0}
              value={filters.minEntryFee}
              onChange={(e) => updateFilter("minEntryFee", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Max fee (USDC)</label>
            <input
              type="number"
              min={0}
              value={filters.maxEntryFee}
              onChange={(e) => updateFilter("maxEntryFee", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Min size</label>
            <input
              type="number"
              min={2}
              max={100}
              value={filters.minSize}
              onChange={(e) => updateFilter("minSize", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Max size</label>
            <input
              type="number"
              min={2}
              max={100}
              value={filters.maxSize}
              onChange={(e) => updateFilter("maxSize", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Status</label>
            <select
              value={filters.status}
              onChange={(e) => updateFilter("status", e.target.value as LeagueStatus | "")}
              className={inputClass}
              aria-label="Filter leagues by status"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Sort by</label>
            <select
              value={filters.sortBy}
              onChange={(e) => updateFilter("sortBy", e.target.value as LeagueSortField)}
              className={inputClass}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.hasOpenSlots}
                onChange={(e) => updateFilter("hasOpenSlots", e.target.checked)}
                className="accent-emerald-500"
              />
              Open spots only
            </label>
            <button
              type="button"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                setPage(1);
              }}
              className="text-[11px] text-left font-semibold text-slate-400 hover:text-emerald-400"
            >
              Reset filters
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
          <IconAlertCircle className="w-4 h-4 flex-shrink-0 text-rose-400" />
          <span>{loadError}</span>
        </div>
      )}

      {/* Leagues Grid */}
      {isLoading ? (
        <div className="py-24 text-center text-slate-400">
          <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-xs">Loading fantasy leagues...</p>
        </div>
      ) : leagues.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {leagues.map((lg) => (
            <div
              key={lg.id}
              className="bg-pitch-surface border border-pitch-border rounded-xl p-5 shadow-md flex flex-col justify-between hover:border-slate-700 transition-colors group"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="flex-1">
                    <h3 className="font-bold text-base text-white group-hover:text-emerald-400 transition-colors">
                      {lg.name}
                    </h3>
                    <p className="text-[11px] text-slate-400 line-clamp-2 mt-1">
                      {lg.description || "Official FantasyXI competition."}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <LeagueStatusBadge status={lg.status} />
                    {lg.isPrivate && (
                      <Badge variant="neutral" className="gap-1">
                        <IconShield className="w-3 h-3" />
                        <span>Private</span>
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 mb-4 font-mono text-xs">
                  <div>
                    <span className="text-[10px] text-slate-500 uppercase font-sans">Entry Fee</span>
                    <div className="font-bold text-slate-200 mt-0.5">
                      {Number(lg.entryFee) > 0 ? `${lg.entryFee} USDC` : "Free"}
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase font-sans">Prize Pool</span>
                    <div className="font-bold text-amber-400 mt-0.5">
                      ${lg.prizePool || 0} USDC
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase font-sans">Members</span>
                    <div className="font-bold text-slate-200 mt-0.5">
                      {lg.currentMembers} / {lg.maxMembers}
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase font-sans">Duration</span>
                    <div className="font-bold text-slate-200 mt-0.5">
                      GW {lg.startGameweekId} &rarr; {lg.endGameweekId}
                    </div>
                  </div>
                </div>
              </div>

              {/* Action */}
              <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between">
                <span className="text-[10px] text-slate-500 uppercase font-mono">
                  {lg.inviteCode ? `Code: ${lg.inviteCode}` : "Invite only"}
                </span>

                <Link href={`/leagues/${lg.id}`}>
                  <Button variant="primary" size="sm" className="text-xs uppercase font-bold">
                    View League &rarr;
                  </Button>
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconTrophy className="w-6 h-6 text-amber-400" />}
          title="No Leagues Found"
          description={
            debouncedSearch || filters.status
              ? `No leagues match your search query or status filter criteria.`
              : activeTab === "my"
              ? "You haven't created any leagues yet. Explore public leagues or create your own!"
              : "No public leagues match your search and filters. Create the first league now!"
          }
          action={
            <Link href="/leagues/create">
              <Button variant="primary" size="md" className="uppercase font-bold tracking-wide text-xs">
                Create New League
              </Button>
            </Link>
          }
          className="py-16 bg-pitch-surface border-pitch-border"
        />
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-xs text-slate-400">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={page <= 1 || isLoading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Previous page"
          >
            <IconChevronLeft className="w-3.5 h-3.5" />
          </Button>
          <span className="font-mono">
            Page {meta.page} of {meta.totalPages}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={page >= meta.totalPages || isLoading}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
          >
            <IconChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {/* Join League Modal */}
      {showJoinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
          <div className="relative w-full max-w-md bg-pitch-surface border border-pitch-border rounded-2xl p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white uppercase tracking-tight">
              Join a League
            </h3>
            <p className="text-xs text-slate-400">
              Paste the invitation link for a private league, or enter the invite code of a public league.
            </p>

            {joinError && (
              <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                <IconAlertCircle className="w-4 h-4 flex-shrink-0 text-rose-400" />
                <span>{joinError}</span>
              </div>
            )}

            <form onSubmit={handleJoinWithCode} className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Invite Code or Link <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  maxLength={300}
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="e.g. A1B2C3 or https://.../leagues/invite/..."
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-white font-mono text-center text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              {userSquads.length > 0 ? (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">
                    Select Squad to Enter
                  </label>
                  <select
                    value={selectedSquadId}
                    onChange={(e) => setSelectedSquadId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
                  >
                    {userSquads.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} (Pts: {s.totalPoints})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="p-3 rounded bg-amber-950/40 border border-amber-500/30 text-amber-300 text-xs">
                  You need a registered squad before joining leagues.{" "}
                  <Link href="/team" className="underline font-bold">
                    Draft squad now
                  </Link>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => setShowJoinModal(false)}
                  className="w-1/2 justify-center"
                >
                  Cancel
                </Button>

                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={isJoining}
                  isLoading={isJoining}
                  className="w-1/2 justify-center uppercase font-bold tracking-wide text-xs"
                >
                  Join League
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
