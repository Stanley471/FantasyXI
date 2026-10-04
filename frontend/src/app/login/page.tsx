"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { describeGoogleAuthError, redirectToGoogleSignIn, safeReturnTo } from "@/lib/googleAuth";
import { IconFootball, IconGoogle, IconAlertCircle, IconCheck } from "@/components/ui/Icons";
import { Button } from "@/components/ui/Button";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, isAuthenticated } = useAuth();

  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const urlError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(describeGoogleAuthError(urlError));
  const [isSubmitting, setIsSubmitting] = useState(false);

  // If already authenticated, redirect immediately
  useEffect(() => {
    if (isAuthenticated) {
      router.replace(returnTo);
    }
  }, [isAuthenticated, router, returnTo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!email.trim() || !password) {
      setErrorMsg("Please provide both email and password.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await api.post<{
        success: boolean;
        message: string;
        data: {
          token: string;
          user: {
            id: string;
            email: string;
            username: string;
            name?: string | null;
            createdAt: string;
          };
        };
      }>("/api/v1/auth/login", {
        email: email.trim(),
        password,
      });

      if (response?.data?.token && response?.data?.user) {
        login(response.data.token, response.data.user);
        router.push(returnTo);
      } else {
        setErrorMsg("Unexpected response from authentication service.");
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMsg(err.message || "Invalid credentials.");
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg("Failed to sign in. Please verify your connection.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleLogin = () => {
    redirectToGoogleSignIn(returnTo);
  };

  return (
    <div className="w-full max-w-md mx-auto">
      {/* Brand Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mb-4 shadow-lg shadow-emerald-950/40">
          <IconFootball className="w-7 h-7" />
        </div>
        <h1 className="text-2xl font-black tracking-tight text-white uppercase font-sans">
          Manager Sign In
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Access your FantasyXI squad, enter leagues, and compete for USDC prizes.
        </p>
      </div>

      {/* Login Card */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 sm:p-8 shadow-2xl relative overflow-hidden">
        {/* Subtle top pitch-line glow */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-emerald-400 to-emerald-600" />

        {/* Error Banner */}
        {errorMsg && (
          <div className="mb-6 p-3.5 rounded-lg bg-red-950/40 border border-red-500/40 flex items-start gap-3 text-red-300 text-sm animate-shake">
            <IconAlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 font-medium leading-snug">{errorMsg}</div>
          </div>
        )}

        {/* Google OAuth Button */}
        <button
          type="button"
          onClick={handleGoogleLogin}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-100 font-medium text-sm transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500/50 shadow-sm group"
        >
          <IconGoogle className="w-5 h-5 flex-shrink-0 group-hover:scale-105 transition-transform" />
          <span>Continue with Google</span>
        </button>

        {/* Tactical Divider */}
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-800" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-pitch-surface px-3 text-slate-500 font-bold tracking-wider">
              Or with email
            </span>
          </div>
        </div>

        {/* Standard Email/Password Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5"
            >
              Email Address
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="manager@fantasyxi.com"
              className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="password"
                className="block text-xs font-semibold uppercase tracking-wider text-slate-300"
              >
                Password
              </label>
              <span className="text-xs text-slate-500">Min. 8 characters</span>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 pr-10 bg-slate-950/70 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div className="pt-2">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full justify-center text-sm font-bold tracking-wide uppercase"
              isLoading={isSubmitting}
            >
              Sign In to Dugout
            </Button>
          </div>
        </form>

        {/* Footer info */}
        <div className="mt-6 text-center text-xs text-slate-400">
          New to FantasyXI?{" "}
          <Link
            href={`/register${returnTo !== "/" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
            className="text-emerald-400 hover:text-emerald-300 font-semibold transition-colors"
          >
            Create Manager Account
          </Link>
        </div>
      </div>

      {/* Security note */}
      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-500">
        <IconCheck className="w-4 h-4 text-emerald-500" />
        <span>JWT session secured &bull; Stellar USDC escrow enabled</span>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-[calc(100vh-140px)] flex items-center justify-center py-10 px-4">
      <Suspense
        fallback={
          <div className="text-center py-20 text-slate-400">
            <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-sm">Loading Dugout...</p>
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  );
}
