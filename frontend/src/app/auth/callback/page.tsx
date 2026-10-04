"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { safeReturnTo } from "@/lib/googleAuth";
import { IconFootball, IconAlertCircle } from "@/components/ui/Icons";
import { Button } from "@/components/ui/Button";

/**
 * Reads the Google sign-in result. The backend puts the token in the URL
 * fragment (never sent to servers or leaked via Referer); the query string is
 * still accepted for links issued before that change.
 */
function readCallbackParams(): URLSearchParams {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  return fragment.has("token") ? fragment : new URLSearchParams(window.location.search);
}

function AuthCallbackContent() {
  const router = useRouter();
  const { setAuthToken } = useAuth();
  const handled = useRef(false);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The token is removed from the URL below, so only handle it once
    if (handled.current) return;
    handled.current = true;

    const params = readCallbackParams();
    const token = params.get("token");
    const returnTo = safeReturnTo(params.get("returnTo"));

    // Keep the token out of browser history
    window.history.replaceState(null, "", window.location.pathname);

    // Store token and populate current user
    (token ? setAuthToken(token) : Promise.reject(new Error("missing token")))
      .then(() => {
        router.replace(returnTo);
      })
      .catch((err) => {
        if (!token) {
          setError("No authentication token found in callback. Please try signing in again.");
          return;
        }
        console.error("Failed to authenticate callback session:", err);
        setError("Failed to establish authenticated session. The token may have expired.");
      });
  }, [setAuthToken, router]);

  if (error) {
    return (
      <div className="w-full max-w-md mx-auto p-6 bg-pitch-surface border border-pitch-border rounded-xl shadow-2xl text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-950/40 border border-red-500/30 text-red-400 mb-4">
          <IconAlertCircle className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-white mb-2">Authentication Failed</h2>
        <p className="text-sm text-slate-400 mb-6">{error}</p>
        <Link href="/login">
          <Button variant="primary" className="w-full justify-center uppercase tracking-wide">
            Back to Sign In
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto p-8 bg-pitch-surface border border-pitch-border rounded-xl shadow-2xl text-center">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mb-4 animate-pulse">
        <IconFootball className="w-8 h-8 animate-spin" />
      </div>
      <h2 className="text-lg font-bold text-white mb-1.5">Authenticating Manager...</h2>
      <p className="text-sm text-slate-400">
        Synchronizing profile and fantasy credentials. You will be redirected shortly.
      </p>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <div className="min-h-[calc(100vh-140px)] flex items-center justify-center py-10 px-4">
      <AuthCallbackContent />
    </div>
  );
}
