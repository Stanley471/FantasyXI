import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { LivePlayerPoints, Position } from "../types";
import { QUALITY_PROFILES, QualityProfile } from "../components/pitch/livePitchModel";
import { LivePitchRenderer, PitchPlayer } from "../components/pitch/livePitchRenderer";
import { LivePitchCanvas } from "../components/pitch/LivePitchCanvas";
import {
  arrowheadPoints,
  clampPan,
  clampZoom,
  createViewport,
  easeInOutCubic,
  FrameBudgetTracker,
  FRAME_BUDGET_MS,
  interpolateFormation,
  PitchGestureTracker,
  screenToWorld,
  snapToPixel,
  trajectoryPoint,
  visibleWorldRect,
  worldToScreen,
  zoomAtPoint,
} from "../components/pitch/canvasPitchViewport";

/** Issue #458: virtualized canvas pitch renderer — viewport, gestures,
 *  formation transitions, trajectories, kits/badges, semantic fallback and
 *  remount leak benchmarks. Harness numbers are node/jsdom measurements,
 *  not real-device claims. */

const FORMATION_433: Array<[number, Position]> = [
  [1, Position.GKP],
  [2, Position.DEF], [3, Position.DEF], [4, Position.DEF], [5, Position.DEF],
  [6, Position.MID], [7, Position.MID], [8, Position.MID],
  [9, Position.FWD], [10, Position.FWD], [11, Position.FWD],
];

const FORMATION_352: Array<[number, Position]> = [
  [1, Position.GKP],
  [2, Position.DEF], [3, Position.DEF], [4, Position.DEF],
  [5, Position.MID], [6, Position.MID], [7, Position.MID], [8, Position.MID], [9, Position.MID],
  [10, Position.FWD], [11, Position.FWD],
];

function livePlayer(playerId: number, position: Position): LivePlayerPoints {
  return {
    playerId,
    name: `Player ${playerId}`,
    teamShortName: "ARS",
    position,
    isStarter: true,
    isCaptain: playerId === 7,
    isViceCaptain: false,
    positionOrder: playerId,
    minutesPlayed: 90,
    rawPoints: 2,
    multiplier: 1,
    effectivePoints: 2,
    subbedIn: false,
    subbedOut: false,
  };
}

const lineup433 = () => FORMATION_433.map(([id, pos]) => livePlayer(id, pos));

const pitchPlayers = (formation: Array<[number, Position]>): PitchPlayer[] =>
  formation.map(([playerId, position]) => ({
    playerId,
    name: `Player ${playerId}`,
    position,
    positionOrder: playerId,
    points: 2,
    isCaptain: playerId === 7,
    isViceCaptain: false,
  }));

/** Minimal Canvas 2D stand-in: accepts every call and property, records draw calls. */
function fakeContext() {
  const calls: Record<string, number> = {};
  const ctx = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "measureText") return () => ({ width: 10 });
        if (prop === "createRadialGradient") return () => ({ addColorStop() {} });
        return () => {
          calls[prop] = (calls[prop] ?? 0) + 1;
        };
      },
      set: () => true,
    }
  );
  return { ctx, calls };
}

function fakeSurface() {
  const { ctx, calls } = fakeContext();
  return { width: 0, height: 0, getContext: () => ctx, calls };
}

/** Renderer on a fake canvas with a manually advanced frame clock. */
function harness(profile: QualityProfile, onPlayerDrop?: (id: number, x: number, y: number) => void) {
  const canvas = fakeSurface();
  let queued: FrameRequestCallback | null = null;
  let now = 0;
  let cancelled = 0;
  const renderer = new LivePitchRenderer(canvas as unknown as HTMLCanvasElement, {
    profile,
    createSurface: (w, h) => Object.assign(fakeSurface(), { width: w, height: h }) as unknown as OffscreenCanvas,
    requestFrame: (cb) => {
      queued = cb;
      return 1;
    },
    cancelFrame: () => {
      cancelled++;
      queued = null;
    },
    onPlayerDrop,
  });
  return {
    renderer,
    canvas,
    cancelled: () => cancelled,
    hasFrame: () => queued !== null,
    tick(intervalMs = 1000 / 60) {
      now += intervalMs;
      const cb = queued;
      queued = null;
      cb?.(now);
      return cb !== null;
    },
  };
}

describe("canvasPitchViewport math (#458)", () => {
  it("round-trips world <-> screen through zoom and pan", () => {
    const viewport = { zoom: 2, panX: 10, panY: -5 };
    const world = { x: 52.5, y: 34 };
    const screen = worldToScreen(viewport, 4, world.x, world.y);
    const back = screenToWorld(viewport, 4, screen.x, screen.y);
    assert.ok(Math.abs(back.x - world.x) < 1e-9);
    assert.ok(Math.abs(back.y - world.y) < 1e-9);
  });

  it("zoomAtPoint keeps the world point under the focal point fixed", () => {
    const viewport = createViewport();
    const before = screenToWorld(viewport, 4, 100, 80);
    const zoomed = zoomAtPoint(viewport, 4, 100, 80, 2);
    const after = screenToWorld(zoomed, 4, 100, 80);
    assert.equal(zoomed.zoom, 2);
    assert.ok(Math.abs(after.x - before.x) < 1e-9);
    assert.ok(Math.abs(after.y - before.y) < 1e-9);
  });

  it("clamps zoom to [0.5, 4] and pan so the pitch cannot leave the view", () => {
    assert.equal(clampZoom(100), 4);
    assert.equal(clampZoom(0.01), 0.5);
    assert.equal(clampZoom(Number.NaN), 1);
    const clamped = clampPan({ zoom: 1, panX: 10_000, panY: -10_000 }, 400, 259, 400 / 105);
    assert.ok(Math.abs(clamped.panX) < 10_000 && Math.abs(clamped.panY) < 10_000);
    assert.equal(clampPan(createViewport(), 400, 259, 400 / 105).panX, 0);
  });

  it("visibleWorldRect shrinks as zoom grows", () => {
    const whole = visibleWorldRect(createViewport(), 400 / 105, 400, 259);
    assert.ok(whole.minX <= 0 && whole.maxX >= 105 && whole.minY <= 0 && whole.maxY >= 68);
    const zoomed = visibleWorldRect({ zoom: 4, panX: 0, panY: 0 }, 400 / 105, 400, 259);
    assert.ok(zoomed.maxX - zoomed.minX < 40, "a 4x zoom shows under 40m of length");
    assert.ok(zoomed.maxY - zoomed.minY < 25, "a 4x zoom shows under 25m of width");
  });

  it("easeInOutCubic is 0/0.5/1 at 0/0.5/1 and interpolates formations along it", () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(0.5), 0.5);
    assert.equal(easeInOutCubic(1), 1);
    const from = new Map([[1, { x: 0, y: 0 }], [2, { x: 10, y: 10 }]]);
    const to = new Map([[1, { x: 10, y: 0 }], [2, { x: 10, y: 20 }], [3, { x: 5, y: 5 }]]);
    assert.deepEqual(interpolateFormation(from, to, 0).get(1), { x: 0, y: 0 });
    assert.deepEqual(interpolateFormation(from, to, 1).get(2), { x: 10, y: 20 });
    assert.deepEqual(interpolateFormation(from, to, 0.5).get(1), { x: 5, y: 0 });
    assert.deepEqual(interpolateFormation(from, to, 0.5).get(3), { x: 5, y: 5 }, "new players start at target");
    assert.deepEqual(from.get(1), { x: 0, y: 0 }, "inputs are not mutated");
  });

  it("trajectory arcs lift off the chord and arrowheads point along the pass", () => {
    const vector = { fromX: 0, fromY: 0, toX: 10, toY: 0 };
    const mid = trajectoryPoint(vector, 0.5);
    assert.equal(mid.x, 5);
    assert.ok(mid.y > 0.5 && mid.y < 1, `arc lift ${mid.y}`);
    assert.deepEqual(trajectoryPoint(vector, 0), { x: 0, y: 0 });
    assert.deepEqual(trajectoryPoint(vector, 1), { x: 10, y: 0 });
    const [left, right] = arrowheadPoints(10, 0, 0, 2);
    assert.ok(Math.abs(left.x - 8.268) < 0.01 && Math.abs(left.y - 1) < 0.01);
    assert.ok(Math.abs(right.x - 8.268) < 0.01 && Math.abs(right.y + 1) < 0.01);
    assert.equal(snapToPixel(10.2), 10.5, "half-pixel snap keeps 1px lines crisp");
  });

  it("FrameBudgetTracker reports avg/max/p95 and over-budget frames", () => {
    const tracker = new FrameBudgetTracker();
    for (const ms of [5, 10, 20, 8]) tracker.record(ms, 16.67);
    const stats = tracker.stats();
    assert.equal(stats.frames, 4);
    assert.equal(stats.avgMs, 10.75);
    assert.equal(stats.maxMs, 20);
    assert.equal(stats.p95Ms, 20);
    assert.equal(stats.overBudgetFrames, 1, "only the 20ms frame is over the 16.67ms budget");
    assert.ok(stats.avgIntervalMs > 16 && stats.avgIntervalMs < 17);
    tracker.reset();
    assert.equal(tracker.stats().frames, 0);
  });
});

describe("PitchGestureTracker (#458)", () => {
  it("pans on a one-finger drag with no player under the pointer", () => {
    const tracker = new PitchGestureTracker();
    assert.deepEqual(tracker.pointerDown(1, 50, 50, null, 1), []);
    const events = tracker.pointerMove(1, 60, 45);
    assert.deepEqual(events, [{ type: "pan", dx: 10, dy: -5 }]);
    assert.deepEqual(tracker.pointerUp(1), []);
  });

  it("drags the hit player and reports the drop on release", () => {
    const tracker = new PitchGestureTracker();
    assert.deepEqual(tracker.pointerDown(1, 24, 130, 7, 1), [{ type: "drag-start", playerId: 7 }]);
    assert.deepEqual(tracker.pointerMove(1, 100, 130), [
      { type: "drag-player", playerId: 7, screenX: 100, screenY: 130 },
    ]);
    assert.deepEqual(tracker.pointerUp(1), [{ type: "drag-end", playerId: 7 }]);
    assert.equal(tracker.draggingPlayerId, null);
  });

  it("a second finger cancels the drag and pinches around the midpoint", () => {
    const tracker = new PitchGestureTracker();
    tracker.pointerDown(1, 24, 130, 7, 1);
    assert.deepEqual(tracker.pointerDown(2, 124, 130, null, 1), [{ type: "drag-end", playerId: 7 }]);
    assert.equal(tracker.isPinching, true);
    const events = tracker.pointerMove(2, 144, 130);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "pinch");
    if (events[0].type === "pinch") {
      assert.ok(events[0].factor > 1, "fingers moving apart zooms in");
      assert.equal(events[0].focalX, 84);
      assert.equal(events[0].focalY, 130);
    }
    tracker.pointerUp(2);
    assert.equal(tracker.isPinching, false);
  });

  it("cancel() ends a drag and forgets all pointers", () => {
    const tracker = new PitchGestureTracker();
    tracker.pointerDown(1, 24, 130, 7, 1);
    assert.deepEqual(tracker.cancel(), [{ type: "drag-end", playerId: 7 }]);
    assert.equal(tracker.activePointerCount, 0);
  });
});

describe("LivePitchRenderer viewport, drag and trajectories (#458)", () => {
  it("zooms around a focal point, clamps to [0.5, 4], and pans", () => {
    const h = harness(QUALITY_PROFILES.high);
    h.renderer.resize(400, 259, 1);
    const centreBefore = h.renderer.screenToWorld(200, 129.5);
    h.renderer.zoomBy(2, 200, 129.5);
    assert.equal(h.renderer.viewportState.zoom, 2);
    const centreAfter = h.renderer.screenToWorld(200, 129.5);
    assert.ok(Math.abs(centreAfter.x - centreBefore.x) < 1e-9, "focal world point is fixed");
    h.renderer.zoomBy(100);
    assert.equal(h.renderer.viewportState.zoom, 4);
    h.renderer.zoomBy(0.0001);
    assert.equal(h.renderer.viewportState.zoom, 0.5);
    h.renderer.resetViewport();
    assert.deepEqual(h.renderer.viewportState, { zoom: 1, panX: 0, panY: 0 });
  });

  it("hit-tests players and drags one to a new world position, clamped to the pitch", () => {
    const drops: Array<{ id: number; x: number; y: number }> = [];
    const h = harness(QUALITY_PROFILES.high, (id, x, y) => drops.push({ id, x, y }));
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers(FORMATION_433));
    const keeper = h.renderer.worldToScreen(6.3, 34);
    assert.equal(h.renderer.hitTest(keeper.x, keeper.y), 1);
    assert.equal(h.renderer.hitTest(400, 10), null, "empty grass has no player");
    assert.equal(h.renderer.beginPlayerDrag(999), false);
    assert.equal(h.renderer.beginPlayerDrag(7), true);
    assert.equal(h.renderer.draggingPlayer, 7);
    h.renderer.dragPlayerTo(200, 130);
    const moved = h.renderer.getTokenWorldPosition(7)!;
    assert.ok(Math.abs(moved.x - 52.5) < 0.01 && Math.abs(moved.y - 34.1) < 0.1);
    h.renderer.dragPlayerTo(10_000, 10_000);
    const clamped = h.renderer.getTokenWorldPosition(7)!;
    assert.ok(clamped.x <= 105 && clamped.y <= 68, "drag cannot leave the pitch");
    const drop = h.renderer.endPlayerDrag();
    assert.equal(drop?.playerId, 7);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].id, 7);
    assert.equal(h.renderer.draggingPlayer, null);
    assert.equal(h.renderer.endPlayerDrag(), null);
  });

  it("draws ball trajectories and retires them when the pass arrives", () => {
    const h = harness(QUALITY_PROFILES.low);
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers(FORMATION_433));
    assert.equal(h.renderer.setPass(10, 7), true);
    assert.equal(h.renderer.trajectoryCount, 1);
    assert.equal(h.renderer.setPass(10, 999), false, "unknown target is rejected");
    h.renderer.setTrajectories([
      { fromX: 10, fromY: 10, toX: 50, toY: 30 },
      { fromX: 50, fromY: 30, toX: 90, toY: 34 },
    ]);
    assert.equal(h.renderer.trajectoryCount, 2);
    let frames = 0;
    while (h.renderer.trajectoryCount > 0 && frames < 200) {
      h.tick(1000 / 30);
      frames++;
    }
    assert.equal(h.renderer.trajectoryCount, 0, "both passes retire");
    assert.ok(frames > 10 && frames < 60, `passes retire after ~0.9s, took ${frames} frames at 30fps`);
  });

  it("virtualizes drawing: a 4x zoom culls off-viewport tokens", () => {
    const h = harness(QUALITY_PROFILES.high);
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers(FORMATION_433));
    h.tick();
    const whole = h.renderer.getDrawStats();
    assert.equal(whole.drawnTokens, 11);
    assert.equal(whole.culledTokens, 0);
    h.renderer.zoomBy(4, 0, 0);
    h.tick();
    const zoomed = h.renderer.getDrawStats();
    assert.ok(zoomed.staticBlits >= 2, "static layer is blitted, never redrawn, per frame");
    assert.equal(zoomed.drawnTokens, 1, "only one token is visible in the 4x corner view");
    assert.equal(zoomed.culledTokens, 10);
  });

  it("draws kits and status badges without breaking the still frame", () => {
    const h = harness(QUALITY_PROFILES.static);
    h.renderer.resize(400, 259, 1);
    const players = pitchPlayers(FORMATION_433);
    players[6] = { ...players[6], status: "injured", kitPrimary: "#dc2626", shirtNumber: 8 };
    h.renderer.setLineup(players);
    assert.equal(h.tick(), true);
    assert.ok((h.canvas.calls.arc ?? 0) >= 11, "kits are drawn as circles");
    assert.equal(h.hasFrame(), false, "static profile still draws one frame and stops");
  });
});

describe("formation transition benchmark (#458)", () => {
  it("glides 4-3-3 -> 3-5-2 in ~600ms at 60fps with sub-16ms harness frames", () => {
    const h = harness(QUALITY_PROFILES.high);
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers(FORMATION_433));
    for (let i = 0; i < 40; i++) h.tick();
    const start = h.renderer.getTokenWorldPosition(5)!;
    assert.ok(Math.abs(start.x - 28.35) < 0.5, "player 5 starts as a defender");

    const wallStart = performance.now();
    h.renderer.transitionToLineup(pitchPlayers(FORMATION_352), 600);
    assert.equal(h.renderer.isTransitioning, true);
    let frames = 0;
    let midPosition: { x: number; y: number } | null = null;
    while (h.renderer.isTransitioning && frames < 100) {
      h.tick();
      frames++;
      if (frames === 18) midPosition = h.renderer.getTokenWorldPosition(5);
    }
    const wallMs = performance.now() - wallStart;
    const stats = h.renderer.getFrameStats();

    assert.ok(frames >= 34 && frames <= 40, `600ms at 60fps takes ~36 frames, took ${frames}`);
    assert.ok(h.renderer.transitionProgress >= 1);
    assert.equal(h.renderer.isTransitioning, false);
    const end = h.renderer.getTokenWorldPosition(5)!;
    assert.ok(Math.abs(end.x - 53.55) < 0.5 && Math.abs(end.y - 15.87) < 0.5, "player 5 ends as a midfielder");
    assert.ok(midPosition !== null);
    assert.ok(midPosition!.x > start.x && midPosition!.x < end.x, "mid-transition position is between the slots");
    assert.ok(midPosition!.y > end.y && midPosition!.y < start.y);

    // Harness measurement (fake canvas, not a real device/GPU). p95 is the
    // frame-time metric: one warm-up spike is tolerated, sustained slowness
    // is not.
    assert.ok(stats.avgMs < FRAME_BUDGET_MS, `avg frame ${stats.avgMs.toFixed(3)}ms under ${FRAME_BUDGET_MS.toFixed(2)}ms`);
    assert.ok(stats.p95Ms < FRAME_BUDGET_MS, `p95 frame ${stats.p95Ms.toFixed(3)}ms under budget (max ${stats.maxMs.toFixed(3)}ms)`);
    assert.ok(stats.overBudgetFrames <= 1, `${stats.overBudgetFrames} frames over budget`);
    assert.ok(wallMs < 600, `36 harness frames run in ${wallMs.toFixed(1)}ms of wall time`);
  });

  it("a static profile snaps formations instantly instead of animating", () => {
    const h = harness(QUALITY_PROFILES.static);
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers(FORMATION_433));
    h.renderer.transitionToLineup(pitchPlayers(FORMATION_352), 600);
    assert.equal(h.renderer.isTransitioning, false);
    h.tick();
    const end = h.renderer.getTokenWorldPosition(5)!;
    assert.ok(Math.abs(end.x - 53.55) < 0.5);
  });
});

describe("remount leak benchmark (#458)", () => {
  it("50 mount/unmount cycles cancel every animation frame and release every buffer", () => {
    const wallStart = performance.now();
    let cancelled = 0;
    for (let i = 0; i < 50; i++) {
      const h = harness(QUALITY_PROFILES.high);
      h.renderer.resize(400, 259, 2);
      h.renderer.setLineup(pitchPlayers(FORMATION_433));
      h.renderer.setTrajectories([{ fromX: 10, fromY: 10, toX: 50, toY: 30 }]);
      assert.equal(h.hasFrame(), true, "cycle mounts with a live frame");
      h.renderer.destroy();
      cancelled += h.cancelled();
      assert.equal(h.hasFrame(), false, "no frame survives destroy");
      assert.equal(h.canvas.width, 0, "backing store released");
      assert.equal(h.renderer.tokenCount, 0);
      assert.equal(h.renderer.trajectoryCount, 0);
      assert.equal(h.renderer.getFrameStats().frames, 0, "frame history released");
    }
    const wallMs = performance.now() - wallStart;
    assert.equal(cancelled, 50, "one RAF cancelled per cycle, none leaked");
    assert.ok(wallMs < 5_000, `50 cycles take ${wallMs.toFixed(1)}ms`);

    // A fresh renderer still works after the churn.
    const fresh = harness(QUALITY_PROFILES.high);
    fresh.renderer.resize(400, 259, 1);
    fresh.renderer.setLineup(pitchPlayers(FORMATION_433));
    assert.equal(fresh.tick(), true);
  });
});

describe("LivePitchCanvas semantic fallback and gestures (#458)", () => {
  it("renders a hidden aria-live list with every player's data, and no bench players", () => {
    const bench = livePlayer(12, Position.FWD);
    bench.isStarter = false;
    const lineup = [...lineup433(), bench];
    lineup[6] = { ...lineup[6], isCaptain: true, effectivePoints: 14 };
    const markup = renderToStaticMarkup(<LivePitchCanvas lineup={lineup} />);

    assert.match(markup, /data-testid="live-pitch-semantic"/);
    assert.match(markup, /aria-live="polite"/);
    assert.match(markup, /Player 7, MID, 14 points, captain/);
    assert.match(markup, /metres along the pitch/);
    assert.match(markup, /metres across/);
    assert.doesNotMatch(markup, /Player 12/, "bench players are not on the pitch");
    assert.match(markup, /data-testid="live-pitch-announcer"/);
    assert.match(markup, /role="status"/);
    const items = markup.match(/<li>/g) ?? [];
    assert.equal(items.length, 11, "one semantic row per on-pitch player");
  });
});

// --- jsdom component tests: pointer drag, wheel zoom, remount listeners ---

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let rafQueue: Map<number, FrameRequestCallback>;
let rafIdCounter: number;
let cancelledRaf: number[];
let rafNow: number;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function runRafFrames(count: number, intervalMs = 1000 / 60) {
  for (let i = 0; i < count; i++) {
    rafNow += intervalMs;
    const callbacks = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of callbacks) cb(rafNow);
  }
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  rafQueue = new Map();
  rafIdCounter = 0;
  cancelledRaf = [];
  rafNow = 0;
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++rafIdCounter;
    rafQueue.set(id, cb);
    return id;
  });
  setGlobal("cancelAnimationFrame", (id: number) => {
    cancelledRaf.push(id);
    rafQueue.delete(id);
  });
  // jsdom has no layout: fix the container width so the pitch sizes itself.
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 400,
  });
  const { ctx } = fakeContext();
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  class ResizeObserverStub {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  setGlobal(
    "ResizeObserver",
    ResizeObserverStub as unknown as typeof ResizeObserver
  );
  dom.window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  class IntersectionObserverStub {
    constructor(private cb: IntersectionObserverCallback) {}
    observe() {
      this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  setGlobal(
    "IntersectionObserver",
    IntersectionObserverStub as unknown as typeof IntersectionObserver
  );
  dom.window.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("LivePitchCanvas gestures in jsdom (#458)", () => {
  it("drags a player by pointer and reports the drop position", () => {
    const drops: Array<{ id: number; x: number; y: number }> = [];
    act(() =>
      root.render(<LivePitchCanvas lineup={lineup433()} onPlayerMove={(id, x, y) => drops.push({ id, x, y })} />)
    );
    runRafFrames(3);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    assert.ok(canvas, "canvas mounted");
    // Keeper slot: 6.3m along, 34m across -> (24, 130) CSS px at 400px wide.
    canvas.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 24, clientY: 130 })
    );
    dom.window.dispatchEvent(
      new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 130 })
    );
    dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 130 }));
    assert.equal(drops.length, 1, "one drop reported");
    assert.equal(drops[0].id, 1, "the keeper was dragged");
    assert.ok(Math.abs(drops[0].x - 26.25) < 0.5, `drop x ${drops[0].x}`);
    assert.ok(Math.abs(drops[0].y - 34.1) < 0.5, `drop y ${drops[0].y}`);
    const announcer = container.querySelector('[data-testid="live-pitch-announcer"]')!;
    assert.match(announcer.textContent ?? "", /Player 1 moved to/);
  });

  it("wheel zoom announces the new zoom level", () => {
    act(() => root.render(<LivePitchCanvas lineup={lineup433()} />));
    runRafFrames(3);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    canvas.dispatchEvent(
      new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, clientX: 200, clientY: 130 })
    );
    const announcer = container.querySelector('[data-testid="live-pitch-announcer"]')!;
    assert.match(announcer.textContent ?? "", /Zoom \d+ percent/);
    assert.ok(!/Zoom 100 percent/.test(announcer.textContent ?? ""), "zoom moved off 100%");
  });

  it("rapid remounting leaks no animation frames and balances window listeners", () => {
    const added: Record<string, number> = {};
    const removed: Record<string, number> = {};
    const realAdd = dom.window.addEventListener.bind(dom.window);
    const realRemove = dom.window.removeEventListener.bind(dom.window);
    dom.window.addEventListener = ((type: string, ...rest: unknown[]) => {
      added[type] = (added[type] ?? 0) + 1;
      return (realAdd as (...args: unknown[]) => void)(type, ...(rest as []));
    }) as typeof dom.window.addEventListener;
    dom.window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed[type] = (removed[type] ?? 0) + 1;
      return (realRemove as (...args: unknown[]) => void)(type, ...(rest as []));
    }) as typeof dom.window.removeEventListener;

    for (let i = 0; i < 10; i++) {
      act(() => root.render(<LivePitchCanvas lineup={lineup433()} />));
      runRafFrames(2);
      assert.ok(rafQueue.size >= 0);
      act(() => root.unmount());
      assert.equal(rafQueue.size, 0, `cycle ${i}: no RAF survives unmount`);
      root = createRoot(container);
    }
    for (const type of ["pointermove", "pointerup", "pointercancel"]) {
      assert.equal(removed[type], added[type], `${type}: ${removed[type] ?? 0} removed vs ${added[type] ?? 0} added`);
      assert.ok((added[type] ?? 0) >= 10, `${type} was attached every mount`);
    }
    assert.ok(cancelledRaf.length >= 10, "each cycle's pending frame was cancelled");
  });
});
