"use client";

import React, { useEffect, useState } from "react";
import {
  registerServiceWorker,
  requestNotificationPermission,
  subscribeToPush,
  sendSubscriptionToServer,
} from "@/lib/pushNotifications";

type BannerState = "idle" | "visible" | "loading" | "success" | "error" | "denied" | "hidden";

const DISMISS_KEY = "push_prompt_dismissed";

export function PushNotificationPrompt() {
  const [state, setState] = useState<BannerState>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  // Decide on mount whether the prompt should be shown
  useEffect(() => {
    const shouldShow =
      "serviceWorker" in navigator &&
      "Notification" in window &&
      Notification.permission === "default" &&
      !localStorage.getItem(DISMISS_KEY);

    setState(shouldShow ? "visible" : "hidden");
  }, []);

  // Nothing to render
  if (state === "idle" || state === "hidden") return null;

  const handleEnable = async () => {
    setState("loading");
    setErrorMessage("");

    try {
      // 1. Ensure the service worker is registered
      const registration = await registerServiceWorker();
      if (!registration) {
        setState("error");
        setErrorMessage("Service Workers are not available in this browser.");
        return;
      }

      // 2. Ask for notification permission
      const permission = await requestNotificationPermission();
      if (permission === "denied") {
        setState("denied");
        return;
      }
      if (permission !== "granted") {
        // User dismissed the native prompt without choosing
        setState("visible");
        return;
      }

      // 3. Subscribe to push and sync with the server
      const subscription = await subscribeToPush(registration);
      if (!subscription) {
        setState("error");
        setErrorMessage("Could not create a push subscription. Please try again.");
        return;
      }

      await sendSubscriptionToServer(subscription);
      setState("success");

      // Auto-hide the success banner after 4 seconds
      setTimeout(() => setState("hidden"), 4000);
    } catch (err) {
      console.error("[PushNotificationPrompt] Unexpected error:", err);
      setState("error");
      setErrorMessage("Something went wrong. Please try again later.");
    }
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setState("hidden");
  };

  // ─── Success state ──────────────────────────────────────────────────────────
  if (state === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="sticky top-0 z-50 bg-emerald-600/90 text-white text-xs px-4 py-2 flex items-center justify-between shadow-md border-b border-emerald-500 backdrop-blur-sm animate-in fade-in duration-200"
      >
        <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
          {/* Checkmark icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 shrink-0 text-emerald-200"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span className="font-medium">
            Gameweek alerts enabled! You&apos;ll be notified of deadline reminders and score updates.
          </span>
        </div>
      </div>
    );
  }

  // ─── Permission denied state ─────────────────────────────────────────────────
  if (state === "denied") {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="sticky top-0 z-50 bg-slate-800/95 text-slate-300 text-xs px-4 py-2 flex items-center justify-between shadow-md border-b border-slate-700 backdrop-blur-sm animate-in fade-in duration-200"
      >
        <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
          {/* Info icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 shrink-0 text-slate-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>
            Notifications are blocked. To enable Gameweek alerts, update your browser&apos;s
            site permissions.
          </span>
          <button
            type="button"
            onClick={handleDismiss}
            className="ml-auto underline font-semibold hover:text-slate-100 transition-colors cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // ─── Error state ─────────────────────────────────────────────────────────────
  if (state === "error") {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="sticky top-0 z-50 bg-rose-700/90 text-white text-xs px-4 py-2 flex items-center justify-between shadow-md border-b border-rose-600 backdrop-blur-sm animate-in fade-in duration-200"
      >
        <div className="flex items-center gap-2 max-w-7xl mx-auto w-full">
          {/* Error icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 shrink-0 text-rose-200"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            />
          </svg>
          <span className="font-medium">{errorMessage}</span>
          <button
            type="button"
            onClick={() => setState("visible")}
            className="ml-auto underline font-semibold hover:text-rose-100 transition-colors cursor-pointer"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // ─── Default prompt banner ────────────────────────────────────────────────────
  return (
    <div
      role="complementary"
      aria-label="Push notification opt-in"
      className="sticky top-0 z-50 bg-slate-900/95 text-slate-100 text-xs px-4 py-2.5 flex items-center shadow-md border-b border-slate-700/80 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div className="flex items-center gap-3 max-w-7xl mx-auto w-full">
        {/* Bell icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4 shrink-0 text-emerald-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>

        <span className="font-medium text-slate-200">
          Get Gameweek alerts —{" "}
          <span className="text-emerald-400">
            deadline reminders, score updates &amp; more.
          </span>
        </span>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {/* Enable button */}
          <button
            id="push-enable-btn"
            type="button"
            disabled={state === "loading"}
            onClick={handleEnable}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors cursor-pointer"
          >
            {state === "loading" ? (
              <>
                {/* Spinner */}
                <svg
                  className="animate-spin h-3 w-3 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v8H4z"
                  />
                </svg>
                Enabling…
              </>
            ) : (
              "Enable Gameweek Alerts"
            )}
          </button>

          {/* Dismiss button */}
          <button
            id="push-dismiss-btn"
            type="button"
            onClick={handleDismiss}
            className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer px-1 py-1 rounded"
            aria-label="Not now"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

export default PushNotificationPrompt;
