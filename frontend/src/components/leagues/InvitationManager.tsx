"use client";

import React, { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { CreatedLeagueInvitation, LeagueInvitation, LeagueInvitationState } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconCheck, IconCopy, IconAlertCircle, IconPlus } from "@/components/ui/Icons";
import { useToast } from "@/context/ToastContext";

const EXPIRY_OPTIONS = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

const STATE_BADGE: Record<LeagueInvitationState, "success" | "neutral" | "danger" | "warning"> = {
  ACTIVE: "success",
  USED: "neutral",
  REVOKED: "danger",
  EXPIRED: "warning",
};

async function fetchInvitations(leagueId: string): Promise<LeagueInvitation[]> {
  const res = await api.get<{ success: boolean; data: LeagueInvitation[] }>(
    `/api/v1/leagues/${leagueId}/invitations`
  );
  return res?.data ?? [];
}

function inviteUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/leagues/invite/${encodeURIComponent(token)}`;
}

/**
 * Lets the creator of a private league issue single-use, expiring invitation
 * links, and review or revoke the ones already issued.
 */
export const InvitationManager: React.FC<{ leagueId: string }> = ({ leagueId }) => {
  const { toast } = useToast();
  const [invitations, setInvitations] = useState<LeagueInvitation[]>([]);
  const [expiresInHours, setExpiresInHours] = useState<number>(72);
  const [created, setCreated] = useState<CreatedLeagueInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInvitations = async () => {
    try {
      setInvitations(await fetchInvitations(leagueId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load invitations.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchInvitations(leagueId)
      .then((data) => {
        if (!cancelled) setInvitations(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load invitations.");
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  const handleCreate = async () => {
    setIsCreating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await api.post<{ success: boolean; data: CreatedLeagueInvitation }>(
        `/api/v1/leagues/${leagueId}/invitations`,
        { expiresInHours }
      );
      setCreated(res.data);
      toast.success("Invitation link generated successfully!");
      await loadInvitations();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not create an invitation.";
      setError(msg);
      toast.error(msg);
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(inviteUrl(created.token));
    setCopied(true);
    toast.success("Invitation link copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async (invitationId: string) => {
    setError(null);
    try {
      await api.del(`/api/v1/leagues/${leagueId}/invitations/${invitationId}`);
      if (created?.id === invitationId) setCreated(null);
      toast.info("Invitation link revoked.");
      await loadInvitations();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not revoke the invitation.";
      setError(msg);
      toast.error(msg);
    }
  };

  return (
    <div className="bg-pitch-surface border border-pitch-border rounded-xl p-5 shadow-md space-y-4">
      <div>
        <h3 className="font-bold text-white uppercase tracking-wider text-[11px]">Invitation Links</h3>
        <p className="text-[11px] text-slate-500 mt-1">
          Each link admits one manager and expires automatically.
        </p>
      </div>

      {error && (
        <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
          <IconAlertCircle className="w-4 h-4 flex-shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          value={expiresInHours}
          onChange={(e) => setExpiresInHours(Number(e.target.value))}
          aria-label="Invitation expiry"
          className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
        >
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.hours} value={o.hours}>
              Expires in {o.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="primary"
          size="sm"
          isLoading={isCreating}
          onClick={handleCreate}
          className="text-xs uppercase font-bold"
        >
          <IconPlus className="w-3.5 h-3.5" />
          <span>New Link</span>
        </Button>
      </div>

      {created && (
        <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/30 space-y-2">
          <p className="text-[11px] text-emerald-300">
            Copy this link now. For security it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={inviteUrl(created.token)}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Invitation link"
              className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-200 font-mono text-[11px]"
            />
            <Button type="button" variant="secondary" size="sm" onClick={handleCopy} title="Copy link">
              {copied ? <IconCheck className="w-3.5 h-3.5 text-emerald-400" /> : <IconCopy className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      )}

      {invitations.length > 0 && (
        <ul className="divide-y divide-slate-800/80 text-xs">
          {invitations.map((inv) => (
            <li key={inv.id} className="py-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <Badge variant={STATE_BADGE[inv.state]}>{inv.state}</Badge>
                <span className="ml-2 text-slate-400">
                  {inv.state === "USED" && inv.usedBy
                    ? `by ${inv.usedBy.username}`
                    : `expires ${new Date(inv.expiresAt).toLocaleString()}`}
                </span>
              </div>
              {inv.state === "ACTIVE" && (
                <button
                  type="button"
                  onClick={() => handleRevoke(inv.id)}
                  className="text-[11px] font-semibold text-rose-400 hover:text-rose-300"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
