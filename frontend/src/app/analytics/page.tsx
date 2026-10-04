"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { PerformanceAnalytics } from "@/types";
import { PerformanceDashboard } from "@/components/analytics/PerformanceDashboard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { IconChart } from "@/components/ui/Icons";

export default function AnalyticsPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const [analytics, setAnalytics] = useState<PerformanceAnalytics | null>(null);
  const [selectedSquadId, setSelectedSquadId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace("/login?returnTo=/analytics");
    }
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;

    const query = selectedSquadId ? `?squadId=${encodeURIComponent(selectedSquadId)}` : "";
    api
      .get<{ success: boolean; data: PerformanceAnalytics }>(`/api/v1/analytics/me/performance${query}`)
      .then((res) => {
        if (cancelled) return;
        setAnalytics(res.data);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load your analytics. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, selectedSquadId]);

  const handleSquadChange = (squadId: string) => {
    // Keep the previous render on screen (dimmed) while the new squad loads
    setIsLoading(true);
    setSelectedSquadId(squadId);
  };

  if (authLoading || !isAuthenticated) {
    return (
      <div className="py-24 text-center text-slate-400" role="status">
        <div className="mb-3 inline-block h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        <p className="text-xs">Loading your analytics...</p>
      </div>
    );
  }

  const hasHistory = (analytics?.history.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white">Performance analytics</h1>
          <p className="mt-1 text-sm text-slate-400">
            Your season, gameweek by gameweek, compared with every manager on FantasyXI.
          </p>
        </div>

        {analytics && analytics.squads.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>Squad</span>
            <select
              value={analytics.squadId ?? ""}
              onChange={(event) => handleSquadChange(event.target.value)}
              className="rounded-lg border border-pitch-border bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
            >
              {analytics.squads.map((squad) => (
                <option key={squad.id} value={squad.id}>
                  {squad.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-200">
          {error}
        </div>
      )}

      {isLoading && !analytics ? (
        <div className="py-20 text-center text-slate-400" role="status">
          <div className="mb-3 inline-block h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          <p className="text-xs">Crunching your gameweek history...</p>
        </div>
      ) : analytics && !analytics.squadId ? (
        <EmptyState
          icon={<IconChart className="h-6 w-6" />}
          title="No squad yet"
          description="Build a squad and your performance analytics will appear here after your first gameweek is scored."
          action={
            <Link href="/team">
              <Button variant="primary" size="sm">
                Build your squad
              </Button>
            </Link>
          }
        />
      ) : analytics && !hasHistory ? (
        <EmptyState
          icon={<IconChart className="h-6 w-6" />}
          title="No scored gameweeks yet"
          description="Your charts will fill in once your first gameweek has been settled."
        />
      ) : analytics ? (
        <div aria-busy={isLoading} className={`transition-opacity ${isLoading ? "opacity-60" : ""}`}>
          <PerformanceDashboard analytics={analytics} />
        </div>
      ) : null}
    </div>
  );
}
