"use client";

import React, { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Fixture, Gameweek } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconCheck,
} from "@/components/ui/Icons";
import { LiveMatchEventsTimeline } from "@/components/live/LiveMatchEventsTimeline";

export default function FixturesPage() {
  const [gameweeks, setGameweeks] = useState<Gameweek[]>([]);
  const [selectedGwId, setSelectedGwId] = useState<number | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [isLoadingGw, setIsLoadingGw] = useState<boolean>(true);
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
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Premier League Schedule
            </span>
            <span className="text-xs text-slate-500 font-mono">&bull; FPL Official Data</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-white uppercase tracking-tight">
            Matchday Fixtures
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Follow match schedules, kickoff dates, and live fantasy scoring.
          </p>
        </div>

        {selectedGw?.deadline && (
          <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800 text-right self-start sm:self-auto font-mono">
            <div className="text-[10px] text-slate-500 uppercase font-sans font-semibold">
              Round Deadline
            </div>
            <div className="text-xs font-bold text-white mt-0.5">
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
      <div className="flex items-center justify-between bg-pitch-surface border border-pitch-border p-3 rounded-xl shadow-md">
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
            className="px-4 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white font-bold text-sm focus:outline-none focus:border-emerald-500 font-mono text-center"
          >
            {gameweeks.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} {g.isCurrent ? "★ Active" : ""}
              </option>
            ))}
          </select>

          {selectedGw?.isCurrent && (
            <Badge variant="success" size="sm">
              Active Round
            </Badge>
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
      {isLoadingFix ? (
        <div className="py-24 text-center text-slate-400">
          <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-xs">Loading Premier League fixtures...</p>
        </div>
      ) : fixtures.length > 0 ? (
        <div className="space-y-6">
          {Object.entries(fixturesByDate).map(([dateTitle, dateFixtures]) => (
            <div key={dateTitle} className="space-y-3">
              {/* Date Header */}
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
                <IconCalendar className="w-4 h-4 text-emerald-400" />
                <span>{dateTitle}</span>
              </div>

              {/* Match Cards List */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {dateFixtures.map((fix) => {
                  const kickoff = fix.kickoffTime ? new Date(fix.kickoffTime) : null;

                  return (
                    <div
                      key={fix.id}
                      className="bg-pitch-surface border border-pitch-border rounded-xl p-4 shadow-sm hover:border-slate-700 transition-colors flex items-center justify-between"
                    >
                      {/* Home Team */}
                      <div className="flex-1 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center font-bold text-xs font-mono text-slate-200">
                          {fix.homeTeam?.shortName || "PL"}
                        </div>
                        <span className="font-bold text-sm text-white truncate">
                          {fix.homeTeam?.name || `Team ${fix.homeTeamId}`}
                        </span>
                      </div>

                      {/* Score or Kickoff Time */}
                      <div className="px-4 text-center">
                        {fix.started ? (
                          <div className="flex flex-col items-center">
                            <span className="font-mono font-black text-base text-emerald-400 tabular-nums tracking-wider">
                              {fix.homeScore ?? 0} - {fix.awayScore ?? 0}
                            </span>
                            <span className="text-[10px] text-slate-500 font-mono mt-1 font-semibold uppercase">
                              {fix.finished ? "Full Time" : `${fix.minutes}'`}
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center">
                            <span className="font-mono font-bold text-xs text-slate-300">
                              {kickoff
                                ? kickoff.toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "TBD"}
                            </span>
                            <span className="text-[10px] text-slate-500 mt-0.5">Kickoff</span>
                          </div>
                        )}
                      </div>

                      {/* Away Team */}
                      <div className="flex-1 flex items-center justify-end gap-3 text-right">
                        <span className="font-bold text-sm text-white truncate">
                          {fix.awayTeam?.name || `Team ${fix.awayTeamId}`}
                        </span>
                        <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center font-bold text-xs font-mono text-slate-200">
                          {fix.awayTeam?.shortName || "PL"}
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
        <div className="py-20 text-center bg-pitch-surface border border-pitch-border rounded-xl p-8 text-slate-500 text-xs">
          No matches scheduled for {selectedGw ? selectedGw.name : "this gameweek"}.
        </div>
      )}

      {/* Live Match Events Timeline */}
      <LiveMatchEventsTimeline
        gameweekId={selectedGwId ?? 1}
        className="mt-8"
      />
    </div>
  );
}
