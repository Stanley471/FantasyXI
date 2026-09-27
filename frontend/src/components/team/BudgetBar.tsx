"use client";

import React from "react";
import { SQUAD_RULES } from "@/types";
import { IconFootball, IconAlertCircle, IconRefresh } from "@/components/ui/Icons";
import { Button } from "@/components/ui/Button";

import { useTeamStore } from "@/store/teamStore";

export interface BudgetBarProps {
  onAutoPick?: () => void;
  onReset?: () => void;
  isSaving?: boolean;
  onSave?: () => void;
  canSave?: boolean;
}

export const BudgetBar: React.FC<BudgetBarProps> = ({
  onAutoPick,
  onReset,
  isSaving = false,
  onSave,
  canSave = false,
}) => {
  const players = useTeamStore((state) => state.players);
  const spent = players.reduce((sum, p) => sum + (p.player?.price || 0), 0);
  const playerCount = players.length;
  const clubCounts: Record<number, number> = {};
  players.forEach((p) => {
    if (p.player?.teamId) {
      clubCounts[p.player.teamId] = (clubCounts[p.player.teamId] || 0) + 1;
    }
  });
  const maxBudget = SQUAD_RULES.STARTING_BUDGET;
  const spentM = spent / 10;
  const remainingM = maxBudget - spentM;
  const isOverBudget = remainingM < 0;

  // Find any club exceeding limit of 3
  const violatingClubs = Object.entries(clubCounts).filter(([_, count]) => count > SQUAD_RULES.MAX_PER_TEAM);

  return (
    <div className="w-full bg-pitch-surface border border-pitch-border rounded-xl p-4 sm:p-5 shadow-lg space-y-3" data-testid="budget-bar">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        {/* Left: Key Metrics */}
        <div className="flex items-center gap-6 sm:gap-8">
          {/* Players Selected */}
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              Players Picked
            </div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-xl sm:text-2xl font-black text-white font-mono">
                {playerCount}
              </span>
              <span className="text-xs text-slate-500 font-mono">
                / {SQUAD_RULES.TOTAL_PLAYERS}
              </span>
            </div>
          </div>

          {/* Budget Spent */}
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              Squad Value
            </div>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl sm:text-2xl font-black text-white font-mono">
                £{spentM.toFixed(1)}m
              </span>
            </div>
          </div>

          {/* Budget Remaining */}
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              Remaining
            </div>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span
                data-testid="budget-remaining"
                className={`text-xl sm:text-2xl font-black font-mono ${
                  isOverBudget ? "text-rose-400" : "text-emerald-400"
                }`}
              >
                £{remainingM.toFixed(1)}m
              </span>
            </div>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {onAutoPick && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onAutoPick}
              className="text-xs font-semibold"
              title="Draft a valid, balanced squad within budget"
              data-testid="auto-pick-button"
            >
              <IconRefresh className="w-3.5 h-3.5 text-emerald-400" />
              <span>Auto-Pick Squad</span>
            </Button>
          )}

          {onReset && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="text-xs text-slate-400 hover:text-rose-400"
            >
              Reset
            </Button>
          )}

          {onSave && (
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={!canSave || isSaving}
              isLoading={isSaving}
              onClick={onSave}
              className="uppercase font-bold tracking-wide text-xs px-4"
              data-testid="save-squad-button"
            >
              Save Squad
            </Button>
          )}
        </div>
      </div>

      {/* Visual Budget Progress Bar */}
      <div className="w-full bg-slate-900 rounded-sm h-2 overflow-hidden border border-slate-800">
        <div
          className={`h-full transition-all duration-300 ${
            isOverBudget
              ? "bg-rose-500"
              : remainingM < 5
              ? "bg-amber-400"
              : "bg-emerald-500"
          }`}
          style={{ width: `${Math.min(100, (spentM / maxBudget) * 100)}%` }}
        />
      </div>

      {/* Warnings / Errors */}
      {isOverBudget && (
        <div data-testid="budget-over-warning" className="p-2 rounded bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
          <IconAlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>
            You have exceeded the £100.0m limit by £{Math.abs(remainingM).toFixed(1)}m. Replace or transfer players to balance budget.
          </span>
        </div>
      )}

      {violatingClubs.length > 0 && (
        <div className="p-2 rounded bg-amber-950/40 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
          <IconAlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>
            Exceeded club limit: Maximum 3 players allowed from any Premier League team.
          </span>
        </div>
      )}
    </div>
  );
};
