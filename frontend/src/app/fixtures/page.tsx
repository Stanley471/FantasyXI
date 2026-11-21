"use client";

import React, { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Fixture, Gameweek } from "@/types";
import { Button } from "@/components/ui/Button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
} from "@/components/ui/Icons";
import { LiveMatchEventsTimeline } from "@/components/live/LiveMatchEventsTimeline";

function fixtureStatus(fixture: Fixture): { label: string; className: string } {
  if (fixture.finished) return { label: "FT", className: "bg-slate-900 text-white" };
  if (fixture.started && fixture.minutes === 45) return { label: "HT", className: "bg-amber-100 text-amber-800" };
  if (fixture.started) return { label: `${fixture.minutes}' LIVE`, className: "bg-rose-100 text-rose-700 animate-pulse" };
  return { label: "UPCOMING", className: "bg-sky-100 text-sky-700" };
}

export default function FixturesPage() {
  const [gameweeks, setGameweeks] = useState<Gameweek[]>([]);
  const [selectedGwId, setSelectedGwId] = useState<number | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [, setIsLoadingGw] = useState<boolean>(true);
  const [isLoadingFix, setIsLoadingFix] = useState<boolean>(false);

  // Load gameweeks
  useEffect(() => {
    async function loadGameweeks() {
      try {
        const res = await api.get<{ success: boolean; data: Gameweek[] }>("/api/v1/gameweeks");
        if (res?.data && res.data.length > 0) {
          setGameweeks(res.data);
          const current = res.data.find((g) => g.isCurrent) || res.data[0];
          setSelectedGwId(current.id);
        }
      } catch (err) {
        console.error("Failed to load gameweeks:", err);
      } finally {
        setIsLoadingGw(false);
      }
    }

    loadGameweeks();
  }, []);

  // Load fixtures when selectedGwId changes
  useEffect(() => {
    if (!selectedGwId) return;

    async function loadFixtures() {
      setIsLoadingFix(true);
      try {
        const res = await api.get<{ success: boolean; data: Fixture[] }>(
          `/api/v1/fixtures?gameweekId=${selectedGwId}`
        );
        if (res?.data) {
          setFixtures(res.data);
        }
      } catch (err) {
        console.error("Failed to load fixtures:", err);
      } finally {
        setIsLoadingFix(false);
      }
    }

    loadFixtures();
    const timer = window.setInterval(loadFixtures, 30_000);
    return () => window.clearInterval(timer);
  }, [selectedGwId]);

  const selectedGw = gameweeks.find((g) => g.id === selectedGwId);
  const selectedIndex = gameweeks.findIndex((g) => g.id === selectedGwId);

  const handlePrevGw = () => {
    if (selectedIndex > 0) {
      setSelectedGwId(gameweeks[selectedIndex - 1].id);
    }
  };

  const handleNextGw = () => {
    if (selectedIndex < gameweeks.length - 1) {
      setSelectedGwId(gameweeks[selectedIndex + 1].id);
    }
  };

  // Group fixtures by kickoff date
  const fixturesByDate: Record<string, Fixture[]> = {};
  fixtures.forEach((f) => {
    const dateStr = f.kickoffTime
      ? new Date(f.kickoffTime).toLocaleDateString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : "Scheduled Fixtures";
    if (!fixturesByDate[dateStr]) {
      fixturesByDate[dateStr] = [];
    }
    fixturesByDate[dateStr].push(f);
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 sm:p-8 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">
              Premier League Schedule
            </span>
            <span className="text-xs text-slate-400 font-mono">&bull; FPL Official Data</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-tight">
            Matchday Fixtures
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1 max-w-xl leading-relaxed">
            Follow match schedules, kickoff dates, and live fantasy scoring.
          </p>
        </div>

        {selectedGw?.deadline && (
          <div className="p-3.5 rounded-2xl bg-purple-50/60 border border-purple-200/60 text-right self-start sm:self-auto font-mono">
            <div className="text-[10px] text-slate-500 uppercase font-sans font-bold">
              Round Deadline
            </div>
            <div className="text-xs font-black text-slate-900 mt-0.5">
              {new Date(selectedGw.deadline).toLocaleDateString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          </div>
        )}
      </div>

      {/* Gameweek Switcher Bar */}
      <div className="flex items-center justify-between bg-white border border-slate-200/80 p-3.5 rounded-2xl shadow-sm">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={selectedIndex <= 0}
          onClick={handlePrevGw}
          className="text-xs"
        >
          <IconChevronLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Previous Round</span>
        </Button>

        <div className="flex items-center gap-3">
          <select
            value={selectedGwId || ""}
            onChange={(e) => setSelectedGwId(parseInt(e.target.value, 10))}
            className="px-4 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 font-bold text-xs focus:outline-none focus:border-[#37003c] font-mono text-center"
          >
            {gameweeks.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} {g.isCurrent ? "— Active" : ""}
              </option>
            ))}
          </select>

          {selectedGw?.isCurrent && (
            <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
              Active round
            </span>
          )}
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={selectedIndex >= gameweeks.length - 1}
          onClick={handleNextGw}
          className="text-xs"
        >
          <span className="hidden sm:inline">Next Round</span>
          <IconChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* Match Cards Container */}
      <ErrorBoundary
        name="FixturesList"
        fallbackTitle="Fixtures schedule failed to render"
        resetKeys={[selectedGwId]}
      >
        {isLoadingFix ? (
          <div className="py-24 text-center text-slate-500 text-xs font-semibold">
            <div className="inline-block w-8 h-8 border-2 border-[#37003c] border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-xs">Loading Premier League fixtures...</p>
          </div>
        ) : fixtures.length > 0 ? (
          <div className="space-y-6">
            {Object.entries(fixturesByDate).map(([dateTitle, dateFixtures]) => (
              <div key={dateTitle} className="space-y-3">
                {/* Date Header */}
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 px-1">
                  <IconCalendar className="w-4 h-4 text-[#37003c]" />
                  <span>{dateTitle}</span>
                </div>

                {/* Match Cards List */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {dateFixtures.map((fix) => {
                    const kickoff = fix.kickoffTime ? new Date(fix.kickoffTime) : null;
                    const status = fixtureStatus(fix);

                    return (
                      <div
                        key={fix.id}
                        className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-sm hover:border-slate-300 transition-colors flex items-center justify-between"
                      >
                        {/* Home Team */}
                        <div className="flex-1 flex items-center gap-3">
                          <div className="w-8 h-8 rounded-xl bg-purple-50 border border-purple-100 flex items-center justify-center font-bold text-xs font-mono text-[#37003c]">
                            {fix.homeTeam?.logoUrl ? <img src={fix.homeTeam.logoUrl} alt="" className="w-6 h-6 object-contain" /> : (fix.homeTeam?.shortName || "PL")}
                          </div>
                          <span className="font-bold text-xs sm:text-sm text-slate-900 truncate">
                            {fix.homeTeam?.name || `Team ${fix.homeTeamId}`}
                          </span>
                        </div>

                        {/* Score or Kickoff Time */}
                        <div className="px-4 text-center">
                          {fix.started ? (
                            <div className="flex flex-col items-center">
                              <span className="font-mono font-black text-base text-slate-900 tabular-nums tracking-wider">
                                {fix.homeScore ?? 0} - {fix.awayScore ?? 0}
                              </span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono mt-1 font-bold uppercase ${status.className}`}>
                                {status.label}
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center">
                              <span className="font-mono font-bold text-xs text-slate-900">
                                {kickoff
                                  ? kickoff.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : "TBD"}
                              </span>
                              <span className="text-[10px] text-slate-400 mt-0.5">Kickoff</span>
                              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold mt-1 ${status.className}`}>{status.label}</span>
                            </div>
                          )}
                        </div>

                        {/* Away Team */}
                        <div className="flex-1 flex items-center justify-end gap-3 text-right">
                          <span className="font-bold text-xs sm:text-sm text-slate-900 truncate">
                            {fix.awayTeam?.name || `Team ${fix.awayTeamId}`}
                          </span>
                          <div className="w-8 h-8 rounded-xl bg-purple-50 border border-purple-100 flex items-center justify-center font-bold text-xs font-mono text-[#37003c]">
                            {fix.awayTeam?.logoUrl ? <img src={fix.awayTeam.logoUrl} alt="" className="w-6 h-6 object-contain" /> : (fix.awayTeam?.shortName || "PL")}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-20 text-center bg-white border border-slate-200/80 rounded-3xl p-8 text-slate-500 text-xs">
            No matches scheduled for {selectedGw ? selectedGw.name : "this gameweek"}.
          </div>
        )}
      </ErrorBoundary>

      {/* Live Match Events Timeline */}
      <ErrorBoundary
        name="LiveMatchEventsTimeline"
        fallbackTitle="Live match events feed encountered an error"
        resetKeys={[selectedGwId]}
      >
        <LiveMatchEventsTimeline
          gameweekId={selectedGwId ?? 1}
          className="mt-8"
        />
      </ErrorBoundary>
    </div>
  );
}
