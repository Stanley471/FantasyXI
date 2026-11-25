"use client";

import React, { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { IconShield, IconCheck, IconAlertCircle } from "@/components/ui/Icons";

type Notice = { kind: "success" | "error"; text: string } | null;

/**
 * Leaderboard anonymization toggle (issue #511).
 *
 * When on, public standings show this manager as a deterministic alias
 * ("Manager #XXXX") instead of their username; the real name stays visible
 * only to the manager themselves and platform admins. The toggle only ever
 * updates the signed-in manager's own account: the endpoint derives the
 * target from the token, never from the request body.
 */
export function PrivacySettings() {
  const { user, refreshUser } = useAuth();

  const [isAnonymous, setIsAnonymous] = useState<boolean>(Boolean(user?.isAnonymous));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // The account loads asynchronously, so the toggle follows the server flag
  // whenever it changes (adjusting state during render, per the React docs
  // pattern for deriving state from props).
  const [prevUserFlag, setPrevUserFlag] = useState<boolean>(Boolean(user?.isAnonymous));
  if (Boolean(user?.isAnonymous) !== prevUserFlag) {
    setPrevUserFlag(Boolean(user?.isAnonymous));
    setIsAnonymous(Boolean(user?.isAnonymous));
  }

  const handleToggle = async () => {
    const next = !isAnonymous;
    setSaving(true);
    setNotice(null);
    setIsAnonymous(next);
    try {
      await api.patch<{ success: boolean; data: { isAnonymous: boolean } }>(
        "/api/v1/auth/me/privacy",
        { isAnonymous: next }
      );
      await refreshUser();
      setNotice({
        kind: "success",
        text: next
          ? "Anonymous mode on. You now appear under your manager alias in public standings."
          : "Anonymous mode off. Your username is visible in public standings again.",
      });
    } catch (error) {
      setIsAnonymous(!next);
      setNotice({
        kind: "error",
        text:
          error instanceof ApiError
            ? error.message
            : "Could not update your privacy setting. Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white border border-slate-200/80 rounded-3xl p-6 sm:p-8 shadow-sm space-y-4">
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-tight text-slate-900">
        <IconShield className="w-4 h-4 text-emerald-700" />
        <span>Privacy &amp; Anonymity</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-slate-900">Anonymous mode</p>
          <p className="text-xs text-slate-500 mt-1">
            Hide your username in public standings and leaderboards. Other managers see your
            manager alias instead; your real name stays visible only to you and platform admins.
          </p>
          {isAnonymous && user?.anonymousAlias && (
            <p className="mt-2 text-xs font-mono font-bold text-emerald-700">
              You appear as {user.anonymousAlias} in public standings.
            </p>
          )}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={isAnonymous}
          aria-label="Anonymous mode"
          disabled={saving}
          onClick={handleToggle}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#37003c] disabled:opacity-50 ${
            isAnonymous ? "bg-emerald-600" : "bg-slate-300"
          }`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
              isAnonymous ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {notice && (
        <p
          className={`flex items-center gap-1.5 text-xs font-medium ${
            notice.kind === "success" ? "text-emerald-700" : "text-red-600"
          }`}
        >
          {notice.kind === "success" ? (
            <IconCheck className="w-3.5 h-3.5" />
          ) : (
            <IconAlertCircle className="w-3.5 h-3.5" />
          )}
          <span>{notice.text}</span>
        </p>
      )}
    </section>
  );
}
