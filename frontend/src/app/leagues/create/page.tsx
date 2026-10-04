"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { Gameweek, League, ScoringType } from "@/types";
import { PrizeCalculator } from "@/components/leagues/PrizeCalculator";
import { Button } from "@/components/ui/Button";
import {
  IconTrophy,
  IconShield,
  IconAlertCircle,
  IconCheck,
  IconChevronLeft,
} from "@/components/ui/Icons";

export default function CreateLeaguePage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [gameweeks, setGameweeks] = useState<Gameweek[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [entryFee, setEntryFee] = useState<number>(10);
  const [maxMembers, setMaxMembers] = useState<number>(10);
  const [startGameweekId, setStartGameweekId] = useState<number>(1);
  const [endGameweekId, setEndGameweekId] = useState<number>(5);
  const [isPrivate, setIsPrivate] = useState(false);

  const [isLoadingGw, setIsLoadingGw] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Require auth
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace("/login?returnTo=/leagues/create");
    }
  }, [isAuthenticated, authLoading, router]);

  // Load gameweeks
  useEffect(() => {
    async function loadGameweeks() {
      try {
        const res = await api.get<{ success: boolean; data: Gameweek[] }>("/api/v1/gameweeks");
        if (res?.data && res.data.length > 0) {
          setGameweeks(res.data);
          const current = res.data.find((g) => g.isCurrent) || res.data[0];
          setStartGameweekId(current.id);
          // Default end to 4 gameweeks later or max available
          const endIdx = Math.min(res.data.length - 1, res.data.indexOf(current) + 4);
          setEndGameweekId(res.data[endIdx].id);
        }
      } catch (err) {
        console.error("Failed to load gameweeks:", err);
      } finally {
        setIsLoadingGw(false);
      }
    }

    loadGameweeks();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!name.trim()) {
      setErrorMessage("Please give your fantasy league a name.");
      return;
    }

    if (maxMembers < 2 || maxMembers > 100) {
      setErrorMessage("Participant capacity must be between 2 and 100 managers.");
      return;
    }

    if (startGameweekId > endGameweekId) {
      setErrorMessage("Start Gameweek cannot be after End Gameweek.");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await api.post<{ success: boolean; data: League }>("/api/v1/leagues", {
        name: name.trim(),
        description: description.trim() || undefined,
        entryFee: Number(entryFee),
        maxMembers: Number(maxMembers),
        startGameweekId: Number(startGameweekId),
        endGameweekId: Number(endGameweekId),
        scoringType: ScoringType.CLASSIC,
        isPrivate,
      });

      if (res?.data?.id) {
        router.push(`/leagues/${res.data.id}`);
      } else {
        router.push("/leagues");
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message || "Failed to create league.");
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage("An unexpected error occurred while creating the league.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Top back link */}
      <div>
        <Link
          href="/leagues"
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-400 font-semibold transition-colors"
        >
          <IconChevronLeft className="w-4 h-4" />
          <span>Back to Leagues Hub</span>
        </Link>
      </div>

      {/* Header */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-lg">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
            Competition Builder
          </span>
          <span className="text-xs text-slate-500 font-mono">&bull; Soroban Escrow Enabled</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-black text-white uppercase tracking-tight">
          Create Fantasy League
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Set your entry fee, choose the Premier League gameweek duration, and invite fellow managers.
        </p>
      </div>

      {errorMessage && (
        <div className="p-3.5 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2.5 animate-shake">
          <IconAlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <span className="font-medium">{errorMessage}</span>
        </div>
      )}

      {/* 2-Column Form & Live Prize Calculator */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        {/* Left Form: 3 cols */}
        <form onSubmit={handleSubmit} className="lg:col-span-3 space-y-5 bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-md">
          {/* League Name */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
              League Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Premier League Legends"
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
              Description <span className="text-slate-500 font-normal lowercase">(optional)</span>
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your competition rules or banter..."
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700/80 rounded-lg text-white placeholder-slate-500 text-xs focus:outline-none focus:border-emerald-500 resize-none"
            />
          </div>

          {/* Entry Fee in USDC */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                Entry Fee (USDC)
              </label>
              <span className="text-[11px] text-slate-500">Set 0 for free league</span>
            </div>
            <div className="grid grid-cols-4 gap-2 mb-2">
              {[0, 5, 10, 25].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setEntryFee(amt)}
                  className={`py-1.5 rounded-lg text-xs font-mono font-bold uppercase transition-colors ${
                    entryFee === amt
                      ? "bg-emerald-500 text-slate-950"
                      : "bg-slate-900 text-slate-300 border border-slate-800 hover:border-slate-700"
                  }`}
                >
                  {amt === 0 ? "Free" : `${amt} USDC`}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={entryFee}
              onChange={(e) => setEntryFee(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-full px-3.5 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-emerald-500"
            />
          </div>

          {/* Max Participants */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
              Max Participant Capacity
            </label>
            <input
              type="number"
              min={2}
              max={100}
              value={maxMembers}
              onChange={(e) => setMaxMembers(Math.max(2, parseInt(e.target.value, 10) || 2))}
              className="w-full px-3.5 py-2 bg-slate-950 border border-slate-700/80 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-emerald-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">Min 2, maximum 100 participants.</p>
          </div>

          {/* Duration Gameweeks */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                Start Gameweek
              </label>
              <select
                value={startGameweekId}
                onChange={(e) => setStartGameweekId(parseInt(e.target.value, 10))}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
              >
                {gameweeks.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} {g.isCurrent ? "(Current)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5">
                End Gameweek
              </label>
              <select
                value={endGameweekId}
                onChange={(e) => setEndGameweekId(parseInt(e.target.value, 10))}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
              >
                {gameweeks.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Visibility */}
          <label className="flex items-start gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800 cursor-pointer">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="mt-0.5 accent-emerald-500"
            />
            <span>
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                Private League
              </span>
              <span className="block text-[11px] text-slate-500 mt-0.5">
                Hidden from public search. Managers can only join with a single-use invitation link you generate.
              </span>
            </span>
          </label>

          <div className="pt-3">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={isSubmitting}
              className="w-full justify-center uppercase font-bold tracking-wide text-xs"
            >
              Deploy League & Escrow
            </Button>
          </div>
        </form>

        {/* Right: Live Prize Calculator: 2 cols */}
        <div className="lg:col-span-2 space-y-4">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Live Prize Simulation
          </div>
          <PrizeCalculator entryFee={entryFee} participants={maxMembers} />

          <div className="p-4 rounded-xl bg-slate-950/60 border border-pitch-border space-y-2 text-xs text-slate-400">
            <div className="font-bold text-slate-200 flex items-center gap-1.5">
              <IconCheck className="w-4 h-4 text-emerald-400" />
              <span>Soroban Automated Payouts</span>
            </div>
            <p className="leading-relaxed">
              When the final gameweek concludes, scores are locked and prizes are automatically settled to the top 3 managers on Stellar Testnet.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
