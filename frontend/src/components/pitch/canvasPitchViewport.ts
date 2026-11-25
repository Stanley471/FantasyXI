/**
 * Pure viewport / gesture / animation math for the virtualized canvas pitch
 * (issue #458). No DOM, no React: every function here is unit-testable in
 * isolation and shared by the renderer and the component's pointer handlers.
 *
 * Coordinate systems:
 * - world: metres on a 105 x 68 pitch (0,0 = own goal line, near touchline).
 * - screen: CSS pixels inside the canvas element.
 * - backing: device pixels (screen * pixel ratio), owned by the renderer.
 *
 * The viewport is a zoom factor plus a pan offset in CSS pixels. Zooming
 * keeps the world point under the focal point fixed; panning is clamped so
 * the pitch can never be dragged entirely out of view.
 */

import { PITCH_LENGTH_M, PITCH_WIDTH_M } from "./livePitchModel";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** One frame at 60fps, in milliseconds — the per-frame budget in the issue. */
export const FRAME_BUDGET_MS = 1000 / 60;
export const DEFAULT_TRANSITION_MS = 600;

export interface ViewportState {
  /** Zoom factor: 1 shows the whole pitch, 2 shows half of it, larger. */
  zoom: number;
  /** Pan offset in CSS pixels, applied after zoom. */
  panX: number;
  panY: number;
}

export function createViewport(): ViewportState {
  return { zoom: 1, panX: 0, panY: 0 };
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Clamps a pan so at least half of the pitch stays visible in each axis.
 * `viewCssWidth/Height` are the canvas CSS size; `baseScale` is backing
 * pixels per metre at zoom 1 (canvas backing width / pitch length).
 */
export function clampPan(
  viewport: ViewportState,
  viewCssWidth: number,
  viewCssHeight: number,
  baseScaleCss: number
): ViewportState {
  const pitchCssWidth = PITCH_LENGTH_M * baseScaleCss * viewport.zoom;
  const pitchCssHeight = PITCH_WIDTH_M * baseScaleCss * viewport.zoom;
  const maxPanX = Math.max(0, (pitchCssWidth - viewCssWidth) / 2 + viewCssWidth / 2);
  const maxPanY = Math.max(0, (pitchCssHeight - viewCssHeight) / 2 + viewCssHeight / 2);
  return {
    ...viewport,
    panX: Math.min(maxPanX, Math.max(-maxPanX, viewport.panX)),
    panY: Math.min(maxPanY, Math.max(-maxPanY, viewport.panY)),
  };
}

/** World (metres) -> screen (CSS px). `baseScaleCss` is CSS px per metre at zoom 1. */
export function worldToScreen(
  viewport: ViewportState,
  baseScaleCss: number,
  worldX: number,
  worldY: number
): { x: number; y: number } {
  return {
    x: worldX * baseScaleCss * viewport.zoom + viewport.panX,
    y: worldY * baseScaleCss * viewport.zoom + viewport.panY,
  };
}

/** Screen (CSS px) -> world (metres). */
export function screenToWorld(
  viewport: ViewportState,
  baseScaleCss: number,
  screenX: number,
  screenY: number
): { x: number; y: number } {
  const scale = baseScaleCss * viewport.zoom;
  return { x: (screenX - viewport.panX) / scale, y: (screenY - viewport.panY) / scale };
}

/**
 * Zooms by `factor` around a focal point in screen CSS px, so the world
 * point under the cursor / pinch centre stays put.
 */
export function zoomAtPoint(
  viewport: ViewportState,
  baseScaleCss: number,
  focalX: number,
  focalY: number,
  factor: number
): ViewportState {
  const zoom = clampZoom(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  const before = screenToWorld(viewport, baseScaleCss, focalX, focalY);
  const next = { ...viewport, zoom };
  const after = screenToWorld(next, baseScaleCss, focalX, focalY);
  const scale = baseScaleCss * zoom;
  return { ...next, panX: next.panX + (after.x - before.x) * scale, panY: next.panY + (after.y - before.y) * scale };
}

/** World rectangle (metres) currently visible through the viewport, with a margin. */
export function visibleWorldRect(
  viewport: ViewportState,
  baseScaleCss: number,
  viewCssWidth: number,
  viewCssHeight: number,
  marginM = 4
): { minX: number; maxX: number; minY: number; maxY: number } {
  const topLeft = screenToWorld(viewport, baseScaleCss, 0, 0);
  const bottomRight = screenToWorld(viewport, baseScaleCss, viewCssWidth, viewCssHeight);
  return {
    minX: Math.max(0, topLeft.x - marginM),
    maxX: Math.min(PITCH_LENGTH_M, bottomRight.x + marginM),
    minY: Math.max(0, topLeft.y - marginM),
    maxY: Math.min(PITCH_WIDTH_M, bottomRight.y + marginM),
  };
}

export function isWorldPointVisible(
  rect: { minX: number; maxX: number; minY: number; maxY: number },
  worldX: number,
  worldY: number
): boolean {
  return worldX >= rect.minX && worldX <= rect.maxX && worldY >= rect.minY && worldY <= rect.maxY;
}

/** Cubic ease-in-out: slow start and end, fastest mid-transition. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

export interface WorldPoint {
  x: number;
  y: number;
}

/** Interpolates one point between two formation slots with easing applied. */
export function interpolatePosition(from: WorldPoint, to: WorldPoint, t: number): WorldPoint {
  const eased = easeInOutCubic(t);
  return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
}

/**
 * Interpolates a whole formation change (e.g. 4-3-3 -> 3-5-2): every player
 * present in both maps glides from its old slot to its new one; players
 * only in `to` start at their target (they run on via the renderer's
 * touchline entrance instead). Returns fresh points; inputs are untouched.
 */
export function interpolateFormation(
  from: ReadonlyMap<number, WorldPoint>,
  to: ReadonlyMap<number, WorldPoint>,
  t: number
): Map<number, WorldPoint> {
  const out = new Map<number, WorldPoint>();
  for (const [playerId, target] of to) {
    const start = from.get(playerId);
    out.set(playerId, start ? interpolatePosition(start, target, t) : { ...target });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ball trajectory vectors
// ---------------------------------------------------------------------------

export interface TrajectoryVector {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/**
 * Point along a slightly arced pass vector: a quadratic Bezier whose control
 * point is lifted perpendicular to the chord, so the ball visibly arcs
 * instead of sliding along a straight line. `t` is 0..1 along the flight.
 */
export function trajectoryPoint(vector: TrajectoryVector, t: number): WorldPoint {
  const clamped = Math.min(1, Math.max(0, t));
  const dx = vector.toX - vector.fromX;
  const dy = vector.toY - vector.fromY;
  const length = Math.hypot(dx, dy) || 1;
  // Arc height grows with pass length, capped so short passes stay flat.
  const lift = Math.min(6, length * 0.12);
  const cx = (vector.fromX + vector.toX) / 2 - (dy / length) * lift;
  const cy = (vector.fromY + vector.toY) / 2 + (dx / length) * lift;
  const u = 1 - clamped;
  return {
    x: u * u * vector.fromX + 2 * u * clamped * cx + clamped * clamped * vector.toX,
    y: u * u * vector.fromY + 2 * u * clamped * cy + clamped * clamped * vector.toY,
  };
}

/** Heading of the vector at its tip, in radians, for the arrowhead. */
export function trajectoryHeading(vector: TrajectoryVector): number {
  return Math.atan2(vector.toY - vector.fromY, vector.toX - vector.fromX);
}

/** The two back corners of an arrowhead at (`tipX`, `tipY`) pointing along `angle`. */
export function arrowheadPoints(
  tipX: number,
  tipY: number,
  angle: number,
  size: number
): [WorldPoint, WorldPoint] {
  const spread = Math.PI / 6;
  return [
    { x: tipX - size * Math.cos(angle - spread), y: tipY - size * Math.sin(angle - spread) },
    { x: tipX - size * Math.cos(angle + spread), y: tipY - size * Math.sin(angle + spread) },
  ];
}

/** Snaps a backing-store coordinate to a half pixel so 1px lines stay crisp. */
export function snapToPixel(value: number): number {
  return Math.round(value) + 0.5;
}

// ---------------------------------------------------------------------------
// Frame budget tracking (60fps / <16ms budget)
// ---------------------------------------------------------------------------

export interface FrameStats {
  /** Frames recorded. */
  frames: number;
  /** Mean CPU time per frame, ms. */
  avgMs: number;
  /** Slowest frame, ms. */
  maxMs: number;
  /** 95th-percentile frame time, ms. */
  p95Ms: number;
  /** Frames over the 16.67ms budget. */
  overBudgetFrames: number;
  /** Mean animation-frame interval (wall clock between frames), ms. */
  avgIntervalMs: number;
  /** Slowest animation-frame interval, ms. */
  maxIntervalMs: number;
}

/** Ring buffer of recent frame times; fixed memory, no per-frame allocation. */
export class FrameBudgetTracker {
  private readonly capacity: number;
  private readonly times: Float64Array;
  private readonly intervals: Float64Array;
  private count = 0;
  private cursor = 0;
  private totalMs = 0;
  private totalIntervalMs = 0;
  private overBudget = 0;

  constructor(capacity = 240) {
    this.capacity = Math.max(1, capacity);
    this.times = new Float64Array(this.capacity);
    this.intervals = new Float64Array(this.capacity);
  }

  get frameCount(): number {
    return this.count;
  }

  record(frameMs: number, intervalMs: number): void {
    const slot = this.cursor;
    if (this.count === this.capacity) {
      this.totalMs -= this.times[slot];
      this.totalIntervalMs -= this.intervals[slot];
      if (this.times[slot] > FRAME_BUDGET_MS) this.overBudget--;
    } else {
      this.count++;
    }
    this.times[slot] = frameMs;
    this.intervals[slot] = intervalMs;
    this.totalMs += frameMs;
    this.totalIntervalMs += intervalMs;
    if (frameMs > FRAME_BUDGET_MS) this.overBudget++;
    this.cursor = (this.cursor + 1) % this.capacity;
  }

  stats(): FrameStats {
    if (this.count === 0) {
      return { frames: 0, avgMs: 0, maxMs: 0, p95Ms: 0, overBudgetFrames: 0, avgIntervalMs: 0, maxIntervalMs: 0 };
    }
    const sorted = Array.from(this.times.slice(0, this.count)).sort((a, b) => a - b);
    let maxInterval = 0;
    for (let i = 0; i < this.count; i++) maxInterval = Math.max(maxInterval, this.intervals[i]);
    return {
      frames: this.count,
      avgMs: this.totalMs / this.count,
      maxMs: sorted[this.count - 1],
      p95Ms: sorted[Math.min(this.count - 1, Math.floor(this.count * 0.95))],
      overBudgetFrames: this.overBudget,
      avgIntervalMs: this.totalIntervalMs / this.count,
      maxIntervalMs: maxInterval,
    };
  }

  reset(): void {
    this.count = 0;
    this.cursor = 0;
    this.totalMs = 0;
    this.totalIntervalMs = 0;
    this.overBudget = 0;
  }
}

// ---------------------------------------------------------------------------
// Pointer gestures: pan, player drag, pinch-to-zoom (pure state machine)
// ---------------------------------------------------------------------------

export type GestureEvent =
  | { type: "pan"; dx: number; dy: number }
  | { type: "drag-player"; playerId: number; screenX: number; screenY: number }
  | { type: "pinch"; factor: number; focalX: number; focalY: number }
  | { type: "drag-start"; playerId: number }
  | { type: "drag-end"; playerId: number };

interface TrackedPointer {
  x: number;
  y: number;
}

/**
 * Turns raw pointer positions into gestures. The caller hit-tests the
 * pointer-down position (via the renderer's hitTest) and passes the player
 * id, if any; the machine then decides between panning the pitch, dragging
 * that player, and pinching with a second pointer. No DOM access.
 */
export class PitchGestureTracker {
  private readonly pointers = new Map<number, TrackedPointer>();
  private dragPlayerId: number | null = null;
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;
  private lastPinchDistance = 0;

  get activePointerCount(): number {
    return this.pointers.size;
  }

  get draggingPlayerId(): number | null {
    return this.dragPlayerId;
  }

  get isPinching(): boolean {
    return this.pointers.size >= 2;
  }

  pointerDown(pointerId: number, x: number, y: number, hitPlayerId: number | null, currentZoom: number): GestureEvent[] {
    this.pointers.set(pointerId, { x, y });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStartDistance = Math.hypot(b.x - a.x, b.y - a.y);
      this.lastPinchDistance = this.pinchStartDistance;
      this.pinchStartZoom = currentZoom;
      // A second finger cancels a player drag: the user is pinching now.
      const cancelled = this.dragPlayerId;
      this.dragPlayerId = null;
      return cancelled !== null ? [{ type: "drag-end", playerId: cancelled }] : [];
    }
    if (this.pointers.size === 1 && hitPlayerId !== null) {
      this.dragPlayerId = hitPlayerId;
      return [{ type: "drag-start", playerId: hitPlayerId }];
    }
    return [];
  }

  pointerMove(pointerId: number, x: number, y: number): GestureEvent[] {
    const previous = this.pointers.get(pointerId);
    if (!previous) return [];
    const dx = x - previous.x;
    const dy = y - previous.y;
    this.pointers.set(pointerId, { x, y });

    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      if (this.pinchStartDistance <= 0 || this.lastPinchDistance <= 0) return [];
      const factor = distance / this.lastPinchDistance;
      this.lastPinchDistance = distance;
      if (factor === 1) return [];
      return [{ type: "pinch", factor, focalX: (a.x + b.x) / 2, focalY: (a.y + b.y) / 2 }];
    }
    if (this.dragPlayerId !== null) {
      return [{ type: "drag-player", playerId: this.dragPlayerId, screenX: x, screenY: y }];
    }
    return [{ type: "pan", dx, dy }];
  }

  pointerUp(pointerId: number): GestureEvent[] {
    this.pointers.delete(pointerId);
    if (this.pointers.size < 2) this.pinchStartDistance = 0;
    if (this.pointers.size === 0 && this.dragPlayerId !== null) {
      const ended = this.dragPlayerId;
      this.dragPlayerId = null;
      return [{ type: "drag-end", playerId: ended }];
    }
    return [];
  }

  cancel(): GestureEvent[] {
    const events: GestureEvent[] = [];
    if (this.dragPlayerId !== null) events.push({ type: "drag-end", playerId: this.dragPlayerId });
    this.pointers.clear();
    this.dragPlayerId = null;
    this.pinchStartDistance = 0;
    return events;
  }
}
