"use client";

import React from "react";
import { PerformanceAnalytics, ChipType } from "@/types";
import { CHART_COLORS, formatPoints } from "@/lib/chart";
import { TimeSeriesChart } from "./TimeSeriesChart";

const CHIP_LABELS: Record<ChipType, string> = {
  TRIPLE_CAPTAIN: "Triple Captain",
  BENCH_BOOST: "Bench Boost",
  FREE_HIT: "Free Hit",
  WILDCARD: "Wildcard",
};

/** "Gameweek 12" -> "GW12" for compact axis labels */
export function shortGameweekLabel(name: string, fplId: number): string {
  return /gameweek/i.test(name) ? `GW${fplId}` : name;
}

interface StatTileProps {
  label: string;
  value: string;
  detail?: string;
}

export const StatTile: React.FC<StatTileProps> = ({ label, value, detail }) => (
  <div className="rounded-xl border border-pitch-border bg-pitch-surface p-4 shadow-sm">
    <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
    <dd className="mt-1 font-mono text-2xl font-black text-white tabular-nums">{value}</dd>
    {detail && <dd className="mt-0.5 text-xs text-slate-400">{detail}</dd>}
  </div>
);

export interface PerformanceDashboardProps {
  analytics: PerformanceAnalytics;
}

/**
 * Historical performance dashboard: headline stats, cumulative and per-gameweek
 * charts benchmarked against the platform average, and bench/hit trends.
 */
export const PerformanceDashboard: React.FC<PerformanceDashboardProps> = ({ analytics }) => {
  const { summary, history, chips } = analytics;
  const categories = history.map((h) => h.gameweekName);
  const axisLabels = history.map((h) => shortGameweekLabel(h.gameweekName, h.gameweekFplId));
  const latest = history[history.length - 1];

  const cumulativeGap =
    latest?.cumulativeAveragePoints != null ? latest.cumulativePoints - latest.cumulativeAveragePoints : null;
  const cumulativeSummary =
    `Cumulative points over ${summary.gameweeksPlayed} gameweeks, reaching ${formatPoints(summary.totalPoints)} points` +
    (cumulativeGap === null
      ? "."
      : `, ${formatPoints(Math.abs(cumulativeGap))} points ${cumulativeGap >= 0 ? "above" : "below"} the platform average.`);

  const perGameweekSummary =
    `Points per gameweek, ranging from ${formatPoints(summary.worstGameweek?.points ?? 0)} in ` +
    `${summary.worstGameweek?.gameweekName ?? "—"} to ${formatPoints(summary.bestGameweek?.points ?? 0)} in ` +
    `${summary.bestGameweek?.gameweekName ?? "—"}. Above the platform average in ${summary.gameweeksAboveAverage} of ` +
    `${summary.gameweeksPlayed} gameweeks.`;

  const leakageSummary =
    `Points left on the bench total ${formatPoints(summary.totalBenchPoints)}; ` +
    `transfer hits total ${formatPoints(summary.totalTransferCost)} points.`;

  return (
    <div className="space-y-6">
      <section aria-labelledby="season-summary-heading">
        <h2 id="season-summary-heading" className="sr-only">
          Season summary
        </h2>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Total points"
            value={formatPoints(summary.totalPoints)}
            detail={`${summary.gameweeksPlayed} gameweek${summary.gameweeksPlayed === 1 ? "" : "s"} played`}
          />
          <StatTile
            label="Average per gameweek"
            value={formatPoints(summary.averagePoints)}
            detail={`Median ${formatPoints(summary.medianPoints)}`}
          />
          <StatTile
            label="Best gameweek"
            value={formatPoints(summary.bestGameweek?.points ?? null)}
            detail={summary.bestGameweek?.gameweekName}
          />
          <StatTile label="Recent form" value={formatPoints(summary.recentForm)} detail="Average of last 5 gameweeks" />
          <StatTile
            label="Beat the average"
            value={`${summary.gameweeksAboveAverage}/${summary.gameweeksPlayed}`}
            detail="Gameweeks above platform average"
          />
          <StatTile
            label="Consistency"
            value={`±${formatPoints(summary.standardDeviation)}`}
            detail="Standard deviation per gameweek"
          />
          <StatTile
            label="Captaincy bonus"
            value={formatPoints(summary.totalCaptainPoints)}
            detail={`${formatPoints(summary.captainShare)}% of total points`}
          />
          <StatTile
            label="Points on bench"
            value={formatPoints(summary.totalBenchPoints)}
            detail={`Transfer hits: −${formatPoints(summary.totalTransferCost)}`}
          />
        </dl>
      </section>

      <section className="rounded-xl border border-pitch-border bg-pitch-surface p-4 shadow-md sm:p-6">
        <TimeSeriesChart
          title="Points over time"
          summary={cumulativeSummary}
          categories={categories}
          axisLabels={axisLabels}
          series={[
            { id: "you", label: "You", color: CHART_COLORS.primary, kind: "line", values: history.map((h) => h.cumulativePoints) },
            {
              id: "average",
              label: "Platform average",
              color: CHART_COLORS.benchmark,
              kind: "line",
              values: history.map((h) => h.cumulativeAveragePoints),
            },
          ]}
        />
      </section>

      <section className="rounded-xl border border-pitch-border bg-pitch-surface p-4 shadow-md sm:p-6">
        <TimeSeriesChart
          title="Points per gameweek"
          summary={perGameweekSummary}
          categories={categories}
          axisLabels={axisLabels}
          series={[
            { id: "you", label: "You", color: CHART_COLORS.primary, kind: "column", values: history.map((h) => h.points) },
            {
              id: "average",
              label: "Platform average",
              color: CHART_COLORS.benchmark,
              kind: "line",
              values: history.map((h) => h.averagePoints),
            },
          ]}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-pitch-border bg-pitch-surface p-4 shadow-md sm:p-6 lg:col-span-2">
          <TimeSeriesChart
            title="Points left on the bench and transfer hits"
            summary={leakageSummary}
            categories={categories}
            axisLabels={axisLabels}
            height={200}
            series={[
              { id: "bench", label: "Bench points", color: CHART_COLORS.tertiary, kind: "column", values: history.map((h) => h.benchPoints) },
              { id: "hits", label: "Transfer hits", color: CHART_COLORS.quaternary, kind: "column", values: history.map((h) => h.transferCost) },
            ]}
          />
        </section>

        <section
          aria-labelledby="chips-heading"
          className="rounded-xl border border-pitch-border bg-pitch-surface p-4 shadow-md sm:p-6"
        >
          <h3 id="chips-heading" className="text-sm font-bold text-slate-100">
            Chips played
          </h3>
          {chips.length === 0 ? (
            <p className="mt-3 text-xs text-slate-400">No chips played yet this season.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {chips.map((chip) => {
                const gameweek = history.find((h) => h.gameweekId === chip.gameweekId);
                return (
                  <li
                    key={`${chip.chipType}-${chip.gameweekId}`}
                    className="flex items-center justify-between rounded-lg border border-pitch-border bg-slate-950/50 px-3 py-2 text-xs"
                  >
                    <span>
                      <span className="block font-semibold text-slate-100">{CHIP_LABELS[chip.chipType]}</span>
                      <span className="text-slate-400">{chip.gameweekName}</span>
                    </span>
                    {gameweek && (
                      <span className="font-mono font-bold text-white tabular-nums">{formatPoints(gameweek.points)} pts</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
