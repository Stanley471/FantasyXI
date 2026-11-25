"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  aggregateScore,
  applyResults,
  bracketProgress,
  buildBracket,
  computeLayout,
  liveScoreText,
  simulatePredictions,
  slotState,
} from "../../lib/tournamentBracket";
import type {
  BracketFormat,
  BracketMatch,
  BracketPicks,
  BracketResultInput,
} from "../../lib/tournamentBracket";

export type { BracketEntrant, BracketFormat, BracketMatch } from "../../lib/tournamentBracket";
export type BracketTeam = import("../../lib/tournamentBracket").BracketEntrant;

/** One line of a side-by-side squad comparison. */
export interface SquadPlayerLine {
  name: string;
  position: string;
  points: number;
}

export interface TournamentBracketProps {
  teams: BracketTeam[];
  /** "single" knockout (default) or "double" elimination with losers bracket. */
  format?: BracketFormat;
  /** Match results to apply on top of the bracket (live or final). */
  results?: BracketResultInput[];
  /** Squad lines per entrant id, shown in the match comparison panel. */
  squads?: Record<string, SquadPlayerLine[]>;
  readonly?: boolean;
  /** Start with prediction mode on. */
  predictionMode?: boolean;
  initialPredictions?: BracketPicks;
  /** Fired when a match node is opened for comparison. */
  onCompare?: (match: BracketMatch) => void;
  onPredictionChange?: (picks: BracketPicks, predictedChampionId: string | null) => void;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function slotLabel(match: BracketMatch, slot: "home" | "away", matches: BracketMatch[]): string {
  const entrant = match[slot];
  if (entrant) return entrant.name;
  return slotState(matches, match, slot) === "bye" ? "Bye" : "TBD";
}

/** Side-by-side squad comparison for one match (also used standalone in tests). */
export const MatchComparison: React.FC<{
  match: BracketMatch;
  squads?: Record<string, SquadPlayerLine[]>;
  onClose?: () => void;
}> = ({ match, squads = {}, onClose }) => (
  <div
    className="mt-3 rounded-xl border border-slate-700 bg-slate-900 p-4"
    data-testid="match-comparison"
    role="dialog"
    aria-label={`Squad comparison: ${match.label}`}
  >
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-sm font-bold text-white">
        {match.label} — squad comparison
        {match.status === "live" && liveScoreText(match) && (
          <span className="ml-2 text-emerald-400">Live: {liveScoreText(match)}</span>
        )}
        {match.status === "final" && liveScoreText(match) && (
          <span className="ml-2 text-slate-400">Final: {liveScoreText(match)}</span>
        )}
      </h3>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comparison"
          className="px-2 py-1 rounded-lg border border-slate-700 text-xs text-slate-300"
        >
          Close
        </button>
      )}
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
      {(["home", "away"] as const).map((slot) => {
        const entrant = match[slot];
        const lines = entrant ? squads[entrant.id] ?? [] : [];
        const total = lines.reduce((sum, line) => sum + line.points, 0);
        return (
          <div key={slot} data-testid={`comparison-${slot}`}>
            <div className="text-sm font-semibold text-white">
              {entrant ? entrant.name : "TBD"}
              {entrant?.seed !== undefined && <span className="ml-2 text-slate-500">#{entrant.seed}</span>}
              {match.winnerId === entrant?.id && <span className="ml-2 text-emerald-400">Winner</span>}
            </div>
            {entrant?.squadPoints !== undefined && (
              <div className="text-xs text-slate-400">Squad points: {entrant.squadPoints}</div>
            )}
            {lines.length > 0 ? (
              <ul className="mt-2 text-xs text-slate-300">
                {lines.map((line) => (
                  <li key={line.name} className="flex justify-between py-0.5 border-b border-slate-800">
                    <span>
                      {line.name} <span className="text-slate-500">({line.position})</span>
                    </span>
                    <span className="font-mono">{line.points} pts</span>
                  </li>
                ))}
                <li className="flex justify-between py-1 font-bold text-white">
                  <span>Total</span>
                  <span className="font-mono">{total} pts</span>
                </li>
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-500">No squad data for this manager yet.</p>
            )}
          </div>
        );
      })}
    </div>
    {match.legs.length > 0 && (
      <div className="mt-3 text-xs text-slate-400">
        Legs:{" "}
        {match.legs.map((leg, index) => (
          <span key={index} className="mr-2">
            Leg {index + 1}: {leg.home}–{leg.away}
          </span>
        ))}
      </div>
    )}
  </div>
);

export const TournamentBracket: React.FC<TournamentBracketProps> = ({
  teams,
  format = "single",
  results = [],
  squads = {},
  readonly = false,
  predictionMode = false,
  initialPredictions = {},
  onCompare,
  onPredictionChange,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [predicting, setPredicting] = useState(predictionMode);
  const [picks, setPicks] = useState<BracketPicks>(initialPredictions);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const bracket = useMemo(() => {
    if (teams.length === 0) return null;
    return applyResults(buildBracket(teams, { format }), results);
  }, [teams, format, results]);

  const simulated = useMemo(() => {
    if (!bracket) return null;
    return simulatePredictions(bracket, picks);
  }, [bracket, picks]);

  const displayMatches = useMemo(() => {
    if (!bracket) return [];
    return predicting && simulated ? simulated.matches : bracket.matches;
  }, [bracket, simulated, predicting]);

  const layout = useMemo(() => (bracket ? computeLayout(bracket) : null), [bracket]);

  const predictedChampionId = simulated?.predictedChampionId ?? null;
  const champion = useMemo(() => {
    if (!bracket) return null;
    return bracket.matches
      .flatMap((m) => [m.home, m.away])
      .find((entrant) => entrant?.id === bracket.championId) ?? null;
  }, [bracket]);

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !layout) return;
    const scale = clamp(
      Math.min(viewport.clientWidth / layout.width, viewport.clientHeight / layout.height, 1),
      MIN_SCALE,
      MAX_SCALE
    );
    setView({
      scale,
      x: (viewport.clientWidth - layout.width * scale) / 2,
      y: (viewport.clientHeight - layout.height * scale) / 2,
    });
  }, [layout]);

  useEffect(() => {
    fitView();
  }, [fitView]);

  const zoomBy = useCallback((factor: number) => {
    setView((prev) => ({ ...prev, scale: clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE) }));
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, [zoomBy]);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }, [view]);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setView((prev) => ({
      ...prev,
      x: pan.originX + (event.clientX - pan.startX),
      y: pan.originY + (event.clientY - pan.startY),
    }));
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent) => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  }, []);

  const handlePick = useCallback((match: BracketMatch, entrantId: string) => {
    if (readonly || match.status === "final") return;
    if (match.home?.id !== entrantId && match.away?.id !== entrantId) return;
    setPicks((prev) => {
      const next = { ...prev, [match.id]: entrantId };
      if (bracket) {
        const { predictedChampionId: championId } = simulatePredictions(bracket, next);
        onPredictionChange?.(next, championId);
      }
      return next;
    });
  }, [readonly, bracket, onPredictionChange]);

  const clearPredictions = useCallback(() => {
    setPicks({});
    onPredictionChange?.({}, null);
  }, [onPredictionChange]);

  const selectedMatch = displayMatches.find((m) => m.id === selectedMatchId) ?? null;

  if (!bracket || !layout) {
    return (
      <div className="flex items-center justify-center h-64 border-2 border-dashed border-slate-800 rounded-xl text-slate-500 text-sm">
        No teams registered for this bracket yet.
      </div>
    );
  }

  const progress = bracketProgress(bracket);
  const liveCount = bracket.matches.filter((m) => m.status === "live").length;
  const positioned = new Map(layout.matches.map((positionedMatch) => [positionedMatch.match.id, positionedMatch]));

  return (
    <div className="w-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
          {format === "double" ? "Double elimination" : "Single elimination"} · {bracket.size} managers
        </span>
        <span className="text-xs text-slate-500">
          {progress.played}/{progress.total} matches decided ({progress.percent}%)
        </span>
        {liveCount > 0 && (
          <span className="text-xs font-semibold text-emerald-400" data-testid="live-count">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-1" aria-hidden="true" />
            {liveCount} live
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setPredicting((prev) => !prev)}
          aria-pressed={predicting}
          className={`px-3 py-1.5 rounded-lg border text-xs font-semibold ${
            predicting
              ? "bg-emerald-600 border-emerald-500 text-white"
              : "bg-slate-900 border-slate-700 text-slate-200"
          }`}
        >
          {predicting ? "Prediction mode: on" : "Prediction mode: off"}
        </button>
        {predicting && Object.keys(picks).length > 0 && (
          <button
            type="button"
            onClick={clearPredictions}
            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-semibold text-slate-200"
          >
            Clear predictions
          </button>
        )}
        <button
          type="button"
          onClick={() => zoomBy(1.25)}
          aria-label="Zoom in"
          className="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-semibold text-slate-200"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.25)}
          aria-label="Zoom out"
          className="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-semibold text-slate-200"
        >
          −
        </button>
        <button
          type="button"
          onClick={fitView}
          className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-semibold text-slate-200"
        >
          Fit
        </button>
      </div>

      {champion && (
        <div className="mb-3 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/40 text-sm text-amber-300" data-testid="champion-banner">
          Champion: <span className="font-bold">{champion.name}</span>
        </div>
      )}
      {predicting && predictedChampionId && (
        <div className="mb-3 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/40 text-sm text-emerald-300" data-testid="predicted-champion-banner">
          Predicted champion:{" "}
          <span className="font-bold">
            {displayMatches.flatMap((m) => [m.home, m.away]).find((e) => e?.id === predictedChampionId)?.name ??
              predictedChampionId}
          </span>
        </div>
      )}

      {/* Pannable / zoomable tree: SVG connectors + HTML match nodes */}
      <div
        ref={viewportRef}
        data-testid="bracket-viewport"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative h-[560px] md:h-[640px] overflow-hidden rounded-xl border border-slate-800 bg-slate-950 touch-none select-none"
        role="region"
        aria-label="Tournament bracket tree. Drag to pan, use the zoom buttons to zoom."
      >
        <div
          className="absolute top-0 left-0"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: "0 0",
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            className="absolute top-0 left-0"
            aria-hidden="true"
            data-testid="bracket-connectors"
          >
            {layout.connectors.map((connector) => (
              <path
                key={connector.id}
                d={connector.d}
                fill="none"
                stroke={connector.decided ? "#34d399" : "#334155"}
                strokeWidth={connector.decided ? 2.5 : 1.5}
                data-testid="bracket-connector"
                data-decided={connector.decided}
              />
            ))}
          </svg>

          {displayMatches.map((match) => {
            const pos = positioned.get(match.id);
            if (!pos) return null;
            const score = aggregateScore(match);
            const live = match.status === "live";
            const predicted = match.predictedWinnerId;
            const openComparison = () => {
              setSelectedMatchId(match.id);
              onCompare?.(match);
            };
            return (
              <div
                key={match.id}
                data-testid="bracket-match"
                data-match-id={match.id}
                data-status={match.status}
                data-side={match.side}
                onClick={openComparison}
                className={`absolute flex flex-col rounded-lg border text-left text-xs overflow-hidden cursor-pointer ${
                  live ? "border-emerald-500 bg-slate-900" : "border-slate-700 bg-slate-900"
                } ${predicted ? "ring-2 ring-emerald-500/50" : ""}`}
                style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }}
                aria-label={`${match.label}: ${slotLabel(match, "home", displayMatches)} versus ${slotLabel(match, "away", displayMatches)}${live ? ", live" : match.status === "final" ? ", final" : ""}`}
              >
                <span className="flex items-center justify-between gap-1 px-2 pt-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <span>{match.label}</span>
                  {live && (
                    <span className="bracket-live-pulse flex items-center gap-1 text-emerald-400" data-testid="live-indicator">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                      LIVE
                    </span>
                  )}
                  {match.status === "final" && <span className="text-slate-500">FT</span>}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openComparison();
                    }}
                    aria-label={`Compare squads: ${match.label}`}
                    className="normal-case tracking-normal text-slate-400 underline underline-offset-2 hover:text-white"
                  >
                    Compare
                  </button>
                </span>
                {(["home", "away"] as const).map((slot) => {
                  const entrant = match[slot];
                  const isWinner = match.winnerId !== null && entrant?.id === match.winnerId;
                  const isPredicted = predicted === entrant?.id;
                  const slotScore = slot === "home" ? score.home : score.away;
                  const rowClass = `flex w-full items-center justify-between px-2 py-1 text-left ${
                    isWinner ? "text-white font-bold" : "text-slate-300"
                  } ${isPredicted ? "bg-emerald-500/10" : ""}`;
                  const rowBody = (
                    <>
                      <span className="truncate">
                        {entrant ? (
                          <>
                            {entrant.seed !== undefined && (
                              <span className="text-slate-500 mr-1">#{entrant.seed}</span>
                            )}
                            {entrant.name}
                            {isPredicted && <span className="ml-1 text-emerald-400 font-semibold">(predicted)</span>}
                          </>
                        ) : (
                          <span className="text-slate-600">
                            {slotState(displayMatches, match, slot) === "bye" ? "Bye" : "TBD"}
                          </span>
                        )}
                      </span>
                      {entrant && match.legs.length > 0 && (
                        <span className="ml-2 font-mono font-bold">{slotScore}</span>
                      )}
                    </>
                  );
                  if (predicting && !readonly && match.status !== "final" && entrant) {
                    return (
                      <button
                        key={slot}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handlePick(match, entrant.id);
                        }}
                        aria-label={`Predict ${entrant.name} to win ${match.label}`}
                        className={rowClass}
                      >
                        {rowBody}
                      </button>
                    );
                  }
                  return (
                    <span key={slot} className={rowClass}>
                      {rowBody}
                    </span>
                  );
                })}
                {match.legs.length > 1 && (
                  <span className="px-2 pb-1 text-[10px] text-slate-500">{liveScoreText(match)}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Drag the bracket to pan. Click a match to compare both squads
        {predicting ? "; in prediction mode, click a manager to pick them as the winner." : "."}
      </p>

      {/* Side-by-side squad comparison */}
      {selectedMatch && (
        <MatchComparison
          match={selectedMatch}
          squads={squads}
          onClose={() => setSelectedMatchId(null)}
        />
      )}
    </div>
  );
};
