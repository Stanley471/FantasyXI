"use client";

import React, { useEffect, useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getSnapshot() {
  return navigator.onLine;
}

function getServerSnapshot() {
  return true;
}

export function OfflineIndicator() {
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isOffline = !isOnline;

  useEffect(() => {
    // Register Service Worker for PWA offline capabilities
    if ("serviceWorker" in navigator && process.env.NODE_ENV !== "development") {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("[PWA] Service Worker registered with scope:", registration.scope);
        })
        .catch((err) => {
          console.warn("[PWA] Service Worker registration failed:", err);
        });
    }
  }, []);

  if (!isOffline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-amber-600/90 text-white text-xs px-4 py-2 flex items-center justify-between shadow-md border-b border-amber-500 backdrop-blur-sm sticky top-0 z-50 animate-in fade-in duration-200"
    >
      <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4 shrink-0 text-amber-200"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 4.243a5 5 0 01-1.414-3.536m0 0l2.829-2.829m-2.829 2.829L3 21m6.364-15.364a9 9 0 0112.728 0"
          />
        </svg>
        <span className="font-medium">
          You are offline. Showing cached team & gameweek points.
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-auto underline font-semibold hover:text-amber-100 transition-colors cursor-pointer"
        >
          Retry Connection
        </button>
      </div>
    </div>
  );
}

export default OfflineIndicator;
