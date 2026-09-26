"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { Squad, League, GameweekHistoryEntry } from "@/types";
import { Button } from "@/components/ui/Button";
import {
  IconUser,
  IconFootball,
  IconTrophy,
  IconShield,
  IconCheck,
  IconLogOut,
  IconGoogle,
} from "@/components/ui/Icons";

export default function ProfilePage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading, logout } = useAuth();

  const [squad, setSquad] = useState<Squad | null>(null);
  const [leaguesCount, setLeaguesCount] = useState<number>(0);
  const [gameweekHistory, setGameweekHistory] = useState<GameweekHistoryEntry[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState<boolean>(true);

  // Require auth
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace("/login?returnTo=/profile");
    }
  }, [isAuthenticated, authLoading, router]);

  // Load user fantasy stats
  useEffect(() => {
    async function loadStats() {
      if (!isAuthenticated) return;
      setIsLoadingStats(true);
      try {
        // Fetch user squad
        const squadRes = await api.get<{ success: boolean; data: Squad[] }>("/api/v1/squads/me");
        if (squadRes?.data && squadRes.data.length > 0) {
          setSquad(squadRes.data[0]);
        }

        // Fetch leagues
        const lgRes = await api.get<{ success: boolean; data: League[] }>("/api/v1/leagues");
        if (lgRes?.data) {
          setLeaguesCount(lgRes.data.length);
        }

        const historyRes = await api.get<{
          success: boolean;
          data: GameweekHistoryEntry[];
        }>("/api/v1/gameweeks/history/me");
        if (historyRes?.data) {
          setGameweekHistory(historyRes.data);
          setSelectedHistoryId((current) => current ?? historyRes.data[0]?.id ?? null);
        }
      } catch (err) {
        console.error("Failed to load profile stats:", err);
      } finally {
        setIsLoadingStats(false);
      }
    }

    if (isAuthenticated) {
      loadStats();
    }
  }, [isAuthenticated]);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  const selectedHistory = gameweekHistory.find((entry) => entry.id === selectedHistoryId);

  if (authLoading || (!isAuthenticated && !user)) {
    return (
      <div className="py-24 text-center text-slate-400">
        <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-xs">Loading manager telemetry...</p>
      </div>

    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      {/* Header Banner */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-black text-2xl font-mono shadow-md">
            {(user?.name || user?.username || "M").charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                Verified Manager
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            </div>
            <h1 className="text-2xl font-black text-white tracking-tight">
              {user?.name || user?.username}
            </h1>
            <p className="text-xs text-slate-400 font-mono">
              @{user?.username} &bull; {user?.email}
            </p>
          </div>
        </div>

        <div>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={handleLogout}
            className="uppercase font-bold tracking-wide text-xs gap-1.5"
          >
            <IconLogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </Button>
        </div>
      </div>

      {/* 3 Fantasy Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-pitch-surface border border-pitch-border rounded-xl p-4 shadow-sm">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            Total Fantasy Points
          </span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-2xl sm:text-3xl font-black text-white font-mono">
              {squad?.totalPoints ?? 0}
            </span>
            <span className="text-xs text-slate-500 font-mono">pts</span>
          </div>
        </div>

        <div className="bg-pitch-surface border border-pitch-border rounded-xl p-4 shadow-sm">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            Registered Squad
          </span>
          <div className="mt-1">
            <span className="text-base sm:text-lg font-bold text-emerald-400 truncate block">
              {squad?.name || "None"}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              {squad ? "15 Players Selected" : "Draft pending"}
            </span>
          </div>
        </div>

        <div className="bg-pitch-surface border border-pitch-border rounded-xl p-4 shadow-sm">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            Active Competitions
          </span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-2xl sm:text-3xl font-black text-amber-400 font-mono">
              {leaguesCount}
            </span>
            <span className="text-xs text-slate-500 font-mono">leagues</span>
          </div>
        </div>
      </div>

      {/* Gameweek History */}
      <section className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-md space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">Gameweek History</h2>
            <p className="text-xs text-slate-400 mt-1">Review past scores, ranks, and the squad selected for each gameweek.</p>
          </div>
          {gameweekHistory.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <span>Gameweek</span>
              <select
                value={selectedHistoryId ?? ""}
                onChange={(event) => setSelectedHistoryId(Number(event.target.value))}
                className="rounded-lg border border-pitch-border bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
              >
                {gameweekHistory.map((entry) => <option key={entry.id} value={entry.id}>{entry.gameweek.name}</option>)}
              </select>
            </label>
          )}
        </div>
        {isLoadingStats ? (
          <p className="text-sm text-slate-500">Loading gameweek history...</p>
        ) : !selectedHistory ? (
          <p className="rounded-lg border border-dashed border-pitch-border p-6 text-center text-sm text-slate-500">No completed gameweek scores yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <HistoryStat label="Score" value={`${selectedHistory.points} pts`} />
              <HistoryStat label="Bench" value={`${selectedHistory.benchPoints} pts`} />
              <HistoryStat label="Captain" value={`${selectedHistory.captainPoints} pts`} />
              <HistoryStat label="Transfer cost" value={`${selectedHistory.transferCost} pts`} />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Lineup for {selectedHistory.gameweek.name}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {selectedHistory.squad.players?.map((selection) => (
                  <div key={selection.id} className="flex items-center justify-between rounded-lg border border-pitch-border bg-slate-950/50 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-200">{selection.player?.displayName ?? "Unknown player"}</p>
                      <p className="text-[10px] uppercase tracking-wider text-slate-500">{selection.player?.position ?? "—"} · {selection.isStarter ? "Starter" : "Bench"}</p>
                    </div>
                    <div className="flex gap-1 text-[10px] font-bold text-emerald-400">
                      {selection.isCaptain && <span>C</span>}
                      {selection.isViceCaptain && <span>VC</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      {/* Account & Security Information */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-md space-y-4">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300 mb-2">
          <IconShield className="w-4 h-4 text-emerald-400" />
          <span>Security & Authentication Status</span>
        </div>

        <div className="divide-y divide-slate-800/60 text-xs">
          <div className="py-3 flex items-center justify-between">
            <span className="text-slate-400 font-medium">Manager ID</span>
            <span className="font-mono text-slate-200 text-[11px]">{user?.id}</span>
          </div>

          <div className="py-3 flex items-center justify-between">
            <span className="text-slate-400 font-medium">Account Registered</span>
            <span className="font-mono text-slate-200">
              {user?.createdAt
                ? new Date(user.createdAt).toLocaleDateString([], {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })
                : "Active"}
            </span>
          </div>

          <div className="py-3 flex items-center justify-between">
            <span className="text-slate-400 font-medium">Authentication Session</span>
            <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <IconCheck className="w-3.5 h-3.5" />
              <span>Active</span>
            </div>
          </div>

          <div className="py-3 flex items-center justify-between">
            <span className="text-slate-400 font-medium">Financial Escrow Protocol</span>
            <div className="flex items-center gap-1.5 text-slate-300 font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>Stellar Testnet &bull; Soroban Escrow</span>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Links */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-slate-950/60 border border-pitch-border">
        <div className="text-xs text-slate-400">
          Want to update your fantasy squad lineup?
        </div>
        <Link href="/team">
          <Button variant="primary" size="sm" className="uppercase font-bold tracking-wide text-xs">
            Open Pitch & Lineup &rarr;
          </Button>
        </Link>
      </div>
    </div>
  );
}

function HistoryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-pitch-border bg-slate-950/50 p-3">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-black text-white">{value}</p>
    </div>
  );
}
