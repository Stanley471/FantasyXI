"use client";

import React, { useState } from "react";
import LiveEventTicker from "./LiveEventTicker";

/**
 * Example implementation showing how to integrate LiveEventTicker into a page.
 * Can be placed in a live match page, dashboard, or sidebar.
 */
export function LiveEventTickerExample({ gameweekId = 1 }: { gameweekId?: number }) {
  const [tickerPosition, setTickerPosition] = useState<"top" | "bottom">("top");
  const [showConnectionStatus, setShowConnectionStatus] = useState(true);

  return (
    <div className="space-y-4">
      {/* Configuration Panel (remove in production) */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white">Ticker Settings (Dev)</h3>

        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showConnectionStatus}
              onChange={(e) => setShowConnectionStatus(e.target.checked)}
              className="rounded"
            />
            <span className="text-xs text-gray-300">Show Connection Status</span>
          </label>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-gray-400 block">Position</label>
          <div className="flex gap-2">
            <button
              onClick={() => setTickerPosition("top")}
              className={`px-3 py-1 text-xs rounded ${
                tickerPosition === "top"
                  ? "bg-emerald-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              Top
            </button>
            <button
              onClick={() => setTickerPosition("bottom")}
              className={`px-3 py-1 text-xs rounded ${
                tickerPosition === "bottom"
                  ? "bg-emerald-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              Bottom
            </button>
          </div>
        </div>
      </div>

      {/* Live Event Ticker Component */}
      <LiveEventTicker
        gameweekId={gameweekId}
        position={tickerPosition}
        showConnectionStatus={showConnectionStatus}
        autoRemoveEventAfterMs={8000}
        maxVisibleEvents={5}
      />

      {/* Example info */}
      <div className="bg-blue-950/30 border border-blue-800/50 rounded-lg p-4 text-xs text-blue-300 space-y-2">
        <p className="font-semibold">How it works:</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li>Connects to WebSocket for live gameweek {gameweekId} events</li>
          <li>Events animate in smoothly at 60fps with no layout shifts</li>
          <li>Use filters to show: All events, My Squad only, or Fantasy-relevant</li>
          <li>Events auto-dismiss after 8 seconds (configurable)</li>
          <li>Captain/Vice Captain badges highlight key squad members</li>
          <li>Connection status shows live/reconnecting/offline state</li>
        </ul>
      </div>
    </div>
  );
}

export default LiveEventTickerExample;
