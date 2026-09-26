"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { redirectToGoogleSignIn, safeReturnTo } from "@/lib/googleAuth";
import { IconFootball, IconGoogle, IconAlertCircle, IconCheck } from "@/components/ui/Icons";
import { Button } from "@/components/ui/Button";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, isAuthenticated } = useAuth();

  const requestedReturnTo = searchParams.get("returnTo");
  const returnTo = requestedReturnTo ? safeReturnTo(requestedReturnTo) : "/team";

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // If already authenticated, redirect
  useEffect(() => {
    if (isAuthenticated) {
      router.replace(returnTo);
    }
  }, [isAuthenticated, router, returnTo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    // Client-side validations
    if (!username.trim() || !email.trim() || !password) {
      setErrorMsg("Please complete all required fields.");
      return;
    }

    if (username.trim().length < 3 || username.trim().length > 20) {
      setErrorMsg("Username must be between 3 and 20 characters.");
      return;
    }

    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (!usernameRegex.test(username.trim())) {
      setErrorMsg("Username can only contain letters, numbers, and underscores.");
      return;
    }

    if (password.length < 8) {
      setErrorMsg("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMsg("Passwords do not match.");
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
      }>("/api/v1/auth/register", {
        email: email.trim(),
        password,
        username: username.trim(),
        name: name.trim() || undefined,
      });

      if (response?.data?.token && response?.data?.user) {
        login(response.data.token, response.data.user);
        router.push(returnTo);
      } else {
        setErrorMsg("Account created, but failed to obtain authentication session.");
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMsg(err.message || "Registration failed.");
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg("Failed to register. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignup = () => {
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
          Register Manager Account
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Build your £100m squad, lead leagues, and play for verified USDC rewards.
        </p>
      </div>

      {/* Registration Card */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 sm:p-8 shadow-2xl relative overflow-hidden">
        {/* Pitch line accent */}
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
          onClick={handleGoogleSignup}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-100 font-medium text-sm transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500/50 shadow-sm group"
        >
          <IconGoogle className="w-5 h-5 flex-shrink-0 group-hover:scale-105 transition-transform" />
          <span>Continue with Google</span>
        </button>

        {/* Divider */}
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-800" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-pitch-surface px-3 text-slate-500 font-bold tracking-wider">
              Or fill manager details
            </span>
          </div>
        </div>

        {/* Registration Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="name"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5"
            >
              Manager Name <span className="text-slate-500 font-normal lowercase">(optional)</span>
            </label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stanley Davis"
              className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
          </div>

          <div>
            <label
              htmlFor="username"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5"
            >
              Username <span className="text-red-400">*</span>
            </label>
            <input
              id="username"
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="stanley_xi"
              className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors font-mono"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              3-20 characters, letters, numbers, and underscores only.
            </p>
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5"
            >
              Email Address <span className="text-red-400">*</span>
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
                Password <span className="text-red-400">*</span>
              </label>
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
          </div>

          <div>
            <label
              htmlFor="confirmPassword"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5"
            >
              Confirm Password <span className="text-red-400">*</span>
            </label>
            <input
              id="confirmPassword"
              type={showPassword ? "text" : "password"}
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-slate-700/80 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
          </div>

          <div className="pt-2">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full justify-center text-sm font-bold tracking-wide uppercase"
              isLoading={isSubmitting}
            >
              Create Account & Pick Squad
            </Button>
          </div>
        </form>

        {/* Footer info */}
        <div className="mt-6 text-center text-xs text-slate-400">
          Already have an account?{" "}
          <Link
            href={`/login${returnTo !== "/team" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
            className="text-emerald-400 hover:text-emerald-300 font-semibold transition-colors"
          >
            Sign In
          </Link>
        </div>
      </div>

      {/* Security note */}
      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-500">
        <IconCheck className="w-4 h-4 text-emerald-500" />
        <span>Bcrypt encrypted &bull; Soroban escrow ready</span>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <div className="min-h-[calc(100vh-140px)] flex items-center justify-center py-10 px-4">
      <Suspense
        fallback={
          <div className="text-center py-20 text-slate-400">
            <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-sm">Preparing Registration Form...</p>
          </div>
        }
      >
        <RegisterForm />
      </Suspense>
    </div>
  );
}
