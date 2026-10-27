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

export interface PitchPlayer {
  playerId: number;
  name: string;
  position: Position;
  positionOrder: number;
  points: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
}

type Surface = HTMLCanvasElement | OffscreenCanvas;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface LivePitchRendererOptions {
  profile: QualityProfile;
  /** Creates off-screen drawing surfaces (injectable for tests). */
  createSurface?: (width: number, height: number) => Surface;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
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

export class LivePitchRenderer {
  private profile: QualityProfile;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly createSurface: (width: number, height: number) => Surface;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;

  private pool: ParticlePool;
  private staticLayer: Surface | null = null;
  private readonly heatSprite: Surface;
  private readonly tokens = new Map<number, Token>();
  private pending: PitchEvent[] = [];
  private flights: BallFlight[] = [];

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
    this.wake();
  }

  /** Moves players to their formation slots; new players run on from the touchline. */
  setLineup(players: PitchPlayer[]): void {
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
    // Release the backing stores right away instead of waiting for GC
    this.canvas.width = this.canvas.height = 0;
    if (this.staticLayer) this.staticLayer.width = this.staticLayer.height = 0;
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

    this.update(Math.min(interval, 50) / 1000);
    this.draw(now / 1000);

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
    if (this.profile.idleMotion || this.pool.count > 0 || this.flights.length > 0 || this.pending.length > 0) {
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
    // Frame-rate independent easing
    const ease = this.profile.name === "static" ? 1 : 1 - Math.exp(-EASING_RATE * dt);
    for (const [playerId, token] of this.tokens) {
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
    ctx.globalAlpha = 1;
    ctx.drawImage(this.staticLayer!, 0, 0);

    const drift = this.profile.idleMotion;
    for (const token of this.tokens.values()) {
      token.drawX = (token.x + (drift ? 0.8 * Math.sin(time * 0.7 + token.phase) : 0)) * scale;
      token.drawY = (token.y + (drift ? 0.6 * Math.sin(time * 0.9 + token.phase * 1.3) : 0)) * scale;
    }

    // Heatmap: where this squad's points are coming from
    for (const token of this.tokens.values()) {
      const radius = (5 + 5 * token.heat) * scale;
      ctx.globalAlpha = token.heat * 0.6 * Math.max(0, token.opacity);
      ctx.drawImage(this.heatSprite, token.drawX - radius, token.drawY - radius, radius * 2, radius * 2);
    }

    // Particles, batching fill colour changes
    let currentColor = -1;
    this.pool.forEach((p) => {
      if (p.color !== currentColor) {
        currentColor = p.color;
        ctx.fillStyle = PALETTE[p.color];
      }
      ctx.globalAlpha = p.remaining;
      const size = p.size * scale;
      ctx.fillRect(p.x * scale - size / 2, p.y * scale - size / 2, size, size);
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
      ctx.arc(x * scale, y * scale, Math.max(2, 0.8 * scale), 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawPlayers(scale);
    ctx.globalAlpha = 1;
  }

  private drawPlayers(scale: number): void {
    const ctx = this.ctx;
    const ratio = this.width / Math.max(1, this.cssWidth);
    const radius = Math.max(TOKEN_RADIUS_M * scale, 9 * ratio);
    const fontSize = Math.round(Math.min(12, Math.max(9, this.cssWidth / 40)) * ratio);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const token of this.tokens.values()) {
      const { drawX: x, drawY: y, player } = token;
      ctx.globalAlpha = Math.max(0, token.opacity);

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = player.position === Position.GKP ? "#0284c7" : "#047857";
      ctx.fill();
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
