"use client";

import React, { useState, useEffect, useCallback, use } from "react";
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
import { StandingsTable } from "@/components/leagues/StandingsTable";
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
  IconTrophy,
  IconCopy,
  IconCheck,
  IconAlertCircle,
  IconChevronLeft,
  IconShield,
} from "@/components/ui/Icons";

export default function LeagueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const leagueId = resolvedParams.id;

  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const { toast } = useToast();

  const [league, setLeague] = useState<League | null>(null);
  const [standings, setStandings] = useState<LeagueStandingsEntry[]>([]);
  const [userSquads, setUserSquads] = useState<Squad[]>([]);
  const [selectedSquadId, setSelectedSquadId] = useState<string>("");

  const [isLoading, setIsLoading] = useState<boolean>(true);
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

  // Live matchday feed (SSE) while the competition is running
  const { snapshot, rankChanges, freshEventKeys, connection } = useLiveLeague(
    leagueId,
    league?.status === LeagueStatus.ACTIVE
  );

  // Load league data, standings, and user squads
  const loadLeagueData = useCallback(async () => {
    try {
      // 1. Fetch league details
      const lgRes = await api.get<{ success: boolean; data: League }>(
        `/api/v1/leagues/${leagueId}`
      );
      if (lgRes?.data) {
        setLeague(lgRes.data);
      }

      // 2. Fetch standings
      const stdRes = await api.get<{
        success: boolean;
        data: LeagueStandingsEntry[] | { standings: LeagueStandingsEntry[] };
      }>(`/api/v1/leagues/${leagueId}/standings`);
      if (stdRes?.data) {
        setStandings(Array.isArray(stdRes.data) ? stdRes.data : stdRes.data.standings);
      }

      // 3. Fetch user's squads if logged in
      if (isAuthenticated) {
        const squadRes = await api.get<{ success: boolean; data: Squad[] }>(
          "/api/v1/squads/me"
        );
        if (squadRes?.data && squadRes.data.length > 0) {
          setUserSquads(squadRes.data);
          setSelectedSquadId(squadRes.data[0].id);
        }
      }
    } catch (err: unknown) {
      console.error("Failed to load league:", err);
      if (err instanceof ApiError) {
        setErrorMessage(err.message || "Failed to load league details.");
      } else {
        setErrorMessage("Could not load competition data.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [leagueId, isAuthenticated]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const lgRes = await api.get<{ success: boolean; data: League }>(
          `/api/v1/leagues/${leagueId}`
        );
        if (!cancelled && lgRes?.data) {
          setLeague(lgRes.data);
        }

        const stdRes = await api.get<{
          success: boolean;
          data: LeagueStandingsEntry[] | { standings: LeagueStandingsEntry[] };
        }>(`/api/v1/leagues/${leagueId}/standings`);
        if (!cancelled && stdRes?.data) {
          setStandings(Array.isArray(stdRes.data) ? stdRes.data : stdRes.data.standings);
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
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [leagueId, isAuthenticated]);

  useEffect(() => {
    if (!league || league.entryFee <= 0) return;

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
  }, [league, leagueId, escrowContractId]);

  const copyInviteCode = () => {
    if (league?.inviteCode) {
      navigator.clipboard.writeText(league.inviteCode);
      setCopiedCode(true);
      toast.success("League invite code copied to clipboard!");
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  // Join league
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

      toast.success(`Successfully joined ${league?.name || "league"}!`);

      // Reload standings
      await loadLeagueData();

      // If this league has an entry fee, open payment modal automatically!
      if (league && league.entryFee > 0) {
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

  // Live standings replace the static table while the feed is streaming
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

  // Check if current user is already a member
  const myEntry = user ? standings.find((s) => s.userId === user.id) : null;
  const isMember = !!myEntry;
  const hasPaid = myEntry?.membershipStatus === MembershipStatus.ACTIVE || league?.entryFee === 0;
  const isCreator = !!user && league?.creatorId === user.id;

  if (isLoading) {
    return (
      <div className="py-24 text-center text-slate-400">
        <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-xs">Loading competition standings & escrow state...</p>
      </div>
    );
  }

  if (!league) {
    return (
      <div className="py-20 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-red-950/40 text-red-400 flex items-center justify-center mx-auto border border-red-500/30">
          <IconAlertCircle className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-white">League Not Found</h2>
        <p className="text-xs text-slate-400 max-w-sm mx-auto">
          The competition requested does not exist or may have been deleted.
        </p>
        <Link href="/leagues">
          <Button variant="primary" size="md">
            Return to Leagues
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Top back navigation */}
      <div>
        <Link
          href="/leagues"
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-400 font-semibold transition-colors"
        >
          <IconChevronLeft className="w-4 h-4" />
          <span>Back to All Leagues</span>
        </Link>
      </div>

      {/* League Header Card */}
      <div className="bg-pitch-surface border border-pitch-border rounded-xl p-6 shadow-lg space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <LeagueStatusBadge status={league.status} />
              {league.isPrivate && (
                <Badge variant="neutral" className="gap-1">
                  <IconShield className="w-3 h-3" />
                  <span>Private</span>
                </Badge>
              )}
              <span className="text-xs font-mono text-slate-400">
                GW {league.startGameweekId} &rarr; GW {league.endGameweekId}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black text-white uppercase tracking-tight">
              {league.name}
            </h1>
            <p className="text-xs text-slate-400 mt-1 max-w-xl">
              {league.description || "Official FantasyXI Competition."}
            </p>
          </div>

          {/* Invite Code Widget (private league codes are only returned to the creator) */}
          {league.inviteCode && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 self-start md:self-auto">
              <div>
                <div className="text-[10px] uppercase font-semibold text-slate-500">Invite Code</div>
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
                {copiedCode ? <IconCheck className="w-3.5 h-3.5 text-emerald-400" /> : <IconCopy className="w-3.5 h-3.5" />}
              </Button>
            </div>
          )}
        </div>

        {/* 4 Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 border-t border-slate-800/80 font-mono">
          <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800">
            <span className="text-[10px] text-slate-500 uppercase font-sans font-semibold">Entry Fee</span>
            <div className="text-lg font-black text-white mt-0.5">
              {league.entryFee > 0 ? `${league.entryFee} USDC` : "Free"}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800">
            <span className="text-[10px] text-slate-500 uppercase font-sans font-semibold">Prize Pool</span>
            <div className="text-lg font-black text-amber-400 mt-0.5">
              ${league.prizePool || 0} USDC
            </div>
          </div>

          <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800">
            <span className="text-[10px] text-slate-500 uppercase font-sans font-semibold">Participants</span>
            <div className="text-lg font-bold text-slate-200 mt-0.5">
              {league.currentMembers} / {league.maxMembers}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800">
            <span className="text-[10px] text-slate-500 uppercase font-sans font-semibold">Escrow</span>
            <div className="text-sm font-bold text-emerald-400 mt-1 flex items-center gap-1">
              <IconShield className="w-3.5 h-3.5" />
              <span>Soroban Active</span>
            </div>
          </div>
        </div>

        {/* User Status / Action Bar */}
        <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            {!isAuthenticated ? (
              <span className="text-xs text-slate-400">
                Sign in to join this competition with your squad.
              </span>
            ) : isMember ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-300">Your Status:</span>
                {hasPaid ? (
                  <Badge variant="success" className="gap-1 font-bold">
                    <IconCheck className="w-3.5 h-3.5" />
                    <span>Entered & Escrow Confirmed</span>
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
                This is a private league. Ask the creator for an invitation link to join.
              </span>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-slate-300">Enter with Squad:</span>
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
                  <Link href="/team" className="text-xs text-emerald-400 underline font-bold">
                    Create a squad first &rarr;
                  </Link>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!isAuthenticated ? (
              <Link href={`/login?returnTo=/leagues/${leagueId}`}>
                <Button variant="primary" size="md" className="uppercase font-bold tracking-wide text-xs">
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
      </div>

      {errorMessage && (
        <div className="p-3.5 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2.5 animate-shake">
          <IconAlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <span className="font-medium">{errorMessage}</span>
        </div>
      )}

      {/* Live matchday: fixtures, clock and event ticker */}
      {league.status === LeagueStatus.ACTIVE && (
        <LiveMatchdayBar
          snapshot={snapshot}
          connection={connection}
          freshEventKeys={freshEventKeys}
        />
      )}

      {/* Main Grid: Standings + Prize Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left 2 Cols: Standings Table */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-pitch-surface border border-pitch-border rounded-xl p-5 shadow-md">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white uppercase tracking-tight flex items-center gap-2">
                  <IconTrophy className="w-5 h-5 text-amber-400" />
                  <span>League Standings</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {livePoints
                    ? "Live leaderboard · click a manager to see their live squad"
                    : "Leaderboard updated after each gameweek resolution"}
                </p>
              </div>

              <div className="text-xs font-mono text-slate-400">
                {standings.length} Teams
              </div>
            </div>

            <StandingsTable
              standings={displayStandings}
              entryFee={league.entryFee}
              prizePool={league.prizePool}
              currentUserId={user?.id}
              livePoints={livePoints}
              rankChanges={rankChanges}
              onSelectEntry={livePoints ? setLiveSquadUserId : undefined}
            />
          </div>
        </div>

        {/* Right 1 Col: Prize Payout Calculator & Rules */}
        <div className="space-y-6">
          {league.isPrivate && isCreator && league.status === LeagueStatus.UPCOMING && (
            <InvitationManager leagueId={league.id} />
          )}

          <PrizeCalculator entryFee={league.entryFee} participants={league.currentMembers || league.maxMembers} />

          {league.entryFee > 0 && (
            <div className="bg-pitch-surface border border-pitch-border rounded-xl p-5 shadow-md space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-2">
                    <IconShield className="w-4 h-4 text-emerald-400" />
                    On-chain escrow audit
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-1">Soroban RPC · get_league</p>
                </div>
                <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded border ${
                  onChainLeague &&
                  onChainLeague.totalDeposited >= league.entryFee * league.currentMembers &&
                  onChainLeague.participantCount >= league.currentMembers
                    ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
                    : "text-amber-300 bg-amber-500/10 border-amber-500/30"
                }`}>
                  {onChainLeague ? `${Math.min(100, Math.round((onChainLeague.totalDeposited / Math.max(league.entryFee * league.currentMembers, 1)) * 100))}% solvent` : "Checking"}
                </span>
              </div>

              {onChainLeague ? (
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2.5">
                    <div className="text-[10px] text-slate-500 uppercase font-sans">On-chain deposits</div>
                    <div className="text-white font-bold mt-1">{onChainLeague.totalDeposited.toFixed(2)} USDC</div>
                  </div>
                  <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2.5">
                    <div className="text-[10px] text-slate-500 uppercase font-sans">Participants</div>
                    <div className="text-white font-bold mt-1">{onChainLeague.participantCount} / {league.currentMembers}</div>
                  </div>
                  <div className="col-span-2 flex items-center justify-between text-[11px] text-slate-400">
                    <span>Contract status</span>
                    <span className="text-emerald-400 font-semibold uppercase">{onChainLeague.status}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500">{auditError || "Reading escrow state..."}</p>
              )}

              <div className="flex flex-wrap gap-x-3 gap-y-2 text-[11px] font-semibold">
                <a href={`${stellarExpertBase}/contract/${escrowContractId}`} target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300 underline">Escrow contract</a>
                {usdcAssetContract && <a href={`${stellarExpertBase}/contract/${usdcAssetContract}`} target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300 underline">USDC asset</a>}
                {depositEvidence && <a href={`${stellarExpertBase}/tx/${depositEvidence.txHash}`} target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300 underline">Your deposit tx</a>}
                {depositEvidence?.ledgerSeq && <a href={`${stellarExpertBase}/ledger/${depositEvidence.ledgerSeq}`} target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300 underline">Ledger #{depositEvidence.ledgerSeq}</a>}
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
              <li>&bull; Prizes are distributed automatically at the conclusion of Gameweek {league.endGameweekId}.</li>
              <li>&bull; 1st = 60%, 2nd = 30%, 3rd = 10% of total prize pool.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Live squad points */}
      {liveSquadEntry && (
        <LiveSquadModal entry={liveSquadEntry} onClose={() => setLiveSquadUserId(null)} />
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
    </div>
  );
}
