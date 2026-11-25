"use client";

import React, { useState, useMemo } from "react";
import {
  DifficultyMatrix,
  TeamFixtureDifficulty,
  getDifficultyColor,
  getDifficultyLabel,
  FixtureSummary,
} from "@/lib/analytics/fixtureDifficultyAnalytics";
import { Team } from "@/types";

export interface FixtureDifficultyMatrixProps {
  matrix: DifficultyMatrix;
  teamSummary: FixtureSummary;
  onTeamSelect?: (teamId: number) => void;
}

/**
 * Interactive fixture difficulty matrix (5-gameweek window)
 * Shows color-coded difficulty ratings with filtering and drill-down
 */
export const FixtureDifficultyMatrix: React.FC<FixtureDifficultyMatrixProps> = ({
  matrix,
  teamSummary,
  onTeamSelect,
}) => {
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [showOnlyMyTeam, setShowOnlyMyTeam] = useState(false);

  const filteredMatrix = useMemo(() => {
    if (!showOnlyMyTeam || !selectedTeamId) return matrix;

    return {
      ...matrix,
      cells: matrix.cells.filter((c) => c.teamId === selectedTeamId),
      teams: matrix.teams.filter((t) => t.id === selectedTeamId),
    };
  }, [matrix, showOnlyMyTeam, selectedTeamId]);

  const cellSize = Math.max(70, Math.min(100, 800 / matrix.gameweeks.length));

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-900">
            Fixture Difficulty
          </h3>
          <p className="text-xs text-slate-500">
            Gameweeks {teamSummary.windowStart} - {teamSummary.windowEnd} (
            {teamSummary.gameweekCount} weeks)
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-2 font-semibold text-slate-600">
            <input
              type="checkbox"
              checked={showOnlyMyTeam}
              onChange={(e) => setShowOnlyMyTeam(e.target.checked)}
              className="rounded"
            />
            My Team Only
          </label>
          {showOnlyMyTeam && selectedTeamId && (
            <button
              onClick={() => setShowOnlyMyTeam(false)}
              className="text-slate-500 hover:text-slate-700"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Summary Statistics */}
      <div className="grid gap-3 lg:grid-cols-4">
        <SummaryStat
          label="Avg Difficulty"
          value={teamSummary.averageDifficulty.toFixed(2)}
          detail="Lower = easier schedule"
        />
        <SummaryStat
          label="Easiest Schedule"
          value={
            teamSummary.easiestSchedules[0]?.teamName?.slice(0, 10) || "—"
          }
          detail={`${teamSummary.easiestSchedules[0]?.difficultyScore.toFixed(2) || 0} avg`}
        />
        <SummaryStat
          label="Hardest Schedule"
          value={
            teamSummary.hardestSchedules[0]?.teamName?.slice(0, 10) || "—"
          }
          detail={`${teamSummary.hardestSchedules[0]?.difficultyScore.toFixed(2) || 0} avg`}
        />
        <SummaryStat
          label="Total Fixtures"
          value={teamSummary.totalFixtures.toString()}
          detail={`${filteredMatrix.gameweeks.length} gameweeks`}
        />
      </div>

      {/* Difficulty Matrix */}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="border-collapse text-center text-[10px]">
          <thead>
            <tr>
              <th className="border border-slate-200 bg-slate-50 px-2 py-2 text-left text-[9px] font-bold text-slate-600 w-20">
                Team
              </th>
              {filteredMatrix.gameweeks.map((gw) => (
                <th
                  key={gw.id}
                  className="border border-slate-200 bg-slate-50 px-1 py-2 font-bold text-slate-600"
                  style={{ width: `${cellSize}px`, minWidth: `${cellSize}px` }}
                >
                  <div className="text-[8px]">{gw.name}</div>
                  <div className="text-[7px] text-slate-500">GW{gw.id}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredMatrix.teams.map((team) => (
              <tr key={team.id}>
                {/* Team Name */}
                <td
                  className="border border-slate-200 bg-slate-50 px-2 py-2 text-left font-semibold text-slate-900 cursor-pointer hover:bg-slate-100"
                  onClick={() => {
                    setSelectedTeamId(team.id);
                    onTeamSelect?.(team.id);
                  }}
                >
                  <div className="text-[9px] truncate">{team.shortName}</div>
                </td>

                {/* Difficulty Cells */}
                {filteredMatrix.gameweeks.map((gw) => {
                  const cell = filteredMatrix.cells.find(
                    (c) => c.teamId === team.id && c.gameweekId === gw.id
                  );

                  return (
                    <td
                      key={`${team.id}-${gw.id}`}
                      className="border border-slate-200 p-1"
                      style={{
                        width: `${cellSize}px`,
                        minWidth: `${cellSize}px`,
                        backgroundColor: cell ? getDifficultyColor(cell.difficulty) : "#f3f4f6",
                      }}
                      title={
                        cell
                          ? `${cell.opponentTeamName} (${
                              cell.isHome ? "H" : "A"
                            }): ${getDifficultyLabel(cell.difficulty)}`
                          : ""
                      }
                    >
                      {cell && (
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="text-[10px] font-bold text-white drop-shadow">
                            {cell.difficulty}
                          </div>
                          <div className="text-[8px] font-semibold text-white drop-shadow opacity-75">
                            {cell.isHome ? "H" : "A"}
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
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 rounded-lg bg-slate-50 p-4 text-xs font-semibold">
        {[
          { difficulty: 1, label: "Very Easy" },
          { difficulty: 2, label: "Easy" },
          { difficulty: 3, label: "Medium" },
          { difficulty: 4, label: "Hard" },
          { difficulty: 5, label: "Very Hard" },
        ].map((item) => (
          <div key={item.difficulty} className="flex items-center gap-2">
            <div
              className="h-4 w-4 rounded"
              style={{ backgroundColor: getDifficultyColor(item.difficulty) }}
            />
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      {/* Top Teams by Schedule */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Easiest */}
        <div className="rounded-lg border border-slate-200 p-4">
          <h4 className="text-xs font-bold text-emerald-900">📈 Easiest Schedules</h4>
          <ul className="mt-2 space-y-1">
            {teamSummary.easiestSchedules.map((item, idx) => (
              <li key={item.teamId} className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">
                  {idx + 1}. {item.teamName}
                </span>
                <span className="font-mono text-emerald-700">
                  {item.difficultyScore.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Hardest */}
        <div className="rounded-lg border border-slate-200 p-4">
          <h4 className="text-xs font-bold text-rose-900">📉 Hardest Schedules</h4>
          <ul className="mt-2 space-y-1">
            {teamSummary.hardestSchedules.map((item, idx) => (
              <li key={item.teamId} className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">
                  {idx + 1}. {item.teamName}
                </span>
                <span className="font-mono text-rose-700">
                  {item.difficultyScore.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

interface SummaryStatProps {
  label: string;
  value: string;
  detail?: string;
}

const SummaryStat: React.FC<SummaryStatProps> = ({ label, value, detail }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3">
    <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
      {label}
    </dt>
    <dd className="mt-1 font-mono text-sm font-bold text-slate-900">
      {value}
    </dd>
    {detail && <dd className="text-[10px] text-slate-500 mt-0.5">{detail}</dd>}
  </div>
);
