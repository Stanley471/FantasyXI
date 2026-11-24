"use client";

import React, { useMemo } from "react";
import { LeagueMember, ProbabilityData } from "@/types";

export interface WinProbabilityMatrixProps {
  members: LeagueMember[];
  probabilities: ProbabilityData;
}

/**
 * Head-to-Head matchup probability matrix
 * Shows win/draw/loss odds for each manager pairing
 */
export const WinProbabilityMatrix: React.FC<WinProbabilityMatrixProps> = ({
  members,
  probabilities,
}) => {
  // Calculate H2H probabilities between pairs
  const h2hMatrix = useMemo(() => {
    return members.map((m1) =>
      members.map((m2) => {
        if (m1.userId === m2.userId) {
          return { win: 0, draw: 0.5, loss: 0 };
        }

        // Simple heuristic: compare total points and title probabilities
        const m1Advantage = m1.totalPoints - m2.totalPoints;
        const m1TitleProb = probabilities.titleWinChances[m1.userId] || 0;
        const m2TitleProb = probabilities.titleWinChances[m2.userId] || 0;

        // Calculate probabilities based on point differential and title odds
        const baseProbability = 0.5 + m1Advantage / 1000;
        const titleBonus = (m1TitleProb - m2TitleProb) * 0.5;
        const winProb = Math.max(0, Math.min(1, baseProbability + titleBonus));

        return {
          win: winProb,
          draw: (1 - winProb) * 0.1,
          loss: 1 - winProb - (1 - winProb) * 0.1,
        };
      })
    );
  }, [members, probabilities]);

  const cellSize = Math.max(80, Math.min(120, 600 / members.length));

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-center text-[10px] font-semibold">
        <thead>
          <tr>
            <th className="w-24 border border-slate-200 bg-slate-50 p-1 text-left text-[8px] text-slate-600">
              Manager
            </th>
            {members.map((m) => (
              <th
                key={m.userId}
                className="border border-slate-200 bg-slate-50 p-1 text-slate-600"
                style={{ width: `${cellSize}px`, minWidth: `${cellSize}px` }}
              >
                <div className="truncate text-[8px]">
                  {m.user?.username?.slice(0, 8) || "Unknown"}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members.map((m1, i) => (
            <tr key={m1.userId}>
              <td className="border border-slate-200 bg-slate-50 p-1 text-left text-[8px] font-semibold text-slate-700 truncate max-w-xs">
                {m1.user?.username?.slice(0, 12) || "Unknown"}
              </td>
              {h2hMatrix[i].map((probs, j) => {
                const { win, draw, loss } = probs;
                let bgColor = "bg-slate-50";
                let textColor = "text-slate-400";

                if (i === j) {
                  // Self vs self
                  bgColor = "bg-slate-100";
                  textColor = "text-slate-400";
                } else if (win > 0.6) {
                  bgColor = "bg-emerald-50";
                  textColor = "text-emerald-700";
                } else if (win > 0.5) {
                  bgColor = "bg-blue-50";
                  textColor = "text-blue-700";
                } else if (win < 0.4) {
                  bgColor = "bg-rose-50";
                  textColor = "text-rose-700";
                } else {
                  bgColor = "bg-amber-50";
                  textColor = "text-amber-700";
                }

                return (
                  <td
                    key={`${m1.userId}-${m2.userId}`}
                    className={`border border-slate-200 p-2 ${bgColor} ${textColor}`}
                    style={{ width: `${cellSize}px`, minWidth: `${cellSize}px` }}
                  >
                    {i === j ? (
                      <div className="text-[10px] font-semibold">—</div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between gap-1 text-[9px]">
                          <span className="font-bold">{(win * 100).toFixed(0)}%</span>
                          <span className="text-slate-500">W</span>
                        </div>
                        <div className="flex justify-between gap-1 text-[9px]">
                          <span className="font-bold">{(draw * 100).toFixed(0)}%</span>
                          <span className="text-slate-500">D</span>
                        </div>
                        <div className="flex justify-between gap-1 text-[9px]">
                          <span className="font-bold">{(loss * 100).toFixed(0)}%</span>
                          <span className="text-slate-500">L</span>
                        </div>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex gap-4 text-[10px] font-semibold">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-emerald-50"></div>
          <span>Strong Advantage</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-blue-50"></div>
          <span>Slight Advantage</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-amber-50"></div>
          <span>Even Matchup</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-rose-50"></div>
          <span>Disadvantage</span>
        </div>
      </div>
    </div>
  );
};
