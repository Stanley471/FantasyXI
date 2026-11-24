"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { AlertCircleIcon, RefreshIcon, SearchIcon, ShieldIcon } from "@/components/ui/Icons";

type Evidence = { type: string; confidence: number; values: string[] };
type GraphLink = { source: string; target: string; confidence: number; evidence: Evidence[] };
type RiskAccount = {
  userId: string;
  username: string;
  riskScorePercent: number;
  clusterId: string;
  flagged: boolean;
  payoutHeld?: boolean;
};
type SybilReport = {
  leagueId: string;
  analyzedAt: string;
  memberCount: number;
  payoutHoldsApplied: number;
  accounts: RiskAccount[];
  clusters: Array<{ id: string; rating: string; confidence: number; links: GraphLink[] }>;
  suppressedSignals: Array<{ signal: string; accounts: number }>;
};

const WIDTH = 800;
const HEIGHT = 420;

export default function AdminSecurityPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [leagueId, setLeagueId] = useState("");
  const [report, setReport] = useState<SybilReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const graph = useMemo(() => {
    if (!report) return { positions: new Map<string, { x: number; y: number }>(), links: [] as GraphLink[] };
    const positions = new Map<string, { x: number; y: number }>();
    const accounts = report.accounts;
    accounts.forEach((account, index) => {
      const angle = (index / Math.max(accounts.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const radius = Math.min(155, 45 + accounts.length * 11);
      positions.set(account.userId, {
        x: WIDTH / 2 + Math.cos(angle) * radius,
        y: HEIGHT / 2 + Math.sin(angle) * radius,
      });
    });
    return { positions, links: report.clusters.flatMap((cluster) => cluster.links) };
  }, [report]);

  const loadReport = async (event?: FormEvent, refresh = true) => {
    event?.preventDefault();
    const id = leagueId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.get<{ success: boolean; data: SybilReport }>(
        `/api/v1/admin/security/sybil/leagues/${encodeURIComponent(id)}?refresh=${refresh}`
      );
      setReport(response.data);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Unable to load the security report";
      setError(message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const releaseHold = async (account: RiskAccount) => {
    if (!report) return;
    setReleasing(account.userId);
    try {
      await api.del(`/api/v1/admin/security/sybil/leagues/${encodeURIComponent(report.leagueId)}/holds/${encodeURIComponent(account.userId)}`);
      setReport({
        ...report,
        accounts: report.accounts.map((item) =>
          item.userId === account.userId ? { ...item, payoutHeld: false } : item
        ),
      });
      toast.success(`Payout hold released for ${account.username}`);
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "Unable to release payout hold");
    } finally {
      setReleasing(null);
    }
  };

  if (authLoading) {
    return <main className="min-h-screen bg-slate-950 grid place-items-center text-slate-400">Loading security access...</main>;
  }

  if (!isAuthenticated || user?.role !== "ADMIN") {
    return (
      <main className="min-h-screen bg-slate-950 grid place-items-center p-6 text-slate-100">
        <section className="max-w-md text-center">
          <ShieldIcon size={36} className="mx-auto mb-4 text-rose-400" />
          <h1 className="text-xl font-bold">Security access required</h1>
          <p className="mt-2 text-sm text-slate-400">This view is restricted to security administrators.</p>
          <Link className="mt-6 inline-block text-sm font-semibold text-emerald-400 hover:text-emerald-300" href="/login?redirect=/admin/security">
            Sign in
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-emerald-400">
              <ShieldIcon size={16} /> Security review
            </div>
            <h1 className="text-2xl font-bold sm:text-3xl">Account relationship graph</h1>
            <p className="mt-1 text-sm text-slate-400">Fraud clusters, risk evidence, and payout holds by league.</p>
          </div>
          <form onSubmit={loadReport} className="flex w-full max-w-xl gap-2">
            <label className="relative flex-1">
              <span className="sr-only">League ID</span>
              <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={leagueId}
                onChange={(event) => setLeagueId(event.target.value)}
                placeholder="League ID"
                className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 pl-9 pr-3 text-sm outline-none focus:border-emerald-500"
              />
            </label>
            <Button type="submit" disabled={!leagueId.trim()} isLoading={loading} leftIcon={<SearchIcon size={15} />}>
              Inspect
            </Button>
          </form>
        </header>

        {error && (
          <div role="alert" className="flex items-center gap-3 border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
            <AlertCircleIcon size={18} /> {error}
          </div>
        )}

        {report && (
          <>
            <section className="grid grid-cols-2 gap-px overflow-hidden border border-slate-800 bg-slate-800 sm:grid-cols-4">
              {[
                ["Members", report.memberCount],
                ["Linked accounts", report.accounts.length],
                ["Clusters", report.clusters.length],
                ["New holds", report.payoutHoldsApplied],
              ].map(([label, value]) => (
                <div key={label} className="bg-slate-900 p-4">
                  <div className="text-xs uppercase text-slate-500">{label}</div>
                  <div className="mt-1 text-2xl font-bold">{value}</div>
                </div>
              ))}
            </section>

            <section className="border border-slate-800 bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">Relationship map</h2>
                  <p className="text-xs text-slate-500">Line strength reflects combined evidence confidence.</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => loadReport(undefined, true)} isLoading={loading} leftIcon={<RefreshIcon size={15} />}>
                  Refresh
                </Button>
              </div>
              <div className="overflow-x-auto">
                <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-[420px] min-w-[720px] w-full" role="img" aria-label="Suspected account relationship graph">
                  <rect width={WIDTH} height={HEIGHT} fill="#020617" />
                  {graph.links.map((link) => {
                    const source = graph.positions.get(link.source);
                    const target = graph.positions.get(link.target);
                    if (!source || !target) return null;
                    return <line key={`${link.source}-${link.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="#34d399" strokeOpacity={0.25 + link.confidence * 0.65} strokeWidth={1 + link.confidence * 4} />;
                  })}
                  {report.accounts.map((account) => {
                    const point = graph.positions.get(account.userId)!;
                    return (
                      <g key={account.userId} transform={`translate(${point.x} ${point.y})`}>
                        <circle r={account.flagged ? 24 : 18} fill={account.payoutHeld ? "#be123c" : account.flagged ? "#d97706" : "#0f766e"} stroke="#e2e8f0" strokeWidth="2" />
                        <text y="4" textAnchor="middle" fill="white" fontSize="11" fontWeight="700">{account.riskScorePercent}</text>
                        <text y="39" textAnchor="middle" fill="#cbd5e1" fontSize="11">{account.username.slice(0, 18)}</text>
                      </g>
                    );
                  })}
                  {report.accounts.length === 0 && <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle" fill="#94a3b8" fontSize="14">No linked accounts detected</text>}
                </svg>
              </div>
            </section>

            <section className="overflow-hidden border border-slate-800 bg-slate-900">
              <div className="border-b border-slate-800 px-4 py-3">
                <h2 className="text-sm font-semibold">Risk review queue</h2>
                <p className="text-xs text-slate-500">Automated holds remain active until an administrator releases them.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-slate-950 text-xs uppercase text-slate-500">
                    <tr><th className="px-4 py-3">Account</th><th className="px-4 py-3">Cluster</th><th className="px-4 py-3">Risk</th><th className="px-4 py-3">Evidence</th><th className="px-4 py-3 text-right">Payout</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {report.accounts.map((account) => {
                      const cluster = report.clusters.find((item) => item.id === account.clusterId);
                      const evidence = [...new Set(cluster?.links.flatMap((link) => link.evidence.map((item) => item.type.replaceAll("_", " "))) ?? [])];
                      return (
                        <tr key={account.userId}>
                          <td className="px-4 py-3"><div className="font-semibold">{account.username}</div><div className="font-mono text-xs text-slate-500">{account.userId}</div></td>
                          <td className="px-4 py-3 text-slate-300">{account.clusterId}</td>
                          <td className="px-4 py-3"><span className={account.riskScorePercent >= 80 ? "font-bold text-rose-400" : "text-amber-400"}>{account.riskScorePercent}/100</span></td>
                          <td className="px-4 py-3 text-xs text-slate-400">{evidence.join(", ") || "Linked signal"}</td>
                          <td className="px-4 py-3 text-right">
                            {account.payoutHeld ? (
                              <Button variant="danger" size="sm" isLoading={releasing === account.userId} onClick={() => releaseHold(account)}>Release hold</Button>
                            ) : <span className="text-xs font-semibold text-emerald-400">Eligible</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {report.accounts.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">No accounts require review.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
