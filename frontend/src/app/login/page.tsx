"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/context/WalletContext";
import { describeStellarAuthError } from "@/lib/stellarAuth";
import { api, ApiError } from "@/lib/api";
import { computeDeviceFingerprint } from "@/lib/deviceFingerprint";
import { describeGoogleAuthError, redirectToGoogleSignIn, safeReturnTo } from "@/lib/googleAuth";
import {
  describePasskeyError,
  usePasskeySupport,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@/lib/passkeys";
import { IconFootball, IconGoogle, IconAlertCircle, IconCheck, IconShield } from "@/components/ui/Icons";
import { Button } from "@/components/ui/Button";

interface SignedInUser {
  id: string;
  email: string;
  username: string;
  name?: string | null;
  createdAt: string;
}

/**
 * Login answer: a session, a step-up code for an unrecognized device (issue #331),
 * or a passkey confirmation for an account protected by a passkey (issue #273).
 */
type LoginResponse = {
  success: boolean;
  message: string;
  data:
    | { token: string; user: SignedInUser }
    | { challengeRequired: true; challengeId: string; method: "EMAIL_OTP"; expiresAt: string }
    | { challengeRequired: true; method: "WEBAUTHN"; options: PublicKeyCredentialRequestOptionsJSON; expiresAt: string };
};

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message;
  return "Failed to sign in. Please verify your connection.";
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, loginWithPasskey, loginWithStellar, isAuthenticated } = useAuth();
  const { wallets, publicKey, connect, signTransaction, isConnecting } = useWallet();
  const [showWalletPicker, setShowWalletPicker] = useState(false);

  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const urlError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(describeGoogleAuthError(urlError));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [passkeyOptions, setPasskeyOptions] = useState<PublicKeyCredentialRequestOptionsJSON | null>(null);
  const canUsePasskey = usePasskeySupport();

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
      const response = await api.post<LoginResponse>("/api/v1/auth/login", {
        email: email.trim(),
        password,
        deviceFingerprint: (await computeDeviceFingerprint()) ?? undefined,
      });

      const data = response?.data;
      if (data && "challengeRequired" in data) {
        if (data.method === "WEBAUTHN") {
          setPasskeyOptions(data.options);
        } else {
          setChallengeId(data.challengeId);
          setCode("");
        }
      } else if (data?.token && data.user) {
        login(data.token, data.user);
        router.push(returnTo);
      } else {
        setErrorMsg("Unexpected response from authentication service.");
      }
    } catch (err: unknown) {
      setErrorMsg(describeError(err, "Invalid credentials."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!/^\d{6}$/.test(code)) {
      setErrorMsg("Enter the 6-digit code from the email we sent you.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await api.post<{ data: { token: string; user: SignedInUser } }>(
        "/api/v1/auth/login/verify",
        { challengeId, code }
      );
      login(response.data.token, response.data.user);
      router.push(returnTo);
    } catch (err: unknown) {
      setErrorMsg(describeError(err, "Verification failed."));
      // An expired or exhausted challenge cannot be retried: start over
      if (err instanceof ApiError && /sign in again/i.test(err.message)) {
        setChallengeId(null);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Usernameless passkey sign-in, or the passkey step-up after a password (`stepUpOptions`). */
  const handlePasskeySignIn = async (stepUpOptions?: PublicKeyCredentialRequestOptionsJSON) => {
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      await loginWithPasskey(stepUpOptions);
      router.push(returnTo);
    } catch (err: unknown) {
      setErrorMsg(describePasskeyError(err, "Passkey sign-in failed."));
      // The server consumed this single-use challenge: the password step must be repeated
      if (stepUpOptions && err instanceof ApiError) {
        setPasskeyOptions(null);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /** SEP-0010: the connected wallet signs a server challenge instead of entering a password. */
  const handleStellarSignIn = async () => {
    if (!publicKey) return;
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      await loginWithStellar(publicKey, signTransaction);
      router.push(returnTo);
    } catch (err: unknown) {
      setErrorMsg(describeStellarAuthError(err, "Stellar wallet sign-in failed."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWalletPick = async (walletId: Parameters<typeof connect>[0]) => {
    setErrorMsg(null);
    try {
      await connect(walletId);
      setShowWalletPicker(false);
    } catch (err: unknown) {
      setErrorMsg(describeStellarAuthError(err, "Could not connect to the wallet."));
    }
  };

  const handleGoogleLogin = () => {
    redirectToGoogleSignIn(returnTo);
  };

  return (
    <div className="w-full max-w-md mx-auto">
      {/* Brand Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-purple-50 border border-purple-200/80 text-[#37003c] mb-4 shadow-sm">
          <IconFootball className="w-7 h-7 text-[#37003c]" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900 uppercase font-sans">
          Manager Sign In
        </h1>
        <p className="mt-1.5 text-xs sm:text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
          Access your FantasyXI squad, enter leagues, and compete for USDC prizes.
        </p>
      </div>

      {/* Login Card */}
      <div className="bg-white border border-slate-200/80 rounded-3xl p-6 sm:p-8 shadow-sm relative overflow-hidden">
        {/* Subtle top brand accent */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#37003c] via-[#4d0c5a] to-[#00ff87]" />

        {/* Error Banner */}
        {errorMsg && (
          <div className="mb-6 p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-3 text-rose-700 text-xs font-semibold animate-shake">
            <IconAlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 leading-snug">{errorMsg}</div>
          </div>
        )}

        {challengeId ? (
          <form onSubmit={handleVerifyCode} className="space-y-4" data-testid="login-challenge">
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              We don&apos;t recognize this device. Enter the 6-digit code we just emailed to{" "}
              <span className="font-bold text-slate-900">{email.trim()}</span> to finish signing in.
            </p>
            <div>
              <label
                htmlFor="code"
                className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5"
              >
                Verification Code
              </label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                required
                value={code}
                // Strip before capping, so a pasted "123 456" keeps all six digits
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 text-lg tracking-[0.5em] font-mono focus:outline-none focus:border-[#37003c] focus:ring-1 focus:ring-[#37003c] transition-colors text-center"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full justify-center text-xs font-bold tracking-wide uppercase"
              isLoading={isSubmitting}
            >
              Verify &amp; Sign In
            </Button>
            <button
              type="button"
              onClick={() => {
                setChallengeId(null);
                setErrorMsg(null);
              }}
              className="w-full text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors"
            >
              Back to sign in
            </button>
          </form>
        ) : passkeyOptions ? (
          <div className="space-y-4" data-testid="login-passkey-challenge">
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              Your account is protected with a passkey. Confirm it&apos;s you with Face ID, Touch ID, Windows
              Hello or your security key to finish signing in.
            </p>
            <Button
              type="button"
              variant="primary"
              size="lg"
              className="w-full justify-center text-xs font-bold tracking-wide uppercase"
              isLoading={isSubmitting}
              onClick={() => handlePasskeySignIn(passkeyOptions)}
            >
              Verify with Passkey
            </Button>
            <button
              type="button"
              onClick={() => {
                setPasskeyOptions(null);
                setErrorMsg(null);
              }}
              className="w-full text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <>
            {/* Passkey sign-in (usernameless, issue #273) */}
            {canUsePasskey && (
              <button
                type="button"
                onClick={() => handlePasskeySignIn()}
                disabled={isSubmitting}
                className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 mb-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition-all focus:outline-none focus:ring-2 focus:ring-[#37003c]/20 shadow-2xs group disabled:opacity-60 cursor-pointer"
              >
                <IconShield className="w-4 h-4 flex-shrink-0 text-[#37003c] group-hover:scale-105 transition-transform" />
                <span>Sign in with a passkey</span>
              </button>
            )}

            {/* Stellar wallet sign-in (SEP-0010, issue #562) */}
            {publicKey ? (
              <button
                type="button"
                onClick={handleStellarSignIn}
                disabled={isSubmitting}
                data-testid="login-stellar-sign"
                className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 mb-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition-all focus:outline-none focus:ring-2 focus:ring-[#37003c]/20 shadow-2xs disabled:opacity-60 cursor-pointer"
              >
                <IconShield className="w-4 h-4 flex-shrink-0 text-[#37003c]" />
                <span>
                  Sign in as {publicKey.slice(0, 4)}...{publicKey.slice(-4)}
                </span>
              </button>
            ) : (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => setShowWalletPicker((open) => !open)}
                  disabled={isSubmitting || isConnecting}
                  data-testid="login-stellar-connect"
                  className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition-all focus:outline-none focus:ring-2 focus:ring-[#37003c]/20 shadow-2xs disabled:opacity-60 cursor-pointer"
                >
                  <IconShield className="w-4 h-4 flex-shrink-0 text-[#37003c]" />
                  <span>Sign in with a Stellar wallet</span>
                </button>
                {showWalletPicker && (
                  <div className="mt-2 grid grid-cols-2 gap-2" role="menu">
                    {wallets.map((wallet) => (
                      <button
                        key={wallet.id}
                        type="button"
                        role="menuitem"
                        onClick={() => handleWalletPick(wallet.id)}
                        className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                      >
                        {wallet.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Google OAuth Button */}
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition-all focus:outline-none focus:ring-2 focus:ring-[#37003c]/20 shadow-2xs group cursor-pointer"
            >
              <IconGoogle className="w-4 h-4 flex-shrink-0 group-hover:scale-105 transition-transform" />
              <span>Continue with Google</span>
            </button>

            {/* Tactical Divider */}
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200" />
              </div>
              <div className="relative flex justify-center text-[10px] uppercase">
                <span className="bg-white px-3 text-slate-400 font-bold tracking-wider">
                  Or with email
                </span>
              </div>
            </div>

            {/* Standard Email/Password Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5"
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
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-xs focus:outline-none focus:border-[#37003c] focus:ring-1 focus:ring-[#37003c] transition-colors"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="password"
                    className="block text-[10px] font-bold uppercase tracking-wider text-slate-500"
                  >
                    Password
                  </label>
                  <span className="text-[10px] text-slate-400">Min. 8 characters</span>
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
                    className="w-full px-3.5 py-2.5 pr-12 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-xs focus:outline-none focus:border-[#37003c] focus:ring-1 focus:ring-[#37003c] transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400 hover:text-slate-700 transition-colors"
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
                  className="w-full justify-center text-xs font-bold tracking-wide uppercase"
                  isLoading={isSubmitting}
                >
                  Sign In to Dugout
                </Button>
              </div>
              <div className="text-center">
                <Link href="/recover-passkey" className="text-xs font-bold text-[#37003c] hover:underline">
                  Lost access to your passkey?
                </Link>
              </div>
            </form>
          </>
        )}

        {/* Footer info */}
        <div className="mt-6 text-center text-xs text-slate-500">
          New to FantasyXI?{" "}
          <Link
            href={`/register${returnTo !== "/" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
            className="text-[#37003c] hover:underline font-bold transition-colors"
          >
            Create Manager Account
          </Link>
        </div>
      </div>

      {/* Security note */}
      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-400">
        <IconCheck className="w-3.5 h-3.5 text-emerald-600" />
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
