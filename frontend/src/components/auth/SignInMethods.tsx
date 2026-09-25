"use client";

import React, { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { describeGoogleAuthError, redirectToGoogleLink } from "@/lib/googleAuth";
import { Button } from "@/components/ui/Button";
import { IconGoogle, IconShield, IconCheck, IconAlertCircle } from "@/components/ui/Icons";

type Notice = { kind: "success" | "error"; text: string } | null;

/** Result of returning from Google's consent screen (?linked=google or ?linkError=<code>). */
function readLinkResult(): Notice {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("linked") === "google") {
    return { kind: "success", text: "Google account linked. You can now sign in with either method." };
  }
  const linkError = describeGoogleAuthError(params.get("linkError"));
  return linkError ? { kind: "error", text: linkError } : null;
}

const inputClass =
  "w-full px-3 py-2 bg-slate-950/70 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors";

/**
 * Lets a manager see and manage how they sign in: email & password and/or
 * Google. Either method opens the same account.
 */
export function SignInMethods() {
  const { user, refreshUser } = useAuth();
  const hasPassword = Boolean(user?.authProviders?.password);
  const hasGoogle = Boolean(user?.authProviders?.google);

  const [notice, setNotice] = useState<Notice>(readLinkResult);
  const [busy, setBusy] = useState<"link" | "unlink" | "password" | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // After returning from Google: reload the profile and drop the result from the URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("linked") && !params.has("linkError")) return;
    if (params.get("linked") === "google") {
      refreshUser();
    }
    window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const errorText = (err: unknown, fallback: string) =>
    err instanceof ApiError ? err.message : fallback;

  const handleLink = async () => {
    setNotice(null);
    setBusy("link");
    try {
      await redirectToGoogleLink();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, "Could not start linking Google.") });
      setBusy(null);
    }
  };

  const handleUnlink = async () => {
    setNotice(null);
    setBusy("unlink");
    try {
      await api.del("/api/v1/auth/google/link");
      await refreshUser();
      setNotice({ kind: "success", text: "Google account unlinked." });
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, "Could not unlink Google.") });
    } finally {
      setBusy(null);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    if (newPassword.length < 8) {
      setNotice({ kind: "error", text: "Password must be at least 8 characters long." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setNotice({ kind: "error", text: "Passwords do not match." });
      return;
    }

    setBusy("password");
    try {
      await api.post("/api/v1/auth/password", {
        password: newPassword,
        ...(hasPassword && { currentPassword }),
      });
      await refreshUser();
      setNotice({
        kind: "success",
        text: hasPassword ? "Password changed." : "Password set. You can now sign in with your email too.",
      });
      setShowPasswordForm(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, "Could not update your password.") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-md space-y-4">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
        <IconShield className="w-4 h-4 text-emerald-400" />
        <span>Sign-in Methods</span>
      </div>

      {notice && (
        <div
          role="status"
          className={`p-3 rounded-lg border flex items-start gap-2 text-sm ${
            notice.kind === "success"
              ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-300"
              : "bg-red-950/40 border-red-500/40 text-red-300"
          }`}
        >
          {notice.kind === "success" ? (
            <IconCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : (
            <IconAlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="divide-y divide-slate-800/60 text-xs">
        {/* Email & password */}
        <div className="py-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-slate-200 font-semibold">Email &amp; password</p>
              <p className="text-slate-500 mt-0.5">{hasPassword ? user?.email : "No password set"}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowPasswordForm((open) => !open)}
            >
              {showPasswordForm ? "Cancel" : hasPassword ? "Change password" : "Set password"}
            </Button>
          </div>

          {showPasswordForm && (
            <form onSubmit={handlePasswordSubmit} className="grid gap-2 sm:grid-cols-3">
              {hasPassword && (
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Current password"
                  aria-label="Current password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className={inputClass}
                  required
                />
              )}
              <input
                type="password"
                autoComplete="new-password"
                placeholder="New password (min. 8)"
                aria-label="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClass}
                required
              />
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm new password"
                aria-label="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClass}
                required
              />
              <div className="sm:col-span-3">
                <Button type="submit" size="sm" isLoading={busy === "password"}>
                  Save password
                </Button>
              </div>
            </form>
          )}
        </div>

        {/* Google */}
        <div className="py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <IconGoogle className="w-4 h-4 flex-shrink-0" />
            <div>
              <p className="text-slate-200 font-semibold">Google</p>
              <p className="text-slate-500 mt-0.5">
                {hasGoogle ? "Linked" : "Not linked"}
                {hasGoogle && !hasPassword && " · set a password before unlinking"}
              </p>
            </div>
          </div>
          {hasGoogle ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleUnlink}
              isLoading={busy === "unlink"}
              disabled={!hasPassword}
            >
              Unlink
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={handleLink} isLoading={busy === "link"}>
              Link Google
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

export default SignInMethods;
