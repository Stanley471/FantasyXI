"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { Squad, Gameweek, Fixture, League } from "@/types";
import {
  IconFootball,
  IconTrophy,
  IconUsers,
  IconCalendar,
  IconChevronRight,
  IconCheck,
  IconPlus,
  IconShield,
  IconWallet,
  IconStar,
  IconAward,
  IconTrendingUp,
  IconCrown,
} from "@/components/ui/Icons";
import { Badge } from "@/components/ui/Badge";
import { FantasyXILogo } from "@/components/ui/FantasyXILogo";

export default function HomePage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [gameweek, setGameweek] = useState<Gameweek | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [squad, setSquad] = useState<Squad | null>(null);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [isLoadingData, setIsLoadingData] = useState<boolean>(true);

  // Fetch initial public & authenticated data
  useEffect(() => {
    async function loadDashboardData() {
      setIsLoadingData(true);
      try {
        // 1. Fetch current gameweek
        const gwRes = await api
          .get<{ success: boolean; data: Gameweek }>("/api/v1/gameweeks/current")
          .catch(() => null);

        const currentGw = gwRes?.data || null;
        if (currentGw) {
          setGameweek(currentGw);

          // 2. Fetch fixtures for current gameweek
          const fixRes = await api
            .get<{ success: boolean; data: Fixture[] }>(
              `/api/v1/fixtures?gameweekId=${currentGw.id}`
            )
            .catch(() => null);
          if (fixRes?.data) {
            setFixtures(fixRes.data.slice(0, 4)); // First 4 fixtures
          }
        }

        // 3. Fetch public leagues
        const leaguesRes = await api
          .get<{ success: boolean; data: League[] }>("/api/v1/leagues")
          .catch(() => null);
        if (leaguesRes?.data) {
          setLeagues(leaguesRes.data.slice(0, 3));
        }

        // 4. Fetch user's squad if logged in
        if (isAuthenticated) {
          const squadRes = await api
            .get<{ success: boolean; data: Squad[] }>("/api/v1/squads/me")
            .catch(() => null);
          if (squadRes?.data && squadRes.data.length > 0) {
            setSquad(squadRes.data[0]);
          }
        }
      } catch (err) {
        console.error("Failed to load dashboard data:", err);
      } finally {
        setIsLoadingData(false);
      }
    }

    if (!authLoading) {
      loadDashboardData();
    }
  }, [isAuthenticated, authLoading]);

  return (
    <div className="space-y-6">
      {/* Top Hero Section & Wallet Banner */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Hero Card */}
        <div className="lg:col-span-2 relative rounded-3xl bg-gradient-to-r from-[#20033c] via-[#37003c] to-[#044c35] p-6 sm:p-8 text-white overflow-hidden shadow-xl flex flex-col justify-between min-h-[260px]">
          {/* Subtle tactical pitch line watermark */}
          <div className="absolute right-0 top-0 bottom-0 w-1/2 opacity-15 pointer-events-none bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-emerald-400 via-transparent to-transparent" />

          {/* Hero Content */}
          <div className="relative z-10 max-w-xl">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-[#00ff87]">
                Official Web3 Fantasy
              </span>
              <span className="text-xs text-slate-300 font-medium">&bull; Gameweek {gameweek?.fplId ?? 12}</span>
            </div>

            <h1 className="text-2xl sm:text-4xl font-black tracking-tight leading-tight text-white mb-3">
              Your Ultimate Fantasy <br />
              Football Experience
            </h1>

            <p className="text-xs sm:text-sm text-slate-200/90 leading-relaxed max-w-md mb-6">
              Build your team, join high-roller leagues, and win transparent prizes with non-custodial smart escrow.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/team"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-[#00ff87] text-[#24002e] hover:bg-[#00e575] hover:shadow-lg hover:shadow-[#00ff87]/25 transition-all"
              >
                <span>Get Started</span>
                <IconChevronRight className="w-4 h-4" />
              </Link>
              <Link
                href="/leagues"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-white/10 hover:bg-white/20 text-white backdrop-blur-sm transition-all border border-white/15"
              >
                Explore Leagues
              </Link>
            </div>
          </div>
        </div>

        {/* Right Wallet & Payment Quick Card */}
        <div className="rounded-3xl bg-white border border-slate-200/80 p-6 flex flex-col justify-between shadow-xs">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-purple-50 text-[#37003c] flex items-center justify-center">
                  <IconWallet className="w-4 h-4 text-[#37003c]" />
                </div>
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  Your Wallet
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-emerald-700 text-xs font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                <span>Connected</span>
              </div>
            </div>

            <div className="mb-4">
              <div className="text-3xl font-black text-slate-900 tracking-tight">
                $0.00
              </div>
              <div className="text-xs font-medium text-slate-400 mt-0.5">
                ≈ 0.00 USDC &bull; Escrow Verified
              </div>
            </div>

            {/* Payment Options (Stellar SAC Tokens) */}
            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-100">
              <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 transition-colors border border-slate-200/60">
                <div className="w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-black text-xs">
                  S
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-800">Stellar USDC</div>
                  <div className="text-[10px] text-slate-400 font-medium">Soroban SAC</div>
                </div>
              </div>

              <div className="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 transition-colors border border-slate-200/60">
                <div className="w-7 h-7 rounded-lg bg-purple-600 text-white flex items-center justify-center font-black text-xs">
                  X
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-800">Native XLM</div>
                  <div className="text-[10px] text-slate-400 font-medium">Gas & Escrow</div>
                </div>
              </div>
            </div>
          </div>

          <Link
            href="/profile"
            className="mt-4 w-full text-center py-2 px-3 rounded-xl text-xs font-bold text-[#37003c] bg-purple-50 hover:bg-purple-100 transition-colors border border-purple-200/60"
          >
            Manage Wallet &rarr;
          </Link>
        </div>
      </div>

      {/* 4 Stat Overview Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div className="fxi-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-500">My Leagues</span>
            <div className="w-8 h-8 rounded-xl bg-purple-50 text-[#37003c] flex items-center justify-center">
              <IconTrophy className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-900">3</span>
            <span className="text-[11px] font-bold text-emerald-600">&uarr; +1</span>
          </div>
        </div>

        <div className="fxi-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-500">Total Points</span>
            <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <IconStar className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-900">2,384</span>
            <span className="text-[11px] font-bold text-emerald-600">&uarr; +124</span>
          </div>
        </div>

        <div className="fxi-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-500">Active Players</span>
            <div className="w-8 h-8 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center">
              <IconUsers className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-900">1.2K</span>
            <span className="text-[11px] font-bold text-emerald-600">&uarr; +86</span>
          </div>
        </div>

        <div className="fxi-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-500">Prizes Won</span>
            <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
              <IconAward className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-900">$1,250</span>
            <span className="text-[11px] font-bold text-emerald-600">&uarr; +$250</span>
          </div>
        </div>
      </div>

      {/* Main Grid: Leagues & Leaderboard & Fixtures */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: My Leagues & Payments Banner */}
        <div className="lg:col-span-2 space-y-6">
          {/* Active Leagues Table */}
          <div className="fxi-card p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <IconTrophy className="w-4 h-4 text-[#37003c]" />
                <h2 className="text-base font-bold text-slate-900">My Leagues</h2>
              </div>
              <Link
                href="/leagues"
                className="text-xs font-bold text-[#37003c] hover:underline"
              >
                View All &rarr;
              </Link>
            </div>

            <div className="divide-y divide-slate-100">
              {/* League item 1 */}
              <div className="py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 border border-amber-200/60 flex items-center justify-center shrink-0">
                    <IconCrown size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate">
                      Weekend Warriors
                    </p>
                    <p className="text-xs text-slate-400">12 managers &bull; Gameweek 12</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <span className="hidden sm:inline-block text-xs font-semibold text-emerald-700">
                    Active
                  </span>
                  <div className="text-right">
                    <div className="text-xs font-bold text-slate-900">3rd / 12</div>
                    <div className="text-[10px] text-slate-400">86 pts</div>
                  </div>
                  <Link
                    href="/leagues"
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#37003c] text-white hover:bg-[#28002c] transition-colors"
                  >
                    View &rarr;
                  </Link>
                </div>
              </div>

              {/* League item 2 */}
              <div className="py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-purple-50 text-[#37003c] border border-purple-200/60 flex items-center justify-center shrink-0">
                    <IconStar size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate">
                      Campus Champions Cup
                    </p>
                    <p className="text-xs text-slate-400">8 managers &bull; Gameweek 12</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <span className="hidden sm:inline-block text-xs font-semibold text-emerald-700">
                    Active
                  </span>
                  <div className="text-right">
                    <div className="text-xs font-bold text-slate-900">1st / 8</div>
                    <div className="text-[10px] text-slate-400">92 pts</div>
                  </div>
                  <Link
                    href="/leagues"
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#37003c] text-white hover:bg-[#28002c] transition-colors"
                  >
                    View &rarr;
                  </Link>
                </div>
              </div>

              {/* League item 3 */}
              <div className="py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200/60 flex items-center justify-center shrink-0">
                    <IconFootball size={18} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate">
                      Premier High-Roller League
                    </p>
                    <p className="text-xs text-slate-400">24 managers &bull; Gameweek 12</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <span className="hidden sm:inline-block text-xs font-semibold text-emerald-700">
                    Active
                  </span>
                  <div className="text-right">
                    <div className="text-xs font-bold text-slate-900">7th / 24</div>
                    <div className="text-[10px] text-slate-400">78 pts</div>
                  </div>
                  <Link
                    href="/leagues"
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#37003c] text-white hover:bg-[#28002c] transition-colors"
                  >
                    View &rarr;
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Secure & Private Payments Banner */}
          <div className="relative rounded-3xl bg-gradient-to-r from-[#20033c] via-[#350247] to-[#044c35] p-6 text-white overflow-hidden shadow-lg flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center shrink-0">
                <IconShield className="w-6 h-6 text-[#00ff87]" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white mb-1">
                  Secure & Private Payments
                </h3>
                <p className="text-xs text-slate-200">
                  Fund entry fees with Stellar USDC or XLM. Fast, low-fee, and secured by Soroban smart contracts.
                </p>
              </div>
            </div>
            <Link
              href="/profile"
              className="px-4 py-2 rounded-xl text-xs font-bold bg-[#00ff87] text-[#24002e] hover:bg-[#00e575] transition-colors shrink-0"
            >
              Choose Payment &rarr;
            </Link>
          </div>
        </div>

        {/* Right Col: Upcoming Fixtures & Leaderboard */}
        <div className="space-y-6">
          {/* Upcoming Fixtures */}
          <div className="fxi-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <IconCalendar className="w-4 h-4 text-[#37003c]" />
                <h2 className="text-base font-bold text-slate-900">Upcoming Fixtures</h2>
              </div>
              <Link href="/fixtures" className="text-xs font-bold text-[#37003c] hover:underline">
                View All &rarr;
              </Link>
            </div>

            <div className="space-y-3">
              {fixtures.length > 0 ? (
                fixtures.map((fixture) => (
                  <div
                    key={fixture.id}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs"
                  >
                    <div className="font-bold text-slate-800">{fixture.homeTeam?.shortName || "HOME"}</div>
                    <div className="text-[11px] font-semibold text-slate-400 bg-white px-2 py-0.5 rounded-md border border-slate-200">
                      VS
                    </div>
                    <div className="font-bold text-slate-800">{fixture.awayTeam?.shortName || "AWAY"}</div>
                  </div>
                ))
              ) : (
                <div className="space-y-3">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs font-bold text-slate-800">
                    <span>MCI</span>
                    <span className="text-[11px] font-medium text-slate-400">VS</span>
                    <span>LIV</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs font-bold text-slate-800">
                    <span>ARS</span>
                    <span className="text-[11px] font-medium text-slate-400">VS</span>
                    <span>CHE</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Global Leaderboard Preview */}
          <div className="fxi-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <IconAward className="w-4 h-4 text-[#37003c]" />
                <h2 className="text-base font-bold text-slate-900">Top Managers</h2>
              </div>
              <Link href="/leaderboard" className="text-xs font-bold text-[#37003c] hover:underline">
                View All &rarr;
              </Link>
            </div>

            <div className="divide-y divide-slate-100 text-xs">
              <div className="py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="font-black text-amber-500 w-4">1</span>
                  <span className="font-bold text-slate-800">KingFootball</span>
                </div>
                <span className="font-mono font-bold text-slate-900">2,845 pts</span>
              </div>
              <div className="py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="font-black text-slate-400 w-4">2</span>
                  <span className="font-bold text-slate-800">GoalDigger</span>
                </div>
                <span className="font-mono font-bold text-slate-900">2,720 pts</span>
              </div>
              <div className="py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="font-black text-amber-700 w-4">3</span>
                  <span className="font-bold text-slate-800">StanleyXI</span>
                </div>
                <span className="font-mono font-bold text-slate-900">2,384 pts</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
