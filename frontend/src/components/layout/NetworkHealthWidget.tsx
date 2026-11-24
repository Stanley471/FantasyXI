"use client";

import { useEffect, useState } from "react";
import {
  getNetworkHealthSnapshot,
  repairLocalCache,
  type NetworkHealth,
} from "@/lib/telemetry";

export function NetworkHealthWidget() {
  const [health, setHealth] = useState<NetworkHealth>(() => getNetworkHealthSnapshot());
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    const update = (event: Event) =>
      setHealth((event as CustomEvent<NetworkHealth>).detail ?? getNetworkHealthSnapshot());
    window.addEventListener("fantasyxi-network-health", update);
    return () => window.removeEventListener("fantasyxi-network-health", update);
  }, []);

  if (health === "healthy") return null;

  const repair = async () => {
    setRepairing(true);
    try {
      await repairLocalCache();
      window.location.reload();
    } finally {
      setRepairing(false);
    }
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[70] w-[min(22rem,calc(100vw-2rem))] border border-amber-300 bg-white p-4 shadow-lg rounded-lg"
    >
      <p className="text-sm font-bold text-slate-900">
        {health === "offline" ? "Connection unavailable" : "Local app data may be stale"}
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-600">
        {health === "offline"
          ? "Reconnect to sync your latest squad changes."
          : "Repeated sync failures were detected on this device."}
      </p>
      <button
        type="button"
        onClick={repair}
        disabled={repairing}
        className="mt-3 text-xs font-bold text-[#37003c] underline disabled:opacity-50"
      >
        {repairing ? "Repairing..." : "Repair local cache and resync"}
      </button>
    </aside>
  );
}
