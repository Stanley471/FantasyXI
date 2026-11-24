"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { LivePlayerEvent, LivePlayerPoints } from "@/types";
import {
  countingPlayers,
  diffPlayerEvents,
  layoutFormation,
  PITCH_LENGTH_M,
  PITCH_WIDTH_M,
  selectQualityProfile,
} from "./livePitchModel";
import { LivePitchRenderer, PitchPlayer } from "./livePitchRenderer";
import { PitchGestureTracker, TrajectoryVector } from "./canvasPitchViewport";

export interface LivePitchCanvasProps {
  /** A manager's live lineup; only players counting this gameweek are drawn. */
  lineup: LivePlayerPoints[];
  /** Live per-player event counters from the matchday feed. */
  events?: LivePlayerEvent[];
  className?: string;
  /** Called with the final world-metre position when a player drag ends. */
  onPlayerMove?: (playerId: number, worldX: number, worldY: number) => void;
  /** Ball trajectory vectors in world metres, drawn as arced pass arrows. */
  trajectories?: TrajectoryVector[];
  /** Duration of formation-change animations in ms; 0 snaps instantly. */
  formationTransitionMs?: number;
  /** When false, pointer gestures (zoom / pan / drag) are disabled. */
  interactive?: boolean;
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

/** One line of the hidden semantic pitch for screen readers. */
function describePlayer(player: PitchPlayer, slot: { x: number; y: number }): string {
  const badges = [
    player.isCaptain ? "captain" : null,
    player.isViceCaptain ? "vice-captain" : null,
    player.status && player.status !== "fit" ? player.status : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    `${player.name}, ${player.position}, ${player.points} points` +
    (badges ? `, ${badges}` : "") +
    `, kit ${player.kitPrimary ?? `${player.position} kit`}, ` +
    `at ${(slot.x * PITCH_LENGTH_M).toFixed(1)} metres along the pitch, ` +
    `${(slot.y * PITCH_WIDTH_M).toFixed(1)} metres across`
  );
}

/**
 * Live pitch drawn on a single canvas (issue #333, virtualized renderer
 * issue #458): formation, points heatmap and animated goal / assist / save /
 * card effects, plus zoom, pan and player drag-and-drop. Live updates go
 * straight to the renderer, so they cost no React re-render or DOM work.
 * Without Canvas 2D (or before hydration) the canvas stays empty and the
 * accessible label still describes the lineup.
 *
 * Accessibility: the canvas is visual only. A visually hidden semantic list
 * (aria-live) carries every player's data — name, position, points, kit,
 * status badges and formation slot — so screen readers get the whole pitch
 * without ever needing the canvas. Gesture results (zoom, drags) are
 * announced in the same live region.
 */
export const LivePitchCanvas: React.FC<LivePitchCanvasProps> = ({
  lineup,
  events,
  className = "",
  onPlayerMove,
  trajectories,
  formationTransitionMs = 600,
  interactive = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LivePitchRenderer | null>(null);
  const announceRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef(new PitchGestureTracker());
  const previousEvents = useRef<Map<number, LivePlayerEvent> | null>(null);
  const previousPlayerIds = useRef<number[] | null>(null);
  const onPlayerMoveRef = useRef(onPlayerMove);
  const interactiveRef = useRef(interactive);
  const playersRef = useRef<PitchPlayer[]>([]);

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

  const slots = useMemo(() => {
    const byId = new Map(layoutFormation(players).map((slot) => [slot.playerId, slot]));
    return players.map((p) => byId.get(p.playerId) ?? { playerId: p.playerId, x: 0, y: 0 });
  }, [players]);

  const announce = (message: string) => {
    if (announceRef.current) announceRef.current.textContent = message;
  };

  // Latest props for the mount-once effect below (listeners, renderer
  // callbacks); syncing in an effect keeps render itself ref-free.
  useEffect(() => {
    onPlayerMoveRef.current = onPlayerMove;
    interactiveRef.current = interactive;
    playersRef.current = players;
  });

  // Renderer lifecycle, responsive sizing, gestures and off-screen pausing.
  // Every listener and observer added here is removed in the same cleanup,
  // so rapid remounting leaks nothing (see canvasPitchRenderer.test).
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let renderer: LivePitchRenderer;
    try {
      renderer = new LivePitchRenderer(canvas, {
        profile: readDeviceProfile(),
        onPlayerDrop: (playerId, worldX, worldY) => {
          onPlayerMoveRef.current?.(playerId, worldX, worldY);
          const player = playersRef.current.find((p) => p.playerId === playerId);
          if (player) {
            announce(
              `${player.name} moved to ${worldX.toFixed(1)} metres along the pitch, ${worldY.toFixed(1)} metres across.`
            );
          }
        },
      });
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

    // --- Pointer gestures: pan, player drag, pinch-to-zoom, wheel zoom ---
    const canvasPoint = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const applyGesture = (gesture: ReturnType<PitchGestureTracker["pointerMove"]>[number]) => {
      switch (gesture.type) {
        case "pan":
          renderer.panBy(gesture.dx, gesture.dy);
          break;
        case "drag-player":
          renderer.dragPlayerTo(gesture.screenX, gesture.screenY);
          break;
        case "pinch":
          renderer.zoomBy(gesture.factor, gesture.focalX, gesture.focalY);
          break;
        case "drag-start":
          renderer.beginPlayerDrag(gesture.playerId);
          break;
        case "drag-end":
          renderer.endPlayerDrag();
          break;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!interactiveRef.current) return;
      canvas.setPointerCapture?.(event.pointerId);
      const point = canvasPoint(event);
      for (const gesture of gestureRef.current.pointerDown(
        event.pointerId,
        point.x,
        point.y,
        renderer.hitTest(point.x, point.y),
        renderer.viewportState.zoom
      )) {
        applyGesture(gesture);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!interactiveRef.current) return;
      const point = canvasPoint(event);
      for (const gesture of gestureRef.current.pointerMove(event.pointerId, point.x, point.y)) {
        applyGesture(gesture);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      for (const gesture of gestureRef.current.pointerUp(event.pointerId)) applyGesture(gesture);
    };
    const onPointerCancel = () => {
      for (const gesture of gestureRef.current.cancel()) applyGesture(gesture);
    };
    const onWheel = (event: WheelEvent) => {
      if (!interactiveRef.current) return;
      event.preventDefault();
      const point = canvasPoint(event);
      renderer.zoomBy(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
      announce(`Zoom ${Math.round(renderer.viewportState.zoom * 100)} percent.`);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    // Wheel must be non-passive so the page does not scroll while zooming.
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const gesture = gestureRef.current;

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("wheel", onWheel);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      gesture.cancel();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // Same eleven players, new slots: glide between formations (e.g. 4-3-3
    // -> 3-5-2) instead of snapping. Any other change uses the plain path.
    const previous = previousPlayerIds.current;
    const sameSquad =
      previous !== null &&
      previous.length === players.length &&
      previous.every((id) => players.some((p) => p.playerId === id));
    if (sameSquad) renderer.transitionToLineup(players, formationTransitionMs);
    else renderer.setLineup(players);
    previousPlayerIds.current = players.map((p) => p.playerId);
  }, [players, formationTransitionMs]);

  useEffect(() => {
    rendererRef.current?.setTrajectories(trajectories ?? []);
  }, [trajectories]);

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
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        data-testid="live-pitch-canvas"
        className="block h-full w-full"
        style={{ touchAction: "none" }}
      />
      {/* Hidden semantic pitch: every player's data for screen readers. */}
      <div className="sr-only" aria-live="polite" data-testid="live-pitch-semantic">
        <p>{label}</p>
        <ul>
          {players.map((player, index) => (
            <li key={player.playerId}>{describePlayer(player, slots[index])}</li>
          ))}
        </ul>
      </div>
      <div ref={announceRef} className="sr-only" role="status" aria-live="polite" data-testid="live-pitch-announcer" />
    </div>
  );
};
