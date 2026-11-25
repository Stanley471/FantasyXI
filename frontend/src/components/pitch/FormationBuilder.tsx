"use client";

import React, { useMemo } from "react";
import { detectFormation } from "@/lib/formation";
import {
  LEGAL_FORMATIONS,
  planFormationChange,
  reachableFormations,
} from "@/lib/dragDropFormation";
import { useTeamStore } from "@/store/teamStore";

/**
 * Formation builder (#462): switch the starting XI between legal
 * formations in one tap. Each formation button shows how many starter <->
 * bench swaps the switch needs and is disabled when the current bench
 * cannot supply the players (for example, no substitute forward for 4-3-3).
 * Switches apply the planned swaps in order through `handleSwap`, so every
 * step is still validated against the formation rules.
 */
export const FormationBuilder: React.FC = () => {
  const players = useTeamStore((state) => state.players);
  const handleSwap = useTeamStore((state) => state.handleSwap);
  const setSubstitutionFeedback = useTeamStore((state) => state.setSubstitutionFeedback);
  const selectedPlayerId = useTeamStore((state) => state.selectedPlayerId);

  const starters = useMemo(
    () => players.filter((p) => p.isStarter),
    [players]
  );
  const currentFormation = detectFormation(starters);
  const reachable = useMemo(() => reachableFormations(players), [players]);
  const reachableByFormation = useMemo(
    () => new Map(reachable.map((r) => [r.formation, r.swapCount])),
    [reachable]
  );

  const applyFormation = (formation: string) => {
    if (formation === currentFormation) return;
    const plan = planFormationChange(players, formation);
    if (!plan.ok) {
      setSubstitutionFeedback({ type: "error", message: plan.reason });
      return;
    }
    for (const step of plan.swaps) {
      if (!handleSwap(step.outPlayerId, step.inPlayerId)) return;
    }
    setSubstitutionFeedback({
      type: "success",
      message: `Formation switched to ${formation} (${plan.swaps.length} substitution${plan.swaps.length === 1 ? "" : "s"}).`,
    });
  };

  return (
    <section
      aria-label="Formation builder"
      data-testid="formation-builder"
      className="w-full rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-900">
          Formation Builder
        </h2>
        <span className="text-[11px] font-mono text-slate-500">
          Current: <span className="font-bold text-emerald-700">{currentFormation}</span>
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Choose a formation">
        {LEGAL_FORMATIONS.map((formation) => {
          const swapCount = reachableByFormation.get(formation);
          const isCurrent = formation === currentFormation;
          const isReachable = swapCount !== undefined;
          return (
            <button
              key={formation}
              type="button"
              disabled={!isReachable || isCurrent}
              aria-pressed={isCurrent}
              onClick={() => applyFormation(formation)}
              data-testid={`formation-${formation}`}
              title={
                isCurrent
                  ? `${formation} is the current formation`
                  : isReachable
                    ? `Switch to ${formation} (${swapCount} substitution${swapCount === 1 ? "" : "s"})`
                    : `Cannot switch to ${formation} with the current bench`
              }
              className={`rounded-xl border px-3 py-1.5 font-mono text-xs font-bold transition-all ${
                isCurrent
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : isReachable
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                    : "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
              } disabled:opacity-70`}
            >
              {formation}
              {!isCurrent && isReachable && (
                <span className="ml-1.5 text-[10px] font-semibold opacity-70">
                  {swapCount === 0 ? "current" : `${swapCount} swap${swapCount === 1 ? "" : "s"}`}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        Drag a player onto another to swap them, or use the keyboard:{" "}
        <kbd className="rounded border border-slate-300 bg-slate-100 px-1 font-mono">Space</kbd>{" "}
        to select,{" "}
        <kbd className="rounded border border-slate-300 bg-slate-100 px-1 font-mono">← ↑ ↓ →</kbd>{" "}
        to move,{" "}
        <kbd className="rounded border border-slate-300 bg-slate-100 px-1 font-mono">Enter</kbd>{" "}
        to swap,{" "}
        <kbd className="rounded border border-slate-300 bg-slate-100 px-1 font-mono">Esc</kbd>{" "}
        to cancel. Illegal swaps show a warning and the player snaps back.
      </p>

      {/* Live announcement of the keyboard selection for screen readers. */}
      <p role="status" aria-live="polite" className="sr-only">
        {selectedPlayerId !== null
          ? `Player ${selectedPlayerId} selected. Move to a swap target and press Enter.`
          : "No player selected for swapping."}
      </p>
    </section>
  );
};
