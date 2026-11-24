import { ParticlePool } from "./particlePool";
import {
  layoutFormation,
  PITCH_LENGTH_M,
  PITCH_WIDTH_M,
  PitchEvent,
  PitchEventKind,
  QUALITY_PROFILES,
  QualityProfile,
} from "./livePitchModel";
import { Position } from "@/types";
import {
  arrowheadPoints,
  clampPan,
  clampZoom,
  createViewport,
  DEFAULT_TRANSITION_MS,
  easeInOutCubic,
  FrameBudgetTracker,
  FrameStats,
  isWorldPointVisible,
  screenToWorld,
  snapToPixel,
  trajectoryHeading,
  trajectoryPoint,
  TrajectoryVector,
  ViewportState,
  visibleWorldRect,
  worldToScreen,
  zoomAtPoint,
} from "./canvasPitchViewport";

/**
 * Canvas 2D renderer for the live pitch (issue #333).
 *
 * One <canvas> replaces a DOM node per player, marker and effect, so live
 * updates never trigger React re-renders or layout. Per frame the work is
 * bounded: one blit of the pre-rendered pitch, O(n) players and heat blobs
 * (n = 11), O(P) particles with P <= the profile's pool capacity, and at most
 * `burstsPerFrame` new effects, however many events arrive at once. Memory is
 * fixed after start-up: the visible canvas, one same-sized static layer, a
 * 64x64 heat sprite and the preallocated particle pool.
 *
 * All simulation happens in metres (105 x 68 pitch); drawing scales to the
 * backing store, so the pitch is resolution independent.
 */

/** Player availability shown as a status badge on the kit. */
export type PlayerStatus = "fit" | "doubtful" | "injured" | "suspended";

export interface PitchPlayer {
  playerId: number;
  name: string;
  position: Position;
  positionOrder: number;
  points: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  /** Availability badge; defaults to "fit" (no badge drawn). */
  status?: PlayerStatus;
  /** Shirt number printed on the kit; defaults to positionOrder. */
  shirtNumber?: number;
  /** Kit primary colour (e.g. the club's home colour); defaults to the position colour. */
  kitPrimary?: string;
}

/** A ball trajectory vector in world metres, drawn as an arced pass arrow. */
export interface PitchTrajectory extends TrajectoryVector {
  /** Seconds since the pass started; 1 = arrived. */
  progress: number;
  /** Flight duration in seconds. */
  durationSeconds: number;
}

export interface DrawStats {
  draws: number;
  drawnTokens: number;
  culledTokens: number;
  staticBlits: number;
}

type Surface = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface LivePitchRendererOptions {
  profile: QualityProfile;
  /** Creates off-screen drawing surfaces (injectable for tests). */
  createSurface?: (width: number, height: number) => Surface;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  /** Called with the final world-metre position when a player drag ends. */
  onPlayerDrop?: (playerId: number, worldX: number, worldY: number) => void;
}

interface Token {
  player: PitchPlayer;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  heat: number;
  heatTarget: number;
  opacity: number;
  leaving: boolean;
  phase: number;
  /** Position on the backing store for the current frame, idle drift included. */
  drawX: number;
  drawY: number;
}

interface BallFlight {
  fromX: number;
  fromY: number;
  elapsed: number;
}

const PALETTE = ["#34d399", "#facc15", "#ffffff", "#22d3ee", "#38bdf8", "#f59e0b", "#f43f5e"];
const BURSTS: Record<PitchEventKind, { colors: number[]; count: number; speed: number; life: number; size: number }> = {
  GOAL: { colors: [0, 1, 2], count: 56, speed: 16, life: 1.2, size: 0.7 },
  ASSIST: { colors: [3, 2], count: 28, speed: 10, life: 0.9, size: 0.55 },
  SAVE: { colors: [4, 2], count: 24, speed: 9, life: 0.8, size: 0.55 },
  YELLOW_CARD: { colors: [5], count: 14, speed: 5, life: 1.0, size: 0.9 },
  RED_CARD: { colors: [6], count: 18, speed: 6, life: 1.2, size: 0.9 },
};

const MAX_PENDING_EVENTS = 96;
const MAX_BALL_FLIGHTS = 8;
const BALL_FLIGHT_SECONDS = 0.6;
const TOKEN_RADIUS_M = 2;
const TOUCHLINE_EXIT_Y = PITCH_WIDTH_M + 6;
/** Exponential approach rate (1/s) for movement and heat. */
const EASING_RATE = 5;
/** Frame interval above which the renderer counts a frame as slow (about 45 fps). */
const SLOW_FRAME_MS = 22;
const SLOW_FRAMES_BEFORE_DOWNGRADE = 90;
const HEAT_POINTS_FOR_MAX = 12;

function defaultSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const heatFor = (points: number) => Math.min(1, Math.max(0.08, points / HEAT_POINTS_FOR_MAX));

/** Default kit colour per position (overridden per player via kitPrimary). */
const KIT_COLORS: Record<Position, string> = {
  [Position.GKP]: "#0284c7",
  [Position.DEF]: "#2563eb",
  [Position.MID]: "#047857",
  [Position.FWD]: "#be123c",
};

function statusBadge(player: PitchPlayer): { letter: string; fill: string; text: string } | null {
  if (player.isCaptain) return { letter: "C", fill: "#facc15", text: "#1c1917" };
  if (player.isViceCaptain) return { letter: "V", fill: "#e2e8f0", text: "#0f172a" };
  switch (player.status) {
    case "injured":
      return { letter: "I", fill: "#dc2626", text: "#ffffff" };
    case "suspended":
      return { letter: "S", fill: "#475569", text: "#ffffff" };
    case "doubtful":
      return { letter: "?", fill: "#d97706", text: "#ffffff" };
    default:
      return null;
  }
}

export class LivePitchRenderer {
  private profile: QualityProfile;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly createSurface: (width: number, height: number) => Surface;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly onPlayerDrop?: (playerId: number, worldX: number, worldY: number) => void;

  private pool: ParticlePool;
  private staticLayer: Surface | null = null;
  private readonly heatSprite: Surface;
  private readonly tokens = new Map<number, Token>();
  private pending: PitchEvent[] = [];
  private flights: BallFlight[] = [];
  private trajectories: PitchTrajectory[] = [];

  /** Zoom + pan viewport (issue #458); identity until the user zooms or pans. */
  private viewport: ViewportState = createViewport();
  /** Player currently being dragged; its token follows the pointer directly. */
  private draggingPlayerId: number | null = null;
  /** Active formation transition: per-player start/target slots in world metres. */
  private transitionSteps: Map<number, { fromX: number; fromY: number; toX: number; toY: number }> | null = null;
  private transitionElapsedMs = 0;
  private transitionDurationMs = 0;
  private readonly frameBudget = new FrameBudgetTracker();
  private drawStats: DrawStats = { draws: 0, drawnTokens: 0, culledTokens: 0, staticBlits: 0 };
  private lastDrawnTokens = 0;
  private lastCulledTokens = 0;

  private width = 0;
  private height = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private devicePixelRatio = 1;
  private frameId: number | null = null;
  private lastFrameTime: number | null = null;
  private slowFrames = 0;
  private visible = true;
  private destroyed = false;

  constructor(private readonly canvas: HTMLCanvasElement, options: LivePitchRendererOptions) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.profile = options.profile;
    this.createSurface = options.createSurface ?? defaultSurface;
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.onPlayerDrop = options.onPlayerDrop;
    this.pool = new ParticlePool(this.profile.maxParticles);
    this.heatSprite = this.buildHeatSprite();
  }

  get qualityProfile(): QualityProfile {
    return this.profile;
  }

  get particleCount(): number {
    return this.pool.count;
  }

  get pendingEventCount(): number {
    return this.pending.length;
  }

  get viewportState(): ViewportState {
    return { ...this.viewport };
  }

  get isTransitioning(): boolean {
    return this.transitionSteps !== null;
  }

  /** 0..1 progress of the active formation transition; 1 when idle. */
  get transitionProgress(): number {
    if (!this.transitionSteps || this.transitionDurationMs <= 0) return 1;
    return Math.min(1, this.transitionElapsedMs / this.transitionDurationMs);
  }

  get draggingPlayer(): number | null {
    return this.draggingPlayerId;
  }

  /** Frame-time measurements for the 60fps / <16ms budget (issue #458). */
  getFrameStats(): FrameStats {
    return this.frameBudget.stats();
  }

  /** Last frame's virtualization counts: drawn vs culled (off-viewport) tokens. */
  getDrawStats(): DrawStats {
    return { ...this.drawStats, drawnTokens: this.lastDrawnTokens, culledTokens: this.lastCulledTokens };
  }

  get tokenCount(): number {
    return this.tokens.size;
  }

  getTokenWorldPosition(playerId: number): { x: number; y: number } | null {
    const token = this.tokens.get(playerId);
    return token ? { x: token.x, y: token.y } : null;
  }

  // -- Viewport: zoom, pan, hit-testing (issue #458) -------------------------

  /** CSS px per metre at zoom 1, used to convert between screen and world. */
  private baseScaleCss(): number {
    return this.cssWidth > 0 ? this.cssWidth / PITCH_LENGTH_M : 0;
  }

  /** Zooms around a focal point in canvas CSS px; no-op without a size. */
  zoomBy(factor: number, focalCssX?: number, focalCssY?: number): void {
    if (this.cssWidth <= 0 || !Number.isFinite(factor) || factor <= 0) return;
    const focalX = focalCssX ?? this.cssWidth / 2;
    const focalY = focalCssY ?? this.cssHeight / 2;
    this.viewport = clampPan(
      zoomAtPoint(this.viewport, this.baseScaleCss(), focalX, focalY, factor),
      this.cssWidth,
      this.cssHeight,
      this.baseScaleCss()
    );
    this.wake();
  }

  zoomTo(zoom: number, focalCssX?: number, focalCssY?: number): void {
    if (this.viewport.zoom === 0) return;
    this.zoomBy(clampZoom(zoom) / this.viewport.zoom, focalCssX, focalCssY);
  }

  panBy(dxCss: number, dyCss: number): void {
    if (this.cssWidth <= 0) return;
    this.viewport = clampPan(
      { ...this.viewport, panX: this.viewport.panX + dxCss, panY: this.viewport.panY + dyCss },
      this.cssWidth,
      this.cssHeight,
      this.baseScaleCss()
    );
    this.wake();
  }

  resetViewport(): void {
    this.viewport = createViewport();
    this.wake();
  }

  /** Canvas CSS px -> world metres, honouring the current zoom and pan. */
  screenToWorld(cssX: number, cssY: number): { x: number; y: number } {
    return screenToWorld(this.viewport, this.baseScaleCss(), cssX, cssY);
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return worldToScreen(this.viewport, this.baseScaleCss(), worldX, worldY);
  }

  /**
   * Player whose kit is under a canvas CSS-px point, or null. The hit radius
   * is at least 22 CSS px so touch drags stay usable when zoomed out.
   */
  hitTest(cssX: number, cssY: number): number | null {
    if (this.cssWidth <= 0) return null;
    const ratio = this.width / this.cssWidth;
    const pointX = cssX * ratio;
    const pointY = cssY * (this.height / Math.max(1, this.cssHeight));
    const zoomScale = (this.width / PITCH_LENGTH_M) * this.viewport.zoom;
    const offsetX = this.viewport.panX * ratio;
    const offsetY = this.viewport.panY * (this.height / Math.max(1, this.cssHeight));
    const radiusPx = Math.max(TOKEN_RADIUS_M * zoomScale, 22 * ratio);
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const token of this.tokens.values()) {
      const dx = token.x * zoomScale + offsetX - pointX;
      const dy = token.y * zoomScale + offsetY - pointY;
      const distance = Math.hypot(dx, dy);
      if (distance <= radiusPx && distance < bestDistance) {
        best = token.player.playerId;
        bestDistance = distance;
      }
    }
    return best;
  }

  // -- Player drag-and-drop (issue #458) --------------------------------------

  /** Starts dragging a player; false when the player is not on the pitch. */
  beginPlayerDrag(playerId: number): boolean {
    const token = this.tokens.get(playerId);
    if (!token) return false;
    this.draggingPlayerId = playerId;
    token.targetX = token.x;
    token.targetY = token.y;
    this.wake();
    return true;
  }

  /** Moves the dragged player to a canvas CSS-px point, clamped to the pitch. */
  dragPlayerTo(cssX: number, cssY: number): void {
    if (this.draggingPlayerId === null) return;
    const token = this.tokens.get(this.draggingPlayerId);
    if (!token) return;
    const world = screenToWorld(this.viewport, this.baseScaleCss(), cssX, cssY);
    const x = Math.min(PITCH_LENGTH_M, Math.max(0, world.x));
    const y = Math.min(PITCH_WIDTH_M, Math.max(0, world.y));
    token.x = x;
    token.y = y;
    token.targetX = x;
    token.targetY = y;
    this.wake();
  }

  /** Ends the drag and reports the drop position (world metres) to the owner. */
  endPlayerDrag(): { playerId: number; x: number; y: number } | null {
    if (this.draggingPlayerId === null) return null;
    const playerId = this.draggingPlayerId;
    this.draggingPlayerId = null;
    const token = this.tokens.get(playerId);
    if (!token) return null;
    const drop = { playerId, x: token.x, y: token.y };
    this.onPlayerDrop?.(playerId, token.x, token.y);
    this.wake();
    return drop;
  }

  // -- Ball trajectory vectors (issue #458) ------------------------------------

  /** Replaces the drawn pass vectors (world metres); progress animates 0 -> 1. */
  setTrajectories(vectors: TrajectoryVector[], durationSeconds = 0.9): void {
    this.trajectories = vectors.map((v) => ({ ...v, progress: 0, durationSeconds }));
    this.wake();
  }

  /** A pass from one on-pitch player to another, resolved to their slots. */
  setPass(fromPlayerId: number, toPlayerId: number, durationSeconds = 0.9): boolean {
    const from = this.tokens.get(fromPlayerId);
    const to = this.tokens.get(toPlayerId);
    if (!from || !to) return false;
    this.setTrajectories(
      [{ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }],
      durationSeconds
    );
    return true;
  }

  get trajectoryCount(): number {
    return this.trajectories.length;
  }

  // -- Formation transitions (issue #458) ---------------------------------------

  /**
   * Animates every player from its current slot to its new formation slot
   * (e.g. 4-3-3 -> 3-5-2) over `durationMs` with cubic ease-in-out, driven
   * by the renderer's animation frame loop. Reduced-motion / static profiles
   * snap instantly instead. New players still run on from the touchline.
   */
  transitionToLineup(players: PitchPlayer[], durationMs: number = DEFAULT_TRANSITION_MS): void {
    if (this.profile.name === "static" || durationMs <= 0) {
      this.setLineup(players);
      return;
    }
    const slots = new Map(layoutFormation(players).map((slot) => [slot.playerId, slot]));
    const steps = new Map<number, { fromX: number; fromY: number; toX: number; toY: number }>();
    for (const player of players) {
      const slot = slots.get(player.playerId)!;
      const token = this.tokens.get(player.playerId);
      if (!token) continue;
      steps.set(player.playerId, {
        fromX: token.x,
        fromY: token.y,
        toX: slot.x * PITCH_LENGTH_M,
        toY: slot.y * PITCH_WIDTH_M,
      });
    }
    // Reuse setLineup for token bookkeeping (targets, heat, leavers), then
    // override the motion with the timed interpolation below.
    this.setLineup(players);
    this.transitionSteps = steps;
    this.transitionElapsedMs = 0;
    this.transitionDurationMs = durationMs;
    this.wake();
  }

  /** Sizes the backing store to the element's CSS size and pixel ratio. */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.devicePixelRatio = devicePixelRatio;
    const ratio = Math.min(devicePixelRatio, this.profile.dprCap);
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (width === this.width && height === this.height && this.staticLayer) return;

    this.width = this.canvas.width = width;
    this.height = this.canvas.height = height;
    this.staticLayer = this.buildStaticLayer(width, height);
    this.viewport = clampPan(this.viewport, cssWidth, cssHeight, cssWidth / PITCH_LENGTH_M);
    this.wake();
  }

  /** Moves players to their formation slots; new players run on from the touchline. */
  setLineup(players: PitchPlayer[]): void {
    // A plain lineup replaces any timed formation transition in progress.
    this.transitionSteps = null;
    this.transitionElapsedMs = 0;
    this.transitionDurationMs = 0;
    const firstLineup = this.tokens.size === 0;
    const slots = new Map(layoutFormation(players).map((slot) => [slot.playerId, slot]));

    for (const player of players) {
      const slot = slots.get(player.playerId)!;
      const targetX = slot.x * PITCH_LENGTH_M;
      const targetY = slot.y * PITCH_WIDTH_M;
      const token = this.tokens.get(player.playerId);
      if (token) {
        Object.assign(token, { player, targetX, targetY, heatTarget: heatFor(player.points), leaving: false });
      } else {
        const animateIn = !firstLineup && this.profile.name !== "static";
        this.tokens.set(player.playerId, {
          player,
          x: targetX,
          y: animateIn ? TOUCHLINE_EXIT_Y : targetY,
          targetX,
          targetY,
          heat: heatFor(player.points),
          heatTarget: heatFor(player.points),
          opacity: 1,
          leaving: false,
          phase: (player.playerId * 2.399) % (2 * Math.PI),
          drawX: 0,
          drawY: 0,
        });
      }
    }

    for (const [playerId, token] of this.tokens) {
      if (slots.has(playerId)) continue;
      if (this.profile.name === "static") this.tokens.delete(playerId);
      else Object.assign(token, { leaving: true, targetY: TOUCHLINE_EXIT_Y });
    }
    this.wake();
  }

  /** Queues match-event animations; bursts are spread over frames to keep frame time flat. */
  pushEvents(events: PitchEvent[]): void {
    if (this.profile.maxParticles === 0 || events.length === 0) return;
    this.pending.push(...events);
    if (this.pending.length > MAX_PENDING_EVENTS) {
      // Under a backlog the newest events matter most; stale ones are dropped
      this.pending.splice(0, this.pending.length - MAX_PENDING_EVENTS);
    }
    this.wake();
  }

  /** Pauses the loop while the pitch is scrolled out of view. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.wake();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
    this.pool.clear();
    this.tokens.clear();
    this.pending = [];
    this.trajectories = [];
    this.flights = [];
    this.transitionSteps = null;
    this.draggingPlayerId = null;
    this.frameBudget.reset();
    // Release the backing stores right away instead of waiting for GC
    this.canvas.width = this.canvas.height = 0;
    if (this.staticLayer) this.staticLayer.width = this.staticLayer.height = 0;
    this.staticLayer = null;
  }

  private wake(): void {
    if (this.destroyed || !this.visible || this.frameId !== null || !this.staticLayer) return;
    this.frameId = this.requestFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.frameId = null;
    if (this.destroyed || !this.visible) return;

    const interval = this.lastFrameTime === null ? 1000 / 60 : now - this.lastFrameTime;
    // Frame cap (low-power profile); the first frame after waking always draws
    if (
      this.lastFrameTime !== null &&
      this.profile.minFrameIntervalMs > 0 &&
      interval < this.profile.minFrameIntervalMs - 1
    ) {
      this.frameId = this.requestFrame(this.frame);
      return;
    }
    this.lastFrameTime = now;
    this.monitorFrameRate(interval);

    const cpuStart = typeof performance !== "undefined" ? performance.now() : 0;
    this.update(Math.min(interval, 50) / 1000);
    this.draw(now / 1000);
    if (typeof performance !== "undefined") {
      this.frameBudget.record(performance.now() - cpuStart, interval);
    }

    if (this.needsAnimation()) this.frameId = this.requestFrame(this.frame);
    else this.lastFrameTime = null;
  };

  /** Steps down to the low-power profile when frames are consistently slow. */
  private monitorFrameRate(interval: number): void {
    if (this.profile.name !== "high") return;
    this.slowFrames = interval > SLOW_FRAME_MS && interval < 250 ? this.slowFrames + 1 : 0;
    if (this.slowFrames < SLOW_FRAMES_BEFORE_DOWNGRADE) return;

    this.profile = QUALITY_PROFILES.low;
    this.pool = new ParticlePool(this.profile.maxParticles);
    this.width = 0; // force the backing store down to the low profile's pixel ratio
    this.resize(this.cssWidth, this.cssHeight, this.devicePixelRatio);
  }

  private needsAnimation(): boolean {
    if (
      this.profile.idleMotion ||
      this.pool.count > 0 ||
      this.flights.length > 0 ||
      this.pending.length > 0 ||
      this.trajectories.length > 0 ||
      this.transitionSteps !== null ||
      this.draggingPlayerId !== null
    ) {
      return true;
    }
    for (const token of this.tokens.values()) {
      if (
        token.leaving ||
        Math.abs(token.targetX - token.x) > 0.01 ||
        Math.abs(token.targetY - token.y) > 0.01 ||
        Math.abs(token.heatTarget - token.heat) > 0.005
      ) {
        return true;
      }
    }
    return false;
  }

  private update(dt: number): void {
    // Formation transition: timed cubic interpolation overrides easing.
    // The steps are precomputed once at transition start, so no per-frame
    // allocation happens in the hot path.
    if (this.transitionSteps) {
      this.transitionElapsedMs += dt * 1000;
      const t = Math.min(1, this.transitionElapsedMs / this.transitionDurationMs);
      const eased = easeInOutCubic(t);
      for (const [playerId, step] of this.transitionSteps) {
        const token = this.tokens.get(playerId);
        if (!token) continue;
        token.x = step.fromX + (step.toX - step.fromX) * eased;
        token.y = step.fromY + (step.toY - step.fromY) * eased;
      }
      if (t >= 1) {
        for (const [playerId, step] of this.transitionSteps) {
          const token = this.tokens.get(playerId);
          if (!token) continue;
          token.x = step.toX;
          token.y = step.toY;
          token.targetX = step.toX;
          token.targetY = step.toY;
        }
        this.transitionSteps = null;
      }
    }

    // Frame-rate independent easing (skipped for the dragged token: it
    // follows the pointer exactly, and for transitioned tokens above).
    const ease = this.profile.name === "static" ? 1 : 1 - Math.exp(-EASING_RATE * dt);
    for (const [playerId, token] of this.tokens) {
      if (playerId === this.draggingPlayerId) continue;
      if (this.transitionSteps?.has(playerId)) {
        // Position is owned by the transition this frame; heat still eases.
        token.heat += (token.heatTarget - token.heat) * ease;
        continue;
      }
      token.x += (token.targetX - token.x) * ease;
      token.y += (token.targetY - token.y) * ease;
      token.heat += (token.heatTarget - token.heat) * ease;
      if (token.leaving) {
        token.opacity -= dt * 1.5;
        if (token.opacity <= 0) this.tokens.delete(playerId);
      }
    }

    for (let started = 0; started < this.profile.burstsPerFrame && this.pending.length > 0; started++) {
      this.startEvent(this.pending.shift()!);
    }

    // In-place compaction: no per-frame allocation
    let active = 0;
    for (const flight of this.flights) {
      flight.elapsed += dt;
      if (flight.elapsed < BALL_FLIGHT_SECONDS) this.flights[active++] = flight;
      else this.burst("GOAL", PITCH_LENGTH_M, PITCH_WIDTH_M / 2);
    }
    this.flights.length = active;

    // Ball trajectory vectors advance and retire when the pass arrives.
    let liveTrajectories = 0;
    for (const trajectory of this.trajectories) {
      trajectory.progress += dt / trajectory.durationSeconds;
      if (trajectory.progress < 1) this.trajectories[liveTrajectories++] = trajectory;
    }
    this.trajectories.length = liveTrajectories;

    this.pool.update(dt, 2.2);
  }

  private startEvent(event: PitchEvent): void {
    const token = this.tokens.get(event.playerId);
    if (!token) return;
    token.heat = Math.min(1, token.heat + 0.35);

    if (event.kind === "GOAL" && this.flights.length < MAX_BALL_FLIGHTS) {
      this.flights.push({ fromX: token.x, fromY: token.y, elapsed: 0 });
    } else {
      this.burst(event.kind, token.x, token.y);
    }
  }

  private burst(kind: PitchEventKind, x: number, y: number): void {
    const spec = BURSTS[kind];
    for (let i = 0; i < spec.count; i++) {
      const angle = (i / spec.count) * Math.PI * 2 + Math.random() * 0.4;
      const speed = spec.speed * (0.4 + Math.random() * 0.6);
      this.pool.spawn(
        x,
        y,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        spec.life * (0.7 + Math.random() * 0.3),
        spec.size,
        spec.colors[i % spec.colors.length]
      );
    }
  }

  private draw(time: number): void {
    const ctx = this.ctx;
    const scale = this.width / PITCH_LENGTH_M;
    const { zoom, panX, panY } = this.viewport;
    const zoomScale = scale * zoom;
    const ratio = this.width / Math.max(1, this.cssWidth);
    const offsetX = panX * ratio;
    const offsetY = panY * ratio;
    // Crisp sub-pixel anti-aliasing: high-quality smoothing for the cached
    // layers, and half-pixel-snapped coordinates for 1px vector lines.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = 1;
    // The static pitch is one cached layer, blitted through the viewport
    // transform — zooming and panning never redraw the grass or markings.
    ctx.drawImage(this.staticLayer!, offsetX, offsetY, this.width * zoom, this.height * zoom);
    this.drawStats.staticBlits++;

    // Virtualization: only tokens inside the visible world rect are drawn.
    const visibleRect = visibleWorldRect(this.viewport, this.baseScaleCss(), this.cssWidth, this.cssHeight);
    const visibleTokens: Token[] = [];
    let culled = 0;
    for (const token of this.tokens.values()) {
      if (isWorldPointVisible(visibleRect, token.x, token.y)) visibleTokens.push(token);
      else culled++;
    }
    this.lastDrawnTokens = visibleTokens.length;
    this.lastCulledTokens = culled;
    this.drawStats.draws++;

    const drift = this.profile.idleMotion;
    for (const token of visibleTokens) {
      token.drawX = (token.x + (drift ? 0.8 * Math.sin(time * 0.7 + token.phase) : 0)) * zoomScale + offsetX;
      token.drawY = (token.y + (drift ? 0.6 * Math.sin(time * 0.9 + token.phase * 1.3) : 0)) * zoomScale + offsetY;
    }

    // Heatmap: where this squad's points are coming from
    for (const token of visibleTokens) {
      const radius = (5 + 5 * token.heat) * zoomScale;
      ctx.globalAlpha = token.heat * 0.6 * Math.max(0, token.opacity);
      ctx.drawImage(this.heatSprite, token.drawX - radius, token.drawY - radius, radius * 2, radius * 2);
    }

    this.drawTrajectories(zoomScale, offsetX, offsetY);

    // Particles, batching fill colour changes; off-viewport ones are skipped.
    let currentColor = -1;
    this.pool.forEach((p) => {
      if (!isWorldPointVisible(visibleRect, p.x, p.y)) return;
      if (p.color !== currentColor) {
        currentColor = p.color;
        ctx.fillStyle = PALETTE[p.color];
      }
      ctx.globalAlpha = p.remaining;
      const size = p.size * zoomScale;
      ctx.fillRect(p.x * zoomScale + offsetX - size / 2, p.y * zoomScale + offsetY - size / 2, size, size);
    });

    // Goal-bound balls
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    for (const flight of this.flights) {
      const t = flight.elapsed / BALL_FLIGHT_SECONDS;
      const eased = 1 - (1 - t) * (1 - t);
      const x = flight.fromX + (PITCH_LENGTH_M - flight.fromX) * eased;
      const y = flight.fromY + (PITCH_WIDTH_M / 2 - flight.fromY) * eased;
      ctx.beginPath();
      ctx.arc(x * zoomScale + offsetX, y * zoomScale + offsetY, Math.max(2, 0.8 * zoomScale), 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawPlayers(zoomScale, visibleTokens);
    ctx.globalAlpha = 1;
  }

  /** Arced ball trajectory vectors with arrowheads and a travelling ball. */
  private drawTrajectories(zoomScale: number, offsetX: number, offsetY: number): void {
    if (this.trajectories.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, 0.18 * zoomScale);
    ctx.setLineDash([Math.max(2, 0.6 * zoomScale), Math.max(2, 0.45 * zoomScale)]);
    for (const trajectory of this.trajectories) {
      const toScreen = (point: { x: number; y: number }) => ({
        x: snapToPixel(point.x * zoomScale + offsetX),
        y: snapToPixel(point.y * zoomScale + offsetY),
      });
      // Sample the arc so the dashed vector follows the curve.
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const point = toScreen(trajectoryPoint(trajectory, i / 16));
        if (i === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
      // Arrowhead at the tip, pointing along the pass.
      const tip = toScreen({ x: trajectory.toX, y: trajectory.toY });
      const [left, right] = arrowheadPoints(tip.x, tip.y, trajectoryHeading(trajectory), Math.max(4, 0.9 * zoomScale));
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      ctx.fill();
      ctx.setLineDash([Math.max(2, 0.6 * zoomScale), Math.max(2, 0.45 * zoomScale)]);
      // The ball itself, travelling along the arc.
      const ball = toScreen(trajectoryPoint(trajectory, Math.min(1, trajectory.progress)));
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, Math.max(2.5, 0.55 * zoomScale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPlayers(scale: number, tokens: Token[]): void {
    const ctx = this.ctx;
    const ratio = this.width / Math.max(1, this.cssWidth);
    const radius = Math.max(TOKEN_RADIUS_M * scale, 9 * ratio);
    const fontSize = Math.round(Math.min(12, Math.max(9, this.cssWidth / 40)) * ratio);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const token of tokens) {
      const { drawX: x, drawY: y, player } = token;
      ctx.globalAlpha = Math.max(0, token.opacity);

      // Player kit: position colour (or the club kit override), white trim,
      // and a lighter inner disc so the token reads as a shirt, not a blob.
      const kit = player.kitPrimary ?? KIT_COLORS[player.position];
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = kit;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, radius * 0.16);
      ctx.strokeStyle = player.isCaptain ? "#facc15" : player.isViceCaptain ? "#cbd5e1" : "rgba(255,255,255,0.75)";
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(String(player.points), x, y);

      ctx.font = `600 ${Math.round(fontSize * 0.9)}px ui-sans-serif, system-ui, sans-serif`;
      const label = player.name.length > 11 ? `${player.name.slice(0, 10)}…` : player.name;
      ctx.fillStyle = "rgba(2,6,23,0.7)";
      const labelWidth = ctx.measureText(label).width + fontSize * 0.6;
      ctx.fillRect(x - labelWidth / 2, y + radius + fontSize * 0.2, labelWidth, fontSize * 1.2);
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(label, x, y + radius + fontSize * 0.8);

      // Status badges: captain / vice-captain, then availability. The badge
      // sits top-right of the kit so it never covers the points or the name.
      const badge = statusBadge(player);
      if (badge) {
        const badgeRadius = Math.max(4 * ratio, fontSize * 0.55);
        const badgeX = x + radius * 0.78;
        const badgeY = y - radius * 0.78;
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.fillStyle = badge.fill;
        ctx.fill();
        ctx.lineWidth = Math.max(1, badgeRadius * 0.18);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.stroke();
        ctx.fillStyle = badge.text;
        ctx.font = `800 ${Math.round(badgeRadius * 1.1)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(badge.letter, badgeX, badgeY + badgeRadius * 0.05);
      }
    }
  }

  private buildHeatSprite(): Surface {
    const size = 64;
    const sprite = this.createSurface(size, size);
    const ctx = sprite.getContext("2d") as Context2D | null;
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, "rgba(250,204,21,0.95)");
      gradient.addColorStop(0.5, "rgba(249,115,22,0.4)");
      gradient.addColorStop(1, "rgba(249,115,22,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    return sprite;
  }

  /** Grass and markings never change between frames, so they are drawn once per size. */
  private buildStaticLayer(width: number, height: number): Surface {
    if (this.staticLayer) this.staticLayer.width = this.staticLayer.height = 0;
    const layer = this.createSurface(width, height);
    const ctx = layer.getContext("2d") as Context2D | null;
    if (!ctx) return layer;

    const s = width / PITCH_LENGTH_M;
    const stripes = 10;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#166534" : "#15803d";
      ctx.fillRect((i * width) / stripes, 0, width / stripes + 1, height);
    }

    // IFAB Law 1 markings, in metres (lines at most 12 cm wide)
    const midY = PITCH_WIDTH_M / 2;
    const line = Math.max(1, 0.12 * s);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = line;
    ctx.strokeRect(line / 2, line / 2, width - line, height - line);

    const path = (draw: () => void) => {
      ctx.beginPath();
      draw();
      ctx.stroke();
    };
    const spot = (x: number) => {
      ctx.beginPath();
      ctx.arc(x * s, midY * s, Math.max(1.5, 0.3 * s), 0, Math.PI * 2);
      ctx.fill();
    };

    path(() => {
      ctx.moveTo((PITCH_LENGTH_M / 2) * s, 0);
      ctx.lineTo((PITCH_LENGTH_M / 2) * s, height);
    });
    path(() => ctx.arc((PITCH_LENGTH_M / 2) * s, midY * s, 9.15 * s, 0, Math.PI * 2));
    spot(PITCH_LENGTH_M / 2);

    // Arc angle where the 9.15 m circle around the penalty spot leaves the penalty area
    const arcAngle = Math.acos((16.5 - 11) / 9.15);
    for (const [goalLine, inward] of [[0, 1], [PITCH_LENGTH_M, -1]] as const) {
      const box = (depth: number, boxWidth: number) =>
        path(() => {
          ctx.rect(
            Math.min(goalLine, goalLine + inward * depth) * s,
            (midY - boxWidth / 2) * s,
            depth * s,
            boxWidth * s
          );
        });
      box(16.5, 40.32); // penalty area
      box(5.5, 18.32); // goal area
      const penaltySpot = goalLine + inward * 11;
      spot(penaltySpot);
      const facing = inward === 1 ? 0 : Math.PI;
      path(() => ctx.arc(penaltySpot * s, midY * s, 9.15 * s, facing - arcAngle, facing + arcAngle));
      // Goal mouth (7.32 m)
      ctx.save();
      ctx.lineWidth = line * 3;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      path(() => {
        ctx.moveTo(goalLine * s, (midY - 3.66) * s);
        ctx.lineTo(goalLine * s, (midY + 3.66) * s);
      });
      ctx.restore();
    }
    return layer;
  }
}
