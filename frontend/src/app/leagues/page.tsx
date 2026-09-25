"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { League, Squad, LeagueStatus } from "@/types";
import { Badge, LeagueStatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  IconTrophy,
  IconPlus,
  IconUsers,
  IconShield,
  IconCalendar,
  IconCheck,
  IconAlertCircle,
  IconSearch,
} from "@/components/ui/Icons";

export default function LeaguesPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();

  const [leagues, setLeagues] = useState<League[]>([]);
  const [userSquads, setUserSquads] = useState<Squad[]>([]);
  const [activeTab, setActiveTab] = useState<"all" | "my">("all");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Join private league state
  const [joinCode, setJoinCode] = useState("");
  const [selectedSquadId, setSelectedSquadId] = useState<string>("");
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [showJoinModal, setShowJoinModal] = useState(false);

  // Fetch leagues and user squads
  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      try {
        // Fetch all leagues
        const res = await api.get<{ success: boolean; data: League[] }>("/api/v1/leagues");
        if (res?.data) {
          setLeagues(res.data);
        }

        // Fetch user squads if authenticated
        if (isAuthenticated) {
          const squadRes = await api.get<{ success: boolean; data: Squad[] }>("/api/v1/squads/me");
          if (squadRes?.data) {
            setUserSquads(squadRes.data);
            if (squadRes.data.length > 0) {
              setSelectedSquadId(squadRes.data[0].id);
            }
          }
        }
      } catch (err) {
        console.error("Failed to load leagues:", err);
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, [isAuthenticated]);

  // Handle joining with code
  const handleJoinWithCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setJoinError(null);

    if (!isAuthenticated) {
      router.push(`/login?returnTo=/leagues`);
      return;
    }

    if (!joinCode.trim()) {
      setJoinError("Please enter an invite code.");
      return;
    }

    if (!selectedSquadId) {
      setJoinError("Please select a squad to enter this league.");
      return;
    }

    setIsJoining(true);

    try {
      // Find league with this invite code
      const target = leagues.find(
        (l) => l.inviteCode.toUpperCase() === joinCode.trim().toUpperCase()
      );

      if (!target) {
        setJoinError("Invalid or expired invite code.");
        setIsJoining(false);
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

  // Filter leagues with search term and status filter in O(N) time & O(1) extra space
  const filteredLeagues = leagues.filter((lg) => {
    if (search.trim() && !lg.name.toLowerCase().includes(search.trim().toLowerCase())) {
      return false;
    }
    if (statusFilter !== "ALL" && lg.status !== statusFilter) {
      return false;
    }
    if (activeTab === "my") {
      return lg.creatorId === user?.id;
    }
    return true;
  });

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
            onClick={() => setActiveTab("all")}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
              activeTab === "all"
                ? "border-emerald-500 text-emerald-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Explore Public Leagues ({leagues.length})
          </button>

          {isAuthenticated && (
            <button
              type="button"
              onClick={() => setActiveTab("my")}
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

        {/* Search & Status Filter */}
        <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          {/* Status Dropdown */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full sm:w-44 px-3 py-1.5 bg-pitch-surface border border-pitch-border rounded-lg text-slate-200 text-xs focus:outline-none focus:border-emerald-500"
          >
            <option value="ALL">All Statuses</option>
            <option value="UPCOMING">Open / Upcoming</option>
            <option value="ACTIVE">In Progress / Active</option>
            <option value="COMPLETED">Completed</option>
          </select>

          {/* Search Bar */}
          <div className="relative w-full sm:w-64">
            <IconSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leagues by name..."
              className="w-full pl-9 pr-3 py-1.5 bg-pitch-surface border border-pitch-border rounded-lg text-slate-200 placeholder-slate-500 text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* Leagues Grid */}
      {isLoading ? (
        <div className="py-24 text-center text-slate-400">
          <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-xs">Loading fantasy leagues...</p>
        </div>
      ) : filteredLeagues.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredLeagues.map((lg) => (
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
                  <LeagueStatusBadge status={lg.status} />
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 mb-4 font-mono text-xs">
                  <div>
                    <span className="text-[10px] text-slate-500 uppercase font-sans">Entry Fee</span>
                    <div className="font-bold text-slate-200 mt-0.5">
                      {lg.entryFee > 0 ? `${lg.entryFee} USDC` : "Free"}
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
                  Code: {lg.inviteCode}
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
        <div className="py-20 text-center bg-pitch-surface border border-dashed border-pitch-border rounded-xl p-8">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto mb-3">
            <IconTrophy className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">No Leagues Found</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto mb-5">
            {activeTab === "my"
              ? "You haven't entered or created any leagues yet. Explore public leagues or create your own!"
              : "No public leagues match your search. Create the first league now!"}
          </p>
          <Link href="/leagues/create">
            <Button variant="primary" size="md" className="uppercase font-bold tracking-wide text-xs">
              Create New League
            </Button>
          </Link>
        </div>
      )}

      {/* Join League Modal */}
      {showJoinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
          <div className="relative w-full max-w-md bg-pitch-surface border border-pitch-border rounded-2xl p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white uppercase tracking-tight">
              Join Private League
            </h3>
            <p className="text-xs text-slate-400">
              Enter the 6-character invite code provided by the league creator.
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
                  Invite Code <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  maxLength={10}
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="e.g. A1B2C3"
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-white font-mono text-center text-base tracking-widest uppercase focus:outline-none focus:border-emerald-500"
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
                  disabled={isJoining || userSquads.length === 0}
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
