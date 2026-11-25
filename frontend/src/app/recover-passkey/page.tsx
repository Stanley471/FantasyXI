"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/context/AuthContext";
import { recoverPasskeyAccount } from "@/lib/passkeyRecovery";
import { ApiError } from "@/lib/api";

export default function RecoverPasskeyPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const recover = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await recoverPasskeyAccount(email, phrase);
      login(session.token, session.user);
      router.replace("/profile?recovered=passkey");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "Recovery failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-md px-4 py-12">
      <h1 className="text-2xl font-black text-slate-900">Recover passkey access</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        A successful recovery revokes every existing passkey and active session.
      </p>
      {error && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      <form onSubmit={recover} className="mt-6 space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <label className="block text-xs font-bold text-slate-700">
          Account email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900"
          />
        </label>
        <label className="block text-xs font-bold text-slate-700">
          12-word recovery phrase
          <textarea
            autoComplete="off"
            required
            rows={4}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            className="mt-1.5 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-900"
          />
        </label>
        <Button type="submit" size="lg" isLoading={submitting} className="w-full">
          Recover account
        </Button>
      </form>
      <Link href="/login" className="mt-5 block text-center text-xs font-bold text-[#37003c] hover:underline">
        Back to sign in
      </Link>
    </main>
  );
}
