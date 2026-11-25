"use client";

import React, { useEffect, useMemo } from "react";
import { useTeamStore } from "@/store/teamStore";
import { useEventTickerStore } from "@/store/eventTickerStore";
import { useEventTicker } from "@/hooks/useEventTicker";
import EventTickerCard from "./EventTickerCard";
import type { TimelineEvent } from "@/types";

interface LiveEventTickerProps {
  gameweekId: number;
  className?: string;
  position?: "top" | "bottom";
  showConnectionStatus?: boolean;
  autoRemoveEventAfterMs?: number;
  maxVisibleEvents?: number;
}

/**
 * Live event ticker that displays real-time match events in an animated queue.
 * Events stream in from a WebSocket, with filtering for user's squad.
 * Handles connection state, auto-removal, and deduplication.
 */
export function LiveEventTicker({
  gameweekId,
  className = "",
  position = "top",
  showConnectionStatus = true,
  autoRemoveEventAfterMs = 8000,
  maxVisibleEvents = 5,
}: LiveEventTickerProps) {
  const { players: userSquadPlayers } = useTeamStore();
  const {
    eventQueue,
    filterMode,
    setFilterMode,
    connectionState,
    setConnectionState,
    addEvent,
    removeEvent,
    mySquadPlayerIds,
    setMySquadPlayerIds,
    getFilteredEvents,
  } = useEventTickerStore();

  // Set user squad player IDs
  useEffect(() => {
    const playerIds = userSquadPlayers.map((p) => p.playerId);
    setMySquadPlayerIds(playerIds);
  }, [userSquadPlayers, setMySquadPlayerIds]);

  // Connect to WebSocket
  useEventTicker({
    gameweekId,
    onEvent: (event: TimelineEvent) => {
      addEvent(event);
    },
    onConnectionState: setConnectionState,
    onError: (error) => {
      console.error("[LiveEventTicker]", error.message);
    },
    autoReconnect: true,
    maxReconnectAttempts: 5,
  });

  // Create a map for quick lookup of squad players
  const squadPlayerMap = useMemo(() => {
    return new Map(
      userSquadPlayers.map((sp) => [
        sp.playerId,
        { isCaptain: sp.isCaptain, isViceCaptain: sp.isViceCaptain },
      ])
    );
  }, [userSquadPlayers]);

  // Get filtered and limited events for display
  const visibleEvents = useMemo(() => {
    const filtered = getFilteredEvents();
    return filtered.slice(0, maxVisibleEvents);
  }, [getFilteredEvents, maxVisibleEvents]);

  // Count by type for stats
  const eventStats = useMemo(() => {
    return eventQueue.reduce(
      (acc, event) => {
        acc[event.type as keyof typeof acc] = (acc[event.type as keyof typeof acc] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
  }, [eventQueue]);

  const isConnected = connectionState === "open";
  const isReconnecting = connectionState === "reconnecting";

  // Position classes
  const positionClasses =
    position === "top"
      ? "fixed top-0 left-0 right-0 pt-4 px-4 sm:pt-6 sm:px-6"
      : "fixed bottom-0 left-0 right-0 pb-4 px-4 sm:pb-6 sm:px-6";

  return (
    <div
      className={`pointer-events-none ${positionClasses} z-40 ${className}`}
      data-testid="live-event-ticker"
    >
      <div className="max-w-2xl mx-auto space-y-2">
        {/* Connection Status Indicator */}
        {showConnectionStatus && (
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-900/80 border border-gray-800 rounded-lg backdrop-blur-sm pointer-events-auto">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span
                  className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                    isConnected ? "bg-emerald-400" : isReconnecting ? "bg-amber-400" : "bg-red-400"
                  }`}
                />
                <span
                  className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                    isConnected ? "bg-emerald-500" : isReconnecting ? "bg-amber-500" : "bg-red-500"
                  }`}
                />
              </span>
              <span className="text-xs font-semibold text-gray-300">
                {isConnected
                  ? "Live"
                  : isReconnecting
                    ? "Reconnecting..."
                    : "Offline"}
              </span>
            </div>

            {/* Event Type Stats */}
            {Object.entries(eventStats).length > 0 && (
              <div className="flex items-center gap-3 ml-auto">
                {eventStats.GOAL ? (
                  <span className="text-xs text-emerald-400">
                    ⚽ {eventStats.GOAL}
                  </span>
                ) : null}
                {eventStats.ASSIST ? (
                  <span className="text-xs text-cyan-400">
                    🎯 {eventStats.ASSIST}
                  </span>
                ) : null}
                {eventStats.YELLOW_CARD || eventStats.RED_CARD ? (
                  <span className="text-xs text-amber-400">
                    🟨 {(eventStats.YELLOW_CARD || 0) + (eventStats.RED_CARD || 0)}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* Filter Controls */}
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={() => setFilterMode("ALL")}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              filterMode === "ALL"
                ? "bg-gray-800 text-white shadow-sm"
                : "bg-gray-950/60 text-gray-400 hover:text-white border border-gray-800"
            }`}
          >
            All
          </button>
          <button
            onClick={() => setFilterMode("MY_SQUAD")}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              filterMode === "MY_SQUAD"
                ? "bg-emerald-700/80 text-white shadow-sm"
                : "bg-gray-950/60 text-gray-400 hover:text-white border border-gray-800"
            }`}
          >
            My Squad
          </button>
          <button
            onClick={() => setFilterMode("FANTASY_RELEVANT")}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              filterMode === "FANTASY_RELEVANT"
                ? "bg-blue-700/80 text-white shadow-sm"
                : "bg-gray-950/60 text-gray-400 hover:text-white border border-gray-800"
            }`}
          >
            Fantasy
          </button>
        </div>

        {/* Event Cards Stack */}
        <div className="space-y-2 pointer-events-auto">
          {visibleEvents.length > 0 ? (
            visibleEvents.map((event, idx) => {
              const squadPlayer = squadPlayerMap.get(event.playerId);
              return (
                <EventTickerCard
                  key={event.id}
                  event={event}
                  isInUserTeam={mySquadPlayerIds.has(event.playerId)}
                  isCaptain={squadPlayer?.isCaptain ?? false}
                  isViceCaptain={squadPlayer?.isViceCaptain ?? false}
                  onRemove={removeEvent}
                  autoRemoveAfterMs={autoRemoveEventAfterMs}
                  className={`animate-in slide-in-from-top fade-in duration-300 ease-out`}
                  style={{ animationDelay: `${idx * 50}ms` } as React.CSSProperties}
                />
              );
            })
          ) : (
            <div className="text-xs text-gray-500 text-center py-2 bg-gray-950/40 rounded border border-gray-800/50">
              {eventQueue.length === 0
                ? "Waiting for live events..."
                : `No events matching "${filterMode}" filter`}
            </div>
          )}
        </div>

        {/* Total Events Indicator */}
        {eventQueue.length > maxVisibleEvents && (
          <div className="text-xs text-gray-500 text-center">
            +{eventQueue.length - maxVisibleEvents} more event{eventQueue.length - maxVisibleEvents !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

export default LiveEventTicker;
