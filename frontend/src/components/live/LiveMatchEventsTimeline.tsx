"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useTeamStore } from "@/store/teamStore";
import type { GameweekTimeline, MatchEventType } from "@/types";

interface LiveMatchEventsTimelineProps {
  gameweekId?: number;
  className?: string;
  autoRefreshIntervalMs?: number;
}

export function LiveMatchEventsTimeline({
  gameweekId = 1,
  className = "",
  autoRefreshIntervalMs = 15000,
}: LiveMatchEventsTimelineProps) {
  const { players: userSquadPlayers } = useTeamStore();
  const [timeline, setTimeline] = useState<GameweekTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | "MY_TEAM" | "GOALS">("ALL");
  const [isLiveConnected, setIsLiveConnected] = useState(false);

  // Set of player IDs in user's team
  const userPlayerIdSet = useMemo(() => {
    return new Set(userSquadPlayers.map((sp) => sp.playerId));
  }, [userSquadPlayers]);

  const userPlayerMap = useMemo(() => {
    return new Map(userSquadPlayers.map((sp) => [sp.playerId, sp]));
  }, [userSquadPlayers]);

  // Fetch timeline from REST or SSE
  useEffect(() => {
    let isSubscribed = true;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

    async function fetchTimeline() {
      try {
        const res = await fetch(`${apiUrl}/api/v1/live/timeline/${gameweekId}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        const json = await res.json();
        if (isSubscribed && json.success) {
          setTimeline(json.data);
          setError(null);
        }
      } catch (err) {
        if (isSubscribed) {
          setError((err as Error).message);
        }
      } finally {
        if (isSubscribed) setLoading(false);
      }
    }

    fetchTimeline();

    // SSE connection for real-time live events
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(`${apiUrl}/api/v1/live/timeline/${gameweekId}/stream`);
      eventSource.addEventListener("timeline", (e) => {
        if (!isSubscribed) return;
        try {
          const data = JSON.parse(e.data);
          setTimeline(data);
          setIsLiveConnected(true);
          setError(null);
        } catch {
          // ignore parse errors
        }
      });

      eventSource.onerror = () => {
        setIsLiveConnected(false);
      };
    } catch {
      // EventSource failed to initialize; rely on polling fallback
    }

    // Polling fallback
    const interval = setInterval(fetchTimeline, autoRefreshIntervalMs);

    return () => {
      isSubscribed = false;
      clearInterval(interval);
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [gameweekId, autoRefreshIntervalMs]);

  // Filter events
  const filteredEvents = useMemo(() => {
    if (!timeline) return [];
    let list = timeline.events;

    if (filter === "MY_TEAM") {
      list = list.filter((evt) => userPlayerIdSet.has(evt.playerId));
    } else if (filter === "GOALS") {
      list = list.filter((evt) => evt.type === "GOAL");
    }

    return list;
  }, [timeline, filter, userPlayerIdSet]);

  const renderEventIcon = (type: MatchEventType) => {
    switch (type) {
      case "GOAL":
        return <span className="text-emerald-400 font-bold text-base" title="Goal">⚽</span>;
      case "ASSIST":
        return <span className="text-cyan-400 font-bold text-base" title="Assist">🅰️</span>;
      case "YELLOW_CARD":
        return <span className="text-amber-400 font-bold text-base" title="Yellow Card">🟨</span>;
      case "RED_CARD":
        return <span className="text-rose-500 font-bold text-base" title="Red Card">🟥</span>;
      case "SAVE":
        return <span className="text-indigo-400 font-bold text-base" title="Save">🧤</span>;
      case "BONUS":
        return <span className="text-yellow-300 font-bold text-base" title="Bonus">⭐</span>;
      default:
        return <span className="text-gray-400 text-base">•</span>;
    }
  };

  const getPointsBadgeClass = (points: number) => {
    if (points > 0) return "bg-emerald-900/60 text-emerald-300 border-emerald-700/50";
    if (points < 0) return "bg-rose-900/60 text-rose-300 border-rose-700/50";
    return "bg-gray-800 text-gray-300 border-gray-700";
  };

  return (
    <div
      className={`bg-gray-900/90 border border-gray-800 rounded-xl p-5 shadow-lg backdrop-blur-sm ${className}`}
      data-testid="live-match-events-timeline"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-gray-800 gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  isLiveConnected ? "bg-emerald-400" : "bg-cyan-400"
                }`}
              />
              <span
                className={`relative inline-flex rounded-full h-3 w-3 ${
                  isLiveConnected ? "bg-emerald-500" : "bg-cyan-500"
                }`}
              />
            </span>
            <h3 className="font-semibold text-white text-lg tracking-wide">
              Live Match Events
            </h3>
          </div>
          <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-gray-800 text-gray-400 border border-gray-700">
            {timeline?.gameweek?.name ?? `Gameweek ${gameweekId}`}
          </span>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-1.5 self-start sm:self-auto bg-gray-950/60 p-1 rounded-lg border border-gray-800">
          <button
            type="button"
            onClick={() => setFilter("ALL")}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              filter === "ALL"
                ? "bg-gray-800 text-white shadow-sm"
                : "text-gray-400 hover:text-white"
            }`}
          >
            All Events ({timeline?.events?.length ?? 0})
          </button>
          <button
            type="button"
            onClick={() => setFilter("MY_TEAM")}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
              filter === "MY_TEAM"
                ? "bg-emerald-600/80 text-white shadow-sm"
                : "text-gray-400 hover:text-white"
            }`}
          >
            <span>My Team</span>
            {userPlayerIdSet.size > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setFilter("GOALS")}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              filter === "GOALS"
                ? "bg-gray-800 text-white shadow-sm"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Goals ({timeline?.summary?.totalGoals ?? 0})
          </button>
        </div>
      </div>

      {/* Summary Stats Strip */}
      {timeline && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 my-4">
          <div className="bg-gray-950/40 border border-gray-800/80 rounded-lg p-2.5 text-center">
            <span className="text-xs text-gray-400 block">Goals</span>
            <span className="text-base font-bold text-emerald-400">
              {timeline.summary.totalGoals}
            </span>
          </div>
          <div className="bg-gray-950/40 border border-gray-800/80 rounded-lg p-2.5 text-center">
            <span className="text-xs text-gray-400 block">Assists</span>
            <span className="text-base font-bold text-cyan-400">
              {timeline.summary.totalAssists}
            </span>
          </div>
          <div className="bg-gray-950/40 border border-gray-800/80 rounded-lg p-2.5 text-center">
            <span className="text-xs text-gray-400 block">Yellow / Red</span>
            <span className="text-base font-bold text-amber-400">
              {timeline.summary.totalYellowCards} / {timeline.summary.totalRedCards}
            </span>
          </div>
          <div className="bg-gray-950/40 border border-gray-800/80 rounded-lg p-2.5 text-center">
            <span className="text-xs text-gray-400 block">Saves</span>
            <span className="text-base font-bold text-indigo-400">
              {timeline.summary.totalSaves}
            </span>
          </div>
          <div className="bg-gray-950/40 border border-gray-800/80 rounded-lg p-2.5 text-center col-span-2 sm:col-span-1">
            <span className="text-xs text-gray-400 block">Bonus Awarded</span>
            <span className="text-base font-bold text-yellow-400">
              {timeline.summary.totalBonus}
            </span>
          </div>
        </div>
      )}

      {/* Loading & Error States */}
      {loading && !timeline && (
        <div className="py-12 text-center text-gray-400 flex flex-col items-center gap-2">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs">Loading match timeline...</span>
        </div>
      )}

      {error && !timeline && (
        <div className="py-8 text-center text-rose-400 text-sm bg-rose-950/20 border border-rose-800/30 rounded-lg my-2">
          Failed to load live match timeline: {error}
        </div>
      )}

      {/* Timeline Event List */}
      {!loading && filteredEvents.length === 0 && (
        <div className="py-10 text-center text-gray-500 text-sm">
          {filter === "MY_TEAM"
            ? "No events recorded for players in your squad yet."
            : "No match events recorded for this gameweek yet."}
        </div>
      )}

      {filteredEvents.length > 0 && (
        <div className="relative pl-6 space-y-4 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-800">
          {filteredEvents.map((evt) => {
            const inUserTeam = userPlayerIdSet.has(evt.playerId);
            const userSquadItem = inUserTeam ? userPlayerMap.get(evt.playerId) : null;
            const isCaptain = userSquadItem?.isCaptain ?? false;
            const isViceCaptain = userSquadItem?.isViceCaptain ?? false;

            return (
              <div
                key={evt.id}
                className={`relative flex items-start gap-3 p-3 rounded-lg border transition-all ${
                  inUserTeam
                    ? "bg-emerald-950/25 border-emerald-600/40 hover:border-emerald-500/60 shadow-sm"
                    : "bg-gray-950/30 border-gray-800/70 hover:border-gray-700/80"
                }`}
              >
                {/* Minute Marker Circle on vertical line */}
                <div
                  className={`absolute -left-[27px] top-3.5 w-4 h-4 rounded-full border-2 flex items-center justify-center bg-gray-900 ${
                    inUserTeam
                      ? "border-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                      : "border-gray-600"
                  }`}
                />

                {/* Event Icon */}
                <div className="p-2 rounded-md bg-gray-900/80 border border-gray-800 shrink-0">
                  {renderEventIcon(evt.type)}
                </div>

                {/* Main Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                      {evt.minute}&apos;
                    </span>

                    <span className="text-sm font-semibold text-white truncate">
                      {evt.playerName}
                    </span>

                    <span className="text-xs text-gray-400 font-medium">
                      ({evt.teamShortName})
                    </span>

                    {/* User Team Badge */}
                    {inUserTeam && (
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
                        <span>YOUR SQUAD</span>
                        {isCaptain && (
                          <span className="bg-amber-400 text-gray-900 px-1 rounded text-[9px] font-black">
                            C
                          </span>
                        )}
                        {isViceCaptain && (
                          <span className="bg-gray-300 text-gray-900 px-1 rounded text-[9px] font-black">
                            V
                          </span>
                        )}
                      </span>
                    )}

                    <span className="text-xs text-gray-500 ml-auto">
                      {evt.fixtureName}
                    </span>
                  </div>

                  <p className="text-xs text-gray-300 mt-1">{evt.detail}</p>
                </div>

                {/* Points Awarded Pill */}
                <div className="shrink-0 flex items-center">
                  <span
                    className={`text-xs font-semibold px-2 py-1 rounded border ${getPointsBadgeClass(
                      evt.pointsAwarded
                    )}`}
                  >
                    {evt.pointsAwarded > 0 ? `+${evt.pointsAwarded}` : evt.pointsAwarded} pts
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default LiveMatchEventsTimeline;
