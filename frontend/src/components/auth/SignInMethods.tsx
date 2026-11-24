"use client";

import React, { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { describeGoogleAuthError, redirectToGoogleLink } from "@/lib/googleAuth";
import {
  deletePasskey,
  describePasskeyError,
  listPasskeys,
  registerPasskey,
  usePasskeySupport,
  type Passkey,
} from "@/lib/passkeys";
import { Button } from "@/components/ui/Button";
import { IconGoogle, IconShield, IconCheck, IconAlertCircle } from "@/components/ui/Icons";
import { configurePasskeyRecovery } from "@/lib/passkeyRecovery";

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
  "w-full px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-xs focus:outline-none focus:border-[#37003c] focus:ring-1 focus:ring-[#37003c] transition-colors";

/**
 * Lets a manager see and manage how they sign in: email & password, Google
 * and/or passkeys (issue #273). Every method opens the same account; a
 * registered passkey also confirms every password sign-in.
 */
export function SignInMethods() {
  const { user, refreshUser } = useAuth();
  const hasPassword = Boolean(user?.authProviders?.password);
  const hasGoogle = Boolean(user?.authProviders?.google);

  const [notice, setNotice] = useState<Notice>(readLinkResult);
  const [busy, setBusy] = useState<"link" | "unlink" | "password" | "passkey" | "recovery" | `remove:${string}` | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const canUsePasskey = usePasskeySupport();

  useEffect(() => {
    listPasskeys()
      .then(setPasskeys)
      .catch(() => setPasskeys([]));
  }, []);
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

  const handleAddPasskey = async () => {
    setNotice(null);
    setBusy("passkey");
    try {
      const added = await registerPasskey();
      setPasskeys((current) => [...current, added]);
      setNotice({
        kind: "success",
        text: "Passkey added. Use it to sign in without a password; it will also confirm password sign-ins.",
      });
    } catch (err) {
      setNotice({ kind: "error", text: describePasskeyError(err, "Could not add a passkey.") });
    } finally {
      setBusy(null);
    }
  };

  const handleRemovePasskey = async (id: string) => {
    setNotice(null);
    setBusy(`remove:${id}`);
    try {
      await deletePasskey(id);
      setPasskeys((current) => current.filter((passkey) => passkey.id !== id));
      setNotice({ kind: "success", text: "Passkey removed." });
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, "Could not remove the passkey.") });
    } finally {
      setBusy(null);
    }
  };

  const handleRecoverySetup = async () => {
    setNotice(null);
    setBusy("recovery");
    try {
      const phrase = await configurePasskeyRecovery();
      setRecoveryPhrase(phrase);
      setNotice({ kind: "success", text: "Recovery phrase created. Store it offline before leaving this page." });
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, "Could not create a recovery phrase.") });
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
    <section className="bg-white border border-slate-200/80 rounded-3xl p-6 sm:p-8 shadow-sm space-y-4">
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-tight text-slate-900">
        <IconShield className="w-4 h-4 text-emerald-700" />
        <span>Sign-in Methods</span>
      </div>

      {notice && (
        <div
          role="status"
          className={`p-3.5 rounded-2xl border flex items-start gap-2 text-xs font-medium ${
            notice.kind === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-rose-50 border-rose-200 text-rose-900"
          }`}
        >
          {notice.kind === "success" ? (
            <IconCheck className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-600" />
          ) : (
            <IconAlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-rose-600" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="divide-y divide-slate-100 text-xs">
        {/* Email & password */}
        <div className="py-3.5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-slate-900 font-bold">Email &amp; password</p>
              <p className="text-slate-400 mt-0.5 font-medium">{hasPassword ? user?.email : "No password set"}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowPasswordForm((open) => !open)}
              className="text-xs font-bold uppercase tracking-wider rounded-xl"
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
                <Button type="submit" size="sm" isLoading={busy === "password"} className="rounded-xl font-bold uppercase tracking-wider text-xs">
                  Save password
                </Button>
              </div>
            </form>
          )}
        </div>

        {/* Google */}
        <div className="py-3.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <IconGoogle className="w-4 h-4 flex-shrink-0" />
            <div>
              <p className="text-slate-900 font-bold">Google</p>
              <p className="text-slate-400 mt-0.5 font-medium">
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
              className="rounded-xl text-xs font-bold uppercase tracking-wider"
            >
              Unlink
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={handleLink} isLoading={busy === "link"} className="rounded-xl text-xs font-bold uppercase tracking-wider">
              Link Google
            </Button>
          )}
        </div>

        {/* Passkeys */}
        <div className="py-3.5 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <IconShield className="w-4 h-4 flex-shrink-0 text-emerald-700" />
              <div>
                <p className="text-slate-900 font-bold">Passkeys</p>
                <p className="text-slate-400 mt-0.5 font-medium">
                  {passkeys.length > 0
                    ? `${passkeys.length} registered · required after your password`
                    : canUsePasskey
                      ? "Face ID, Touch ID, Windows Hello or a security key"
                      : "Not supported by this browser"}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleAddPasskey}
              isLoading={busy === "passkey"}
              disabled={!canUsePasskey}
              className="rounded-xl text-xs font-bold uppercase tracking-wider"
            >
              Add passkey
            </Button>
          </div>

          {passkeys.length > 0 && (
            <ul className="space-y-2 pt-1">
              {passkeys.map((passkey) => (
                <li
                  key={passkey.id}
                  className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 border border-slate-200/80 px-3.5 py-2.5"
                >
                  <div>
                    <p className="text-slate-900 font-bold">{passkey.name}</p>
                    <p className="text-slate-400 font-medium text-[11px]">
                      {passkey.backedUp ? "Synced" : "This device only"} · added{" "}
                      {new Date(passkey.createdAt).toLocaleDateString()}
                      {passkey.lastUsedAt && ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleRemovePasskey(passkey.id)}
                    isLoading={busy === `remove:${passkey.id}`}
                    className="rounded-xl text-xs font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-slate-200"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {passkeys.length > 0 && !recoveryPhrase && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRecoverySetup}
              isLoading={busy === "recovery"}
              className="rounded-xl text-xs font-bold"
            >
              Create recovery phrase
            </Button>
          )}
          {recoveryPhrase && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4" role="status">
              <p className="text-xs font-bold text-amber-950">Store this phrase offline. It is shown only once.</p>
              <p className="mt-2 select-all break-words font-mono text-sm leading-6 text-slate-900">{recoveryPhrase}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 rounded-xl text-xs font-bold"
                onClick={() => navigator.clipboard.writeText(recoveryPhrase)}
              >
                Copy recovery phrase
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default SignInMethods;
