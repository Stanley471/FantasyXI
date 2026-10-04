"use client";

import React, { useState, useEffect, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { LeagueInvitationPreview, Squad } from "@/types";
import { LeagueStatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconAlertCircle, IconChevronLeft, IconShield } from "@/components/ui/Icons";

export default function LeagueInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const [preview, setPreview] = useState<LeagueInvitationPreview | null>(null);
  const [userSquads, setUserSquads] = useState<Squad[]>([]);
  const [selectedSquadId, setSelectedSquadId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadInvitation() {
      try {
        const res = await api.get<{ success: boolean; data: LeagueInvitationPreview }>(
          `/api/v1/leagues/invitations/${encodeURIComponent(token)}`
        );
        setPreview(res.data);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "This invitation link could not be loaded.");
      } finally {
        setIsLoading(false);
      }
    }
    loadInvitation();
  }, [token]);

  useEffect(() => {
    if (!isAuthenticated) return;
    api
      .get<{ success: boolean; data: Squad[] }>("/api/v1/squads/me")
      .then((res) => {
        setUserSquads(res?.data ?? []);
        if (res?.data?.length) setSelectedSquadId(res.data[0].id);
      })
      .catch((err) => console.error("Failed to load squads:", err));
  }, [isAuthenticated]);

  const handleAccept = async () => {
    if (!isAuthenticated) {
      router.push(`/login?returnTo=/leagues/invite/${encodeURIComponent(token)}`);
      return;
    }
    if (!selectedSquadId) {
      setError("Please select a squad to enter this league.");
      return;
    }

    setIsJoining(true);
    setError(null);
    try {
      await api.post(`/api/v1/leagues/invitations/${encodeURIComponent(token)}/accept`, {
        squadId: selectedSquadId,
      });
      router.push(`/leagues/${preview?.league.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to join the league.");
      setIsJoining(false);
    }
  };

  if (isLoading || authLoading) {
    return (
      <div className="py-24 text-center text-slate-400">
        <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-xs">Checking invitation...</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6 pb-12">
      <Link
        href="/leagues"
        className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-400 font-semibold transition-colors"
      >
        <IconChevronLeft className="w-4 h-4" />
        <span>Back to Leagues Hub</span>
      </Link>

      {!preview ? (
        <div className="py-16 text-center bg-pitch-surface border border-pitch-border rounded-xl p-8 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-red-950/40 text-red-400 flex items-center justify-center mx-auto border border-red-500/30">
            <IconAlertCircle className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-bold text-white">Invitation Unavailable</h1>
          <p className="text-xs text-slate-400">{error}</p>
          <p className="text-xs text-slate-500">Ask the league creator for a new link.</p>
        </div>
      ) : (
        <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-lg space-y-5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
                <IconShield className="w-3.5 h-3.5" />
                Private League Invitation
              </span>
              <LeagueStatusBadge status={preview.league.status} />
            </div>
            <h1 className="text-2xl font-black text-white uppercase tracking-tight">{preview.league.name}</h1>
            <p className="text-xs text-slate-400 mt-1">
              {preview.league.description || `Invited by ${preview.league.creator.username}`}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 font-mono text-xs">
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-sans">Entry Fee</span>
              <div className="font-bold text-slate-200 mt-0.5">
                {Number(preview.league.entryFee) > 0 ? `${preview.league.entryFee} USDC` : "Free"}
              </div>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-sans">Members</span>
              <div className="font-bold text-slate-200 mt-0.5">
                {preview.league.currentMembers} / {preview.league.maxMembers}
              </div>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-sans">Duration</span>
              <div className="font-bold text-slate-200 mt-0.5">
                {preview.league.startGameweek.name} &rarr; {preview.league.endGameweek.name}
              </div>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-sans">Link Expires</span>
              <div className="font-bold text-slate-200 mt-0.5">
                {new Date(preview.expiresAt).toLocaleDateString()}
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
              <IconAlertCircle className="w-4 h-4 flex-shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {isAuthenticated && (
            userSquads.length > 0 ? (
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Select Squad to Enter
                </label>
                <select
                  value={selectedSquadId}
                  onChange={(e) => setSelectedSquadId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
                >
                  {userSquads.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} (Pts: {s.totalPoints})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="p-3 rounded bg-amber-950/40 border border-amber-500/30 text-amber-300 text-xs">
                You need a registered squad before joining leagues.{" "}
                <Link href="/team" className="underline font-bold">
                  Draft squad now
                </Link>
              </div>
            )
          )}

          <Button
            type="button"
            variant="primary"
            size="md"
            isLoading={isJoining}
            disabled={isJoining || (isAuthenticated && userSquads.length === 0)}
            onClick={handleAccept}
            className="w-full justify-center uppercase font-bold tracking-wide text-xs"
          >
            {isAuthenticated ? "Accept Invitation & Join" : "Sign In to Accept"}
          </Button>
          <p className="text-[11px] text-slate-500 text-center">
            This link can be used once. Accepting it joins you to the league.
          </p>
        </div>
      )}
    </div>
  );
}
