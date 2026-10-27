"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { LivePlayerEvent, LivePlayerPoints } from "@/types";
import {
  countingPlayers,
  diffPlayerEvents,
  PITCH_LENGTH_M,
  PITCH_WIDTH_M,
  selectQualityProfile,
} from "./livePitchModel";
import { LivePitchRenderer, PitchPlayer } from "./livePitchRenderer";

export interface LivePitchCanvasProps {
  /** A manager's live lineup; only players counting this gameweek are drawn. */
  lineup: LivePlayerPoints[];
  /** Live per-player event counters from the matchday feed. */
  events?: LivePlayerEvent[];
  className?: string;
}

function readDeviceProfile() {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return selectQualityProfile({
    prefersReducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    saveData: nav.connection?.saveData,
  });
}

/**
 * Live pitch drawn on a single canvas (issue #333): formation, points
 * heatmap and animated goal / assist / save / card effects. Live updates go
 * straight to the renderer, so they cost no React re-render or DOM work.
 * Without Canvas 2D (or before hydration) the canvas stays empty and the
 * accessible label still describes the lineup.
 */
export const LivePitchCanvas: React.FC<LivePitchCanvasProps> = ({ lineup, events, className = "" }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LivePitchRenderer | null>(null);
  const previousEvents = useRef<Map<number, LivePlayerEvent> | null>(null);

  const players: PitchPlayer[] = useMemo(
    () =>
      countingPlayers(lineup).map((p) => ({
        playerId: p.playerId,
        name: p.name,
        position: p.position,
        positionOrder: p.positionOrder,
        points: p.effectivePoints,
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain,
      })),
    [lineup]
  );

  // Renderer lifecycle, responsive sizing and off-screen pausing
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let renderer: LivePitchRenderer;
    try {
      renderer = new LivePitchRenderer(canvas, { profile: readDeviceProfile() });
    } catch {
      return; // no Canvas 2D: degrade to the label and the table beside the pitch
    }
    rendererRef.current = renderer;

    const resize = () => {
      const width = container.clientWidth;
      if (width > 0) renderer.resize(width, (width * PITCH_WIDTH_M) / PITCH_LENGTH_M, window.devicePixelRatio || 1);
    };
    resize();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(container);

    const intersectionObserver =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => renderer.setVisible(entry.isIntersecting))
        : null;
    intersectionObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setLineup(players);
  }, [players]);

  useEffect(() => {
    if (!events) return;
    const onPitch = new Set(players.map((p) => p.playerId));
    // The first snapshot is the baseline: only later increases are animated
    if (previousEvents.current) {
      rendererRef.current?.pushEvents(diffPlayerEvents(previousEvents.current, events, onPitch));
    }
    previousEvents.current = new Map(events.map((e) => [e.playerId, e]));
  }, [events, players]);

  const label = `Live pitch: ${players.map((p) => `${p.name} ${p.points} pts${p.isCaptain ? " (captain)" : ""}`).join(", ")}`;

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden rounded-lg border border-pitch-border bg-emerald-900 ${className}`}
      style={{ aspectRatio: `${PITCH_LENGTH_M} / ${PITCH_WIDTH_M}` }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} data-testid="live-pitch-canvas" className="block h-full w-full" />
    </div>
  );
};
