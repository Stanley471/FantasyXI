"use client";

import React, { useState } from "react";
import {
  CONFLICT_KIND_LABELS,
  defaultResolutions,
  formatPrice,
  MergeConflict,
  MergeResolution,
  MergeResolutionMap,
} from "@/lib/mergeResolver";

export interface TransferConflictModalProps {
  open: boolean;
  conflicts: MergeConflict[];
  squadName?: string;
  onResolve: (resolutions: MergeResolutionMap) => void;
  onCancel: () => void;
}

function choiceLabels(conflict: MergeConflict): { mine: string; server: string } {
  switch (conflict.kind) {
    case "deadline-locked":
      return { mine: "Keep my draft saved", server: "Discard my draft" };
    case "player-transferred-out":
      return { mine: "Keep the player anyway", server: "Drop the player" };
    case "price-changed":
      return { mine: "Keep the player", server: "Undo my change" };
    default:
      return { mine: "Keep mine", server: "Take server" };
  }
}

/**
 * Visual 3-way merge resolution (issue #457). One card per conflict shows
 * the server state next to the local draft choice, and the manager picks
 * a side for each before the sync resumes. Light-card styling matches the
 * team page (BudgetBar / offline conflict dialog).
 */
export const TransferConflictModal: React.FC<TransferConflictModalProps> = ({
  open,
  conflicts,
  squadName,
  onResolve,
  onCancel,
}) => {
  const [selections, setSelections] = useState<MergeResolutionMap>(() => defaultResolutions(conflicts));
  // Reset the per-conflict choices when a new set of conflicts arrives
  // (React's "adjusting state during render" pattern for derived state).
  const [prevConflicts, setPrevConflicts] = useState(conflicts);
  if (prevConflicts !== conflicts) {
    setPrevConflicts(conflicts);
    setSelections(defaultResolutions(conflicts));
  }

  if (!open) return null;

  const choose = (id: string, choice: MergeResolution) => {
    setSelections((prev) => ({ ...prev, [id]: choice }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-conflict-title"
      data-testid="transfer-conflict-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
        <h2 id="transfer-conflict-title" className="text-lg font-black text-slate-900">
          Resolve offline transfer conflicts
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {squadName ? (
            <>
              While you were offline, <span className="font-semibold text-slate-700">{squadName}</span> changed on
              the server.
            </>
          ) : (
            "While you were offline, your squad changed on the server."
          )}{" "}
          Pick a side for each conflict below — nothing is committed until you apply your choices.
        </p>

        <div className="mt-5 space-y-4">
          {conflicts.map((conflict) => {
            const labels = choiceLabels(conflict);
            const selected = selections[conflict.id] ?? "mine";
            return (
              <section
                key={conflict.id}
                data-testid={`transfer-conflict-${conflict.id}`}
                className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-900">
                    {conflict.playerName ?? "Squad conflict"}
                  </h3>
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-800">
                    {CONFLICT_KIND_LABELS[conflict.kind]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">{conflict.message}</p>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                      Your draft
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">{conflict.localLabel}</div>
                    {conflict.localPrice !== undefined && (
                      <div className="mt-0.5 font-mono text-xs text-slate-500">
                        {formatPrice(conflict.localPrice)}
                      </div>
                    )}
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      Server
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">{conflict.remoteLabel}</div>
                    {conflict.remotePrice !== undefined && (
                      <div className="mt-0.5 font-mono text-xs text-slate-500">
                        {formatPrice(conflict.remotePrice)}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Resolve ${conflict.playerName ?? "conflict"}`}>
                  <button
                    type="button"
                    aria-pressed={selected === "mine"}
                    data-testid={`conflict-${conflict.id}-mine`}
                    onClick={() => choose(conflict.id, "mine")}
                    className={`rounded-xl px-3 py-2 text-xs font-bold transition-all ${
                      selected === "mine"
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {labels.mine}
                  </button>
                  <button
                    type="button"
                    aria-pressed={selected === "server"}
                    data-testid={`conflict-${conflict.id}-server`}
                    onClick={() => choose(conflict.id, "server")}
                    className={`rounded-xl px-3 py-2 text-xs font-bold transition-all ${
                      selected === "server"
                        ? "bg-slate-800 text-white shadow-sm"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {labels.server}
                  </button>
                </div>
              </section>
            );
          })}
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="transfer-conflict-cancel"
            className="rounded-xl px-4 py-2 text-xs font-bold text-slate-500 hover:text-rose-600"
          >
            Decide later
          </button>
          <button
            type="button"
            onClick={() => onResolve(selections)}
            data-testid="apply-resolutions"
            className="rounded-xl bg-emerald-600 px-5 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-emerald-700"
          >
            Apply resolutions &amp; sync
          </button>
        </div>
      </div>
    </div>
  );
};
