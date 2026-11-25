"use client";

import React, { useMemo } from "react";
import { ProjectedStandings } from "@/lib/simulation/monteCarloEngine";
import { CHART_COLORS } from "@/lib/chart";

export interface ProbabilityChartProps {
  data: ProjectedStandings[];
  onManagerSelect?: (managerId: string) => void;
}

/**
 * Bar chart showing title win probabilities
 */
export const ProbabilityChart: React.FC<ProbabilityChartProps> = ({
  data,
  onManagerSelect,
}) => {
  // Sort by probability descending
  const sorted = useMemo(
    () => [...data].sort((a, b) => b.titleWinProbability - a.titleWinProbability),
    [data]
  );

  // Calculate max for scaling
  const maxProb = Math.max(...sorted.map((s) => s.titleWinProbability), 0.1);
  const chartHeight = 250;
  const barHeight = chartHeight / sorted.length;

  return (
    <div className="space-y-4">
      {/* Bar chart */}
      <div className="space-y-2">
        {sorted.map((entry, idx) => {
          const percentage = (entry.titleWinProbability / maxProb) * 100;
          const widthPercent = (entry.titleWinProbability * 100).toFixed(1);

          return (
            <div
              key={entry.managerId}
              className="flex items-center gap-3"
              onClick={() => onManagerSelect?.(entry.managerId)}
            >
              {/* Label */}
              <div className="w-32 truncate text-right">
                <p className="text-xs font-semibold text-slate-900 truncate">
                  {entry.managerName}
                </p>
                <p className="text-[10px] text-slate-500">
                  #{entry.projectedRank}
                </p>
              </div>

              {/* Bar */}
              <div className="flex flex-1 items-center gap-2">
                <div className="relative h-6 flex-1 overflow-hidden rounded-lg bg-slate-100">
                  <div
                    className="h-full transition-all duration-500"
                    style={{
                      width: `${percentage}%`,
                      backgroundColor: CHART_COLORS.primary,
                    }}
                  />
                </div>

                {/* Value */}
                <div className="w-12 text-right">
                  <span className="font-mono text-xs font-bold text-slate-900">
                    {widthPercent}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Distribution visualization */}
      <div className="mt-6 rounded-lg bg-slate-50 p-4">
        <p className="text-xs font-semibold text-slate-600">
          Probability Distribution
        </p>
        <svg
          className="mt-3 w-full"
          height="120"
          viewBox="0 0 400 120"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <linearGradient id="probGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={CHART_COLORS.primary} stopOpacity="0.3" />
              <stop offset="100%" stopColor={CHART_COLORS.primary} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Distribution curve (simplified bell curve) */}
          <path
            d="M 0 100 Q 50 20, 100 10 Q 150 5, 200 5 Q 250 5, 300 10 Q 350 20, 400 100"
            fill="url(#probGradient)"
            stroke={CHART_COLORS.primary}
            strokeWidth="1.5"
          />

          {/* Axis */}
          <line x1="0" y1="100" x2="400" y2="100" stroke="#e5e7eb" strokeWidth="1" />
        </svg>
        <div className="mt-2 flex justify-between text-[10px] text-slate-500">
          <span>0%</span>
          <span>50%</span>
          <span>100%</span>
        </div>
      </div>
    </div>
  );
};
