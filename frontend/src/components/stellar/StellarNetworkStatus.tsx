"use client";

import React, { useEffect, useState } from "react";
import {
  NETWORK_LABEL,
  NETWORK_POLL_INTERVAL_MS,
  badgeTone,
  fetchNetworkStatus,
  type NetworkStatusSnapshot,
} from "@/lib/stellar/networkStatus";

const TONE_STYLES = {
  green: { dot: "bg-emerald-500", text: "text-emerald-700", ring: "border-emerald-200 bg-emerald-50" },
  amber: { dot: "bg-amber-500", text: "text-amber-700", ring: "border-amber-200 bg-amber-50" },
  red: { dot: "bg-rose-500", text: "text-rose-700", ring: "border-rose-200 bg-rose-50" },
} as const;

const HEALTH_WORD = { healthy: "Healthy", degraded: "Degraded", offline: "Offline" } as const;

/** Polls network health every 60s while the tab is visible. */
export function useStellarNetworkStatus(
  intervalMs: number = NETWORK_POLL_INTERVAL_MS
): NetworkStatusSnapshot | null {
  const [snapshot, setSnapshot] = useState<NetworkStatusSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      const next = await fetchNetworkStatus();
      if (!cancelled) setSnapshot(next);
    };
    void poll();
    const timer = setInterval(poll, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return snapshot;
}

export const StellarNetworkBadge: React.FC<{ snapshot: NetworkStatusSnapshot | null }> = ({ snapshot }) => {
  if (!snapshot) {
    return (
      <span
        role="status"
        className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500"
      >
        <span className="w-2 h-2 rounded-full bg-slate-300" aria-hidden="true" />
        {NETWORK_LABEL}: checking
      </span>
    );
  }
  const tone = TONE_STYLES[badgeTone(snapshot)];
  const latency = snapshot.latencyMs !== null ? ` (${Math.round(snapshot.latencyMs)}ms)` : "";
  const details = [
    snapshot.latestLedger !== null ? `Latest ledger: ${snapshot.latestLedger}` : null,
    snapshot.feeP50Stroops !== null ? `Median fee: ${snapshot.feeP50Stroops} stroops` : null,
    ...snapshot.advisories,
  ].filter(Boolean);

  return (
    <span
      role="status"
      title={details.join("\n")}
      data-health={snapshot.health}
      className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${tone.ring} ${tone.text}`}
    >
      <span className={`w-2 h-2 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span>
        {NETWORK_LABEL}: {HEALTH_WORD[snapshot.health]}
        {latency}
      </span>
      {snapshot.latestLedger !== null && (
        <span className="hidden lg:inline font-mono font-normal opacity-70">#{snapshot.latestLedger}</span>
      )}
    </span>
  );
};

export const StellarNetworkBanner: React.FC<{ snapshot: NetworkStatusSnapshot | null }> = ({ snapshot }) => {
  if (!snapshot?.showBanner) return null;
  const red = snapshot.health === "offline";
  return (
    <div
      role="alert"
      className={`px-4 sm:px-8 py-2 text-xs font-medium border-b ${
        red ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-amber-50 border-amber-200 text-amber-800"
      }`}
    >
      {snapshot.advisories.join(" ")}
    </div>
  );
};

/** Self-contained header badge (polls on its own). */
export const StellarNetworkStatus: React.FC = () => {
  const snapshot = useStellarNetworkStatus();
  return <StellarNetworkBadge snapshot={snapshot} />;
};
