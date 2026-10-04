"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import {
  League,
  LeagueStandingsEntry,
  Squad,
  MembershipStatus,
  LeagueStatus,
} from "@/types";
import { PrizeCalculator } from "@/components/leagues/PrizeCalculator";
import { PaymentModal } from "@/components/leagues/PaymentModal";
import { InvitationManager } from "@/components/leagues/InvitationManager";
import { getOnChainLeague, OnChainLeagueState } from "@/lib/stellar/sorobanAudit";
import { LiveMatchdayBar } from "@/components/live/LiveMatchdayBar";
import { LiveSquadModal } from "@/components/live/LiveSquadModal";
import { useLiveLeague } from "@/components/live/useLiveLeague";
import { LeagueStatusBadge, Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/context/ToastContext";
import {
  IconCheck,
  IconAlertCircle,
  IconShield,
} from "@/components/ui/Icons";

// ─── Client-side interactive standings table (used for live-update mode) ────
// This import gives us the prop-driven table for live SSE standings only.
// The static SSR standings are rendered by the async StandingsTable RSC above.
import { StandingsTable } from "@/components/leagues/StandingsTable";

interface LeagueInteractivePanelProps {
  leagueId: string;
  /** League data pre-fetched on the server and passed down as a prop. */
  initialLeague: League;
}

/**
 * LeagueInteractivePanel — 'use client' boundary.
 *
 * Handles all the stateful, user-specific, and real-time interactive logic:
 * - Join / payment flows
 * - On-chain Soroban escrow audit panel
 * - Live SSE standings (via useLiveLeague)
 * - Live squad modal
 *
 * Static league header HTML is rendered by the parent RSC page.tsx.
 */
export function LeagueInteractivePanel({
  leagueId,
  initialLeague,
}: LeagueInteractivePanelProps) {
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const { toast } = useToast();

  const [league, setLeague] = useState<League>(initialLeague);
  const [standings, setStandings] = useState<LeagueStandingsEntry[]>([]);
  const [userSquads, setUserSquads] = useState<Squad[]>([]);
  const [selectedSquadId, setSelectedSquadId] = useState<string>("");

  const [isJoining, setIsJoining] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);
  const [liveSquadUserId, setLiveSquadUserId] = useState<string | null>(null);
  const [onChainLeague, setOnChainLeague] = useState<OnChainLeagueState | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [depositEvidence, setDepositEvidence] = useState<{
    txHash: string;
    ledgerSeq?: number;
  } | null>(null);

  const escrowContractId =
    process.env.NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID ||
    "CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA";
  const usdcAssetContract =
    process.env.NEXT_PUBLIC_STELLAR_USDC_TOKEN_CONTRACT_ID ||
    process.env.NEXT_PUBLIC_STELLAR_USDC_ISSUER ||
    "";
  const stellarExpertBase = "https://stellar.expert/explorer/testnet";

  // Live matchday feed (SSE) — only active while the league is running
  const { snapshot, rankChanges, freshEventKeys, connection } = useLiveLeague(
    leagueId,
    league.status === LeagueStatus.ACTIVE
  );

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadLeagueData = useCallback(async () => {
    try {
      const lgRes = await api.get<{ success: boolean; data: League }>(
        `/api/v1/leagues/${leagueId}`
      );
      if (lgRes?.data) setLeague(lgRes.data);

      const stdRes = await api.get<{
        success: boolean;
        data: LeagueStandingsEntry[] | { standings: LeagueStandingsEntry[] };
      }>(`/api/v1/leagues/${leagueId}/standings`);
      if (stdRes?.data) {
        setStandings(
          Array.isArray(stdRes.data) ? stdRes.data : stdRes.data.standings
        );
      }

      if (isAuthenticated) {
        const squadRes = await api.get<{ success: boolean; data: Squad[] }>(
          "/api/v1/squads/me"
        );
        if (squadRes?.data && squadRes.data.length > 0) {
          setUserSquads(squadRes.data);
          setSelectedSquadId((prev) => prev || squadRes.data[0].id);
        }
      }
    } catch (err: unknown) {
      console.error("Failed to reload league:", err);
    }
  }, [leagueId, isAuthenticated]);

  // Initial data load (standings + user squads — league header came from server)
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const stdRes = await api.get<{
          success: boolean;
          data: LeagueStandingsEntry[] | { standings: LeagueStandingsEntry[] };
        }>(`/api/v1/leagues/${leagueId}/standings`);
        if (!cancelled && stdRes?.data) {
          setStandings(
            Array.isArray(stdRes.data) ? stdRes.data : stdRes.data.standings
          );
        }

        if (isAuthenticated) {
          const squadRes = await api.get<{ success: boolean; data: Squad[] }>(
            "/api/v1/squads/me"
          );
          if (!cancelled && squadRes?.data && squadRes.data.length > 0) {
            setUserSquads(squadRes.data);
            setSelectedSquadId(squadRes.data[0].id);
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          if (err instanceof ApiError) {
            setErrorMessage(err.message || "Failed to load league details.");
          } else {
            setErrorMessage("Could not load competition data.");
          }
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [leagueId, isAuthenticated]);

  // On-chain Soroban escrow audit (only for paid leagues)
  useEffect(() => {
    if (league.entryFee <= 0) return;

    let cancelled = false;
    getOnChainLeague(leagueId, { contractId: escrowContractId })
      .then((state) => {
        if (!cancelled) setOnChainLeague(state);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setOnChainLeague(null);
          setAuditError(error instanceof Error ? error.message : "RPC unavailable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [league.entryFee, leagueId, escrowContractId]);

  // ── Invite code copy ──────────────────────────────────────────────────────

  const copyInviteCode = () => {
    if (league.inviteCode) {
      navigator.clipboard.writeText(league.inviteCode);
      setCopiedCode(true);
      toast.success("League invite code copied to clipboard!");
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  // ── Join league ───────────────────────────────────────────────────────────

  const handleJoinLeague = async () => {
    if (!isAuthenticated) {
      router.push(`/login?returnTo=/leagues/${leagueId}`);
      return;
    }

    if (!selectedSquadId) {
      const msg = "Please select a squad to enter this league.";
      setErrorMessage(msg);
      toast.warning(msg);
      return;
    }

    setIsJoining(true);
    setErrorMessage(null);

    try {
      await api.post(`/api/v1/leagues/${leagueId}/join`, {
        squadId: selectedSquadId,
      });

      toast.success(`Successfully joined ${league.name}!`);
      await loadLeagueData();

      if (league.entryFee > 0) {
        setShowPaymentModal(true);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError
          ? err.message || "Failed to join league."
          : err instanceof Error
            ? err.message
            : "An unexpected error occurred.";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setIsJoining(false);
    }
  };

  // ── Derived state ─────────────────────────────────────────────────────────

  const liveStandings = snapshot?.standings ?? [];
  const displayStandings: LeagueStandingsEntry[] =
    liveStandings.length > 0
      ? liveStandings.map((live) => {
          const base = standings.find((s) => s.userId === live.userId);
          return {
            bestGameweekPoints: base?.bestGameweekPoints ?? 0,
            gameweekScores: base?.gameweekScores ?? [],
            joinedAt: base?.joinedAt ?? "",
            rank: live.rank,
            userId: live.userId,
            username: live.username,
            squadId: live.squadId,
            squadName: live.squadName,
            membershipStatus: live.membershipStatus,
            totalPoints: live.totalPoints,
          };
        })
      : standings;

  const livePoints =
    liveStandings.length > 0
      ? Object.fromEntries(liveStandings.map((s) => [s.userId, s.livePoints]))
      : undefined;

  const liveSquadEntry = liveStandings.find((s) => s.userId === liveSquadUserId);

  const myEntry = user ? standings.find((s) => s.userId === user.id) : null;
  const isMember = !!myEntry;
  const hasPaid =
    myEntry?.membershipStatus === MembershipStatus.ACTIVE || league.entryFee === 0;
  const isCreator = !!user && league.creatorId === user.id;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Invite Code widget (shown inline within the header area) */}
      {league.inviteCode && (
        <div
          id="invite-code-widget"
          className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 self-start md:self-auto"
        >
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500">
              Invite Code
            </div>
            <div className="font-mono font-bold text-white tracking-widest text-sm">
              {league.inviteCode}
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={copyInviteCode}
            className="text-xs"
            title="Copy Invite Code"
          >
            {copiedCode ? (
              <IconCheck className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </Button>
        </div>
      )}

      {/* User Status / Action Bar */}
      <div
        id="league-action-bar"
        className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div>
          {!isAuthenticated ? (
            <span className="text-xs text-slate-400">
              Sign in to join this competition with your squad.
            </span>
          ) : isMember ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-300">
                Your Status:
              </span>
              {hasPaid ? (
                <Badge variant="success" className="gap-1 font-bold">
                  <IconCheck className="w-3.5 h-3.5" />
                  <span>Entered &amp; Escrow Confirmed</span>
                </Badge>
              ) : (
                <Badge variant="warning" className="gap-1 font-bold">
                  <IconAlertCircle className="w-3.5 h-3.5" />
                  <span>Entry Pending Payment</span>
                </Badge>
              )}
            </div>
          ) : league.isPrivate ? (
            <span className="text-xs text-slate-400">
              This is a private league. Ask the creator for an invitation link
              to join.
            </span>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-300">
                Enter with Squad:
              </span>
              {userSquads.length > 0 ? (
                <select
                  value={selectedSquadId}
                  onChange={(e) => setSelectedSquadId(e.target.value)}
                  className="px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
                >
                  {userSquads.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.totalPoints} pts)
                    </option>
                  ))}
                </select>
              ) : (
                <Link
                  href="/team"
                  className="text-xs text-emerald-400 underline font-bold"
                >
                  Create a squad first &rarr;
                </Link>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isAuthenticated ? (
            <Link href={`/login?returnTo=/leagues/${leagueId}`}>
              <Button
                variant="primary"
                size="md"
                className="uppercase font-bold tracking-wide text-xs"
              >
                Sign In to Join
              </Button>
            </Link>
          ) : isMember && !hasPaid && league.entryFee > 0 ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={() => setShowPaymentModal(true)}
              className="uppercase font-bold tracking-wide text-xs bg-amber-500 hover:bg-amber-400 text-slate-950"
            >
              Pay {league.entryFee} USDC Entry Fee
            </Button>
          ) : !isMember && !league.isPrivate ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={isJoining || userSquads.length === 0}
              isLoading={isJoining}
              onClick={handleJoinLeague}
              className="uppercase font-bold tracking-wide text-xs"
            >
              Join League
            </Button>
          ) : null}
        </div>
      </div>

      {/* Error banner */}
      {errorMessage && (
        <div
          id="league-error-banner"
          className="p-3.5 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2.5 animate-shake"
        >
          <IconAlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <span className="font-medium">{errorMessage}</span>
        </div>
      )}

      {/* Live matchday bar */}
      {league.status === LeagueStatus.ACTIVE && (
        <LiveMatchdayBar
          snapshot={snapshot}
          connection={connection}
          freshEventKeys={freshEventKeys}
        />
      )}

      {/* Right sidebar: Prize payout, Escrow audit, Rules, Invitations */}
      <div id="league-sidebar" className="space-y-6">
        {league.isPrivate && isCreator && league.status === LeagueStatus.UPCOMING && (
          <InvitationManager leagueId={league.id} />
        )}

        <PrizeCalculator
          entryFee={league.entryFee}
          participants={league.currentMembers || league.maxMembers}
        />

        {league.entryFee > 0 && (
          <div className="bg-pitch-surface border border-pitch-border rounded-xl p-5 shadow-md space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-2">
                  <IconShield className="w-4 h-4 text-emerald-400" />
                  On-chain escrow audit
                </h3>
                <p className="text-[11px] text-slate-500 mt-1">
                  Soroban RPC · get_league
                </p>
              </div>
              <span
                className={`text-[10px] font-bold uppercase px-2 py-1 rounded border ${
                  onChainLeague &&
                  onChainLeague.totalDeposited >=
                    league.entryFee * league.currentMembers &&
                  onChainLeague.participantCount >= league.currentMembers
                    ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
                    : "text-amber-300 bg-amber-500/10 border-amber-500/30"
                }`}
              >
                {onChainLeague
                  ? `${Math.min(
                      100,
                      Math.round(
                        (onChainLeague.totalDeposited /
                          Math.max(
                            league.entryFee * league.currentMembers,
                            1
                          )) *
                          100
                      )
                    )}% solvent`
                  : "Checking"}
              </span>
            </div>

            {onChainLeague ? (
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-500 uppercase font-sans">
                    On-chain deposits
                  </div>
                  <div className="text-white font-bold mt-1">
                    {onChainLeague.totalDeposited.toFixed(2)} USDC
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2.5">
                  <div className="text-[10px] text-slate-500 uppercase font-sans">
                    Participants
                  </div>
                  <div className="text-white font-bold mt-1">
                    {onChainLeague.participantCount} / {league.currentMembers}
                  </div>
                </div>
                <div className="col-span-2 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Contract status</span>
                  <span className="text-emerald-400 font-semibold uppercase">
                    {onChainLeague.status}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                {auditError || "Reading escrow state..."}
              </p>
            )}

            <div className="flex flex-wrap gap-x-3 gap-y-2 text-[11px] font-semibold">
              <a
                href={`${stellarExpertBase}/contract/${escrowContractId}`}
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:text-emerald-300 underline"
              >
                Escrow contract
              </a>
              {usdcAssetContract && (
                <a
                  href={`${stellarExpertBase}/contract/${usdcAssetContract}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 underline"
                >
                  USDC asset
                </a>
              )}
              {depositEvidence && (
                <a
                  href={`${stellarExpertBase}/tx/${depositEvidence.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 underline"
                >
                  Your deposit tx
                </a>
              )}
              {depositEvidence?.ledgerSeq && (
                <a
                  href={`${stellarExpertBase}/ledger/${depositEvidence.ledgerSeq}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 underline"
                >
                  Ledger #{depositEvidence.ledgerSeq}
                </a>
              )}
            </div>
          </div>
        )}

        <div className="bg-pitch-surface border border-pitch-border rounded-xl p-5 shadow-md space-y-3 text-xs text-slate-400">
          <h3 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-2">
            <IconShield className="w-4 h-4 text-emerald-400" />
            <span>Smart Escrow Settlement</span>
          </h3>
          <ul className="space-y-2 leading-relaxed">
            <li>&bull; Entry fees are held in decentralized Soroban escrow.</li>
            <li>&bull; Standings are resolved using official FPL match data.</li>
            <li>
              &bull; Prizes are distributed automatically at the conclusion of
              Gameweek {league.endGameweekId}.
            </li>
            <li>&bull; 1st = 60%, 2nd = 30%, 3rd = 10% of total prize pool.</li>
          </ul>
        </div>
      </div>

      {/* Live standings table (visible when SSE feed is active) */}
      {liveStandings.length > 0 && (
        <div
          id="live-standings-panel"
          className="bg-pitch-surface border border-pitch-border rounded-xl p-5 shadow-md lg:col-span-2"
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white uppercase tracking-tight flex items-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-5 h-5 text-amber-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 21H5a2 2 0 0 1-2-2v-1a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v1a2 2 0 0 1-2 2h-3M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"
                  />
                </svg>
                <span>Live Standings</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Live leaderboard · click a manager to see their live squad
              </p>
            </div>
            <div className="text-xs font-mono text-slate-400">
              {liveStandings.length} Teams
            </div>
          </div>

          <StandingsTable
            standings={displayStandings}
            entryFee={league.entryFee}
            prizePool={league.prizePool}
            currentUserId={user?.id}
            livePoints={livePoints}
            rankChanges={rankChanges}
            onSelectEntry={setLiveSquadUserId}
          />
        </div>
      )}

      {/* Live squad points modal */}
      {liveSquadEntry && (
        <LiveSquadModal
          entry={liveSquadEntry}
          onClose={() => setLiveSquadUserId(null)}
        />
      )}

      {/* USDC Payment Modal */}
      {showPaymentModal && myEntry && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={() => setShowPaymentModal(false)}
          leagueId={league.id}
          leagueName={league.name}
          squadId={myEntry.squadId}
          entryFee={league.entryFee}
          onPaymentSuccess={(deposit) => {
            setDepositEvidence(deposit);
            loadLeagueData();
          }}
        />
      )}
    </>
  );
}
