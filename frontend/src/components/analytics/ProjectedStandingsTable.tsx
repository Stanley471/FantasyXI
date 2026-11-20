"use client";

import React from "react";
import { ProjectedStandings } from "@/lib/simulation/monteCarloEngine";
import { LeagueMember } from "@/types";

export interface ProjectedStandingsTableProps {
  standings: ProjectedStandings[];
  members: LeagueMember[];
  showConfidenceInterval?: boolean;
}

/**
 * Table showing projected final standings with probabilities
 */
export const ProjectedStandingsTable: React.FC<ProjectedStandingsTableProps> = ({
  standings,
  members,
  showConfidenceInterval = true,
}) => {
  const memberMap = new Map(members.map((m) => [m.userId, m]));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="px-4 py-3 font-bold text-slate-600">Rank</th>
            <th className="px-4 py-3 font-bold text-slate-600">Manager</th>
            <th className="px-4 py-3 text-center font-bold text-slate-600">
              Projected Points
            </th>
            {showConfidenceInterval && (
              <th className="px-4 py-3 text-center font-bold text-slate-600">
                Range (95% CI)
              </th>
            )}
            <th className="px-4 py-3 text-center font-bold text-slate-600">
              Title Odds
            </th>
            <th className="px-4 py-3 text-center font-bold text-slate-600">
              Top 3 Odds
            </th>
            <th className="px-4 py-3 text-center font-bold text-slate-600">
              Relegation Risk
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {standings.map((standing, idx) => {
            const member = memberMap.get(standing.managerId);
            const isFirst = idx === 0;
            const isTop3 = idx < 3;
            const isBottom2 = idx >= standings.length - 2;

            let rowBg = "";
            if (isFirst) {
              rowBg = "bg-emerald-50";
            } else if (isTop3) {
              rowBg = "bg-blue-50";
            } else if (isBottom2) {
              rowBg = "bg-rose-50";
            }

            return (
              <tr key={standing.managerId} className={`hover:bg-opacity-75 ${rowBg}`}>
                {/* Rank */}
                <td className="px-4 py-3 font-bold text-slate-900">
                  {standing.projectedRank}
                  {isFirst && <span className="ml-1 text-yellow-500">👑</span>}
                  {isTop3 && !isFirst && <span className="ml-1">🥈</span>}
                </td>

                {/* Manager Name */}
                <td className="px-4 py-3 font-semibold text-slate-900">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor:
                          member?.totalPoints && member.totalPoints > 0
                            ? "#10b981"
                            : "#e5e7eb",
                      }}
                    />
                    <span className="truncate">
                      {standing.managerName}
                      {member && (
                        <span className="ml-1 text-slate-500">
                          (#{member.rank})
                        </span>
                      )}
                    </span>
                  </div>
                </td>

                {/* Projected Points */}
                <td className="px-4 py-3 text-center font-mono font-bold text-slate-900">
                  {standing.projectedPoints}
                </td>

                {/* Confidence Interval */}
                {showConfidenceInterval && (
                  <td className="px-4 py-3 text-center text-slate-700">
                    <span className="font-mono text-xs">
                      {standing.pointsRange.min} – {standing.pointsRange.max}
                    </span>
                    <div className="mt-1 h-1 w-full rounded-full bg-slate-200">
                      <div
                        className="h-full rounded-full bg-slate-400"
                        style={{
                          width: `${(
                            (standing.projectedPoints - standing.pointsRange.min) /
                            (standing.pointsRange.max - standing.pointsRange.min)
                          ) * 100}%`,
                        }}
                      />
                    </div>
                  </td>
                )}

                {/* Title Odds */}
                <td className="px-4 py-3 text-center">
                  <ProbabilityBadge
                    probability={standing.titleWinProbability}
                    label="Title"
                  />
                </td>

                {/* Top 3 Odds */}
                <td className="px-4 py-3 text-center">
                  <ProbabilityBadge
                    probability={standing.top3Probability}
                    label="Top 3"
                  />
                </td>

                {/* Relegation Risk */}
                <td className="px-4 py-3 text-center">
                  <div
                    className={`inline-block rounded-full px-2 py-1 text-[10px] font-bold ${
                      standing.relegationRiskProbability > 0.1
                        ? "bg-rose-100 text-rose-900"
                        : standing.relegationRiskProbability > 0.01
                        ? "bg-amber-100 text-amber-900"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {(standing.relegationRiskProbability * 100).toFixed(1)}%
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

interface ProbabilityBadgeProps {
  probability: number;
  label: string;
}

const ProbabilityBadge: React.FC<ProbabilityBadgeProps> = ({
  probability,
  label,
}) => {
  let bgColor = "bg-slate-100";
  let textColor = "text-slate-600";

  if (probability > 0.3) {
    bgColor = "bg-emerald-100";
    textColor = "text-emerald-900";
  } else if (probability > 0.1) {
    bgColor = "bg-blue-100";
    textColor = "text-blue-900";
  } else if (probability > 0.01) {
    bgColor = "bg-amber-100";
    textColor = "text-amber-900";
  }

  return (
    <div className={`inline-block rounded-full ${bgColor} ${textColor} px-2 py-1 text-[10px] font-bold`}>
      {(probability * 100).toFixed(1)}%
    </div>
  );
};
