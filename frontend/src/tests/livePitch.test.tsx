import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LivePlayerEvent, LivePlayerPoints, Position } from "../types";
import {
  countingPlayers,
  diffPlayerEvents,
  layoutFormation,
  QUALITY_PROFILES,
  QualityProfile,
  selectQualityProfile,
} from "../components/pitch/livePitchModel";
import { ParticlePool } from "../components/pitch/particlePool";
import { LivePitchRenderer, PitchPlayer } from "../components/pitch/livePitchRenderer";
import { LivePitchCanvas } from "../components/pitch/LivePitchCanvas";

/** Issue #333: canvas live pitch — layout, events, bounded effects, degradation. */

const FORMATION_442: Array<[number, Position]> = [
  [1, Position.GKP],
  [2, Position.DEF], [3, Position.DEF], [4, Position.DEF], [5, Position.DEF],
  [6, Position.MID], [7, Position.MID], [8, Position.MID], [9, Position.MID],
  [10, Position.FWD], [11, Position.FWD],
];

function livePlayer(playerId: number, position: Position, overrides: Partial<LivePlayerPoints> = {}): LivePlayerPoints {
  return {
    playerId,
    name: `Player ${playerId}`,
    teamShortName: "ARS",
    position,
    isStarter: true,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: playerId,
    minutesPlayed: 90,
    rawPoints: 2,
    multiplier: 1,
    effectivePoints: 2,
    subbedIn: false,
    subbedOut: false,
    ...overrides,
  };
}

const lineup442 = () => FORMATION_442.map(([id, pos]) => livePlayer(id, pos));

const pitchPlayers = (): PitchPlayer[] =>
  FORMATION_442.map(([playerId, position]) => ({
    playerId,
    name: `Player ${playerId}`,
    position,
    positionOrder: playerId,
    points: 2,
    isCaptain: playerId === 7,
    isViceCaptain: false,
  }));

function counters(playerId: number, overrides: Partial<LivePlayerEvent> = {}): LivePlayerEvent {
  return {
    playerId,
    playerName: `Player ${playerId}`,
    teamShortName: "ARS",
    goals: 0,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    saves: 0,
    bonus: 0,
    totalPoints: 0,
    ...overrides,
  };
}

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
function harness(profile: QualityProfile) {
  const canvas = fakeSurface();
  let surfaces = 0;
  let queued: FrameRequestCallback | null = null;
  let now = 0;
  let cancelled = 0;
  const renderer = new LivePitchRenderer(canvas as unknown as HTMLCanvasElement, {
    profile,
    createSurface: (w, h) => {
      surfaces++;
      return Object.assign(fakeSurface(), { width: w, height: h }) as unknown as OffscreenCanvas;
    },
    requestFrame: (cb) => {
      queued = cb;
      return 1;
    },
    cancelFrame: () => {
      cancelled++;
      queued = null;
    },
  });
  return {
    renderer,
    canvas,
    surfaces: () => surfaces,
    cancelled: () => cancelled,
    hasFrame: () => queued !== null,
    /** Runs one animation frame `intervalMs` after the previous one. */
    tick(intervalMs = 1000 / 60) {
      now += intervalMs;
      const cb = queued;
      queued = null;
      cb?.(now);
      return cb !== null;
    },
  };
}

describe("livePitchModel (#333)", () => {
  it("lays a 4-4-2 out in four lines, keeper deepest, evenly spread and in order", () => {
    const slots = layoutFormation(lineup442());
    assert.equal(slots.length, 11);
    const byId = new Map(slots.map((s) => [s.playerId, s]));
    assert.ok(byId.get(1)!.x < byId.get(2)!.x && byId.get(2)!.x < byId.get(6)!.x && byId.get(6)!.x < byId.get(10)!.x);
    const defenders = [2, 3, 4, 5].map((id) => byId.get(id)!);
    assert.ok(defenders.every((d) => d.x === defenders[0].x));
    assert.deepEqual(defenders.map((d) => d.y), [...defenders.map((d) => d.y)].sort((a, b) => a - b));
    assert.ok(slots.every((s) => s.x > 0 && s.x < 1 && s.y > 0 && s.y < 1));
    assert.equal(new Set(slots.map((s) => `${s.x}:${s.y}`)).size, 11, "no two players share a slot");
  });

  it("counts starters not subbed out plus bench players subbed in", () => {
    const lineup = [
      ...lineup442(),
      livePlayer(12, Position.DEF, { isStarter: false, subbedIn: true }),
      livePlayer(13, Position.MID, { isStarter: false }),
    ];
    lineup[1] = { ...lineup[1], subbedOut: true };
    const ids = countingPlayers(lineup).map((p) => p.playerId);
    assert.equal(ids.length, 11);
    assert.ok(ids.includes(12) && !ids.includes(2) && !ids.includes(13));
  });

  it("emits events only for counter increases of players on the pitch, capped per counter", () => {
    const before = new Map([[9, counters(9)], [1, counters(1, { saves: 2 })]]);
    const onPitch = new Set([1, 9]);
    assert.deepEqual(diffPlayerEvents(before, [counters(9), counters(1, { saves: 2 })], onPitch), []);

    const events = diffPlayerEvents(
      before,
      [counters(9, { goals: 1, yellowCards: 1 }), counters(1, { saves: 10 }), counters(50, { goals: 3 })],
      onPitch
    );
    assert.deepEqual(events.filter((e) => e.playerId === 9).map((e) => e.kind), ["GOAL", "YELLOW_CARD"]);
    assert.equal(events.filter((e) => e.kind === "SAVE").length, 3, "8 new saves capped at 3 animations");
    assert.ok(!events.some((e) => e.playerId === 50), "bench players do not animate");
  });

  it("picks a still pitch for reduced motion and the low-power profile for weak devices", () => {
    assert.equal(selectQualityProfile({ prefersReducedMotion: true, deviceMemory: 16 }).name, "static");
    assert.equal(selectQualityProfile({ prefersReducedMotion: false, deviceMemory: 8, hardwareConcurrency: 8 }).name, "high");
    assert.equal(selectQualityProfile({ prefersReducedMotion: false }).name, "high");
    assert.equal(selectQualityProfile({ prefersReducedMotion: false, deviceMemory: 2 }).name, "low");
    assert.equal(selectQualityProfile({ prefersReducedMotion: false, hardwareConcurrency: 2 }).name, "low");
    assert.equal(selectQualityProfile({ prefersReducedMotion: false, saveData: true }).name, "low");
  });
});

describe("ParticlePool (#333)", () => {
  it("never exceeds its capacity, recycling the oldest slots under a burst storm", () => {
    const pool = new ParticlePool(64);
    for (let i = 0; i < 10_000; i++) pool.spawn(i, 0, 1, 1, 5, 1, 0);
    assert.equal(pool.count, 64);
  });

  it("removes expired particles and keeps the rest moving", () => {
    const pool = new ParticlePool(8);
    pool.spawn(0, 0, 10, 0, 0.5, 1, 1);
    pool.spawn(0, 0, 10, 0, 2, 1, 2);
    pool.spawn(0, 0, 10, 0, 0.5, 1, 3);
    pool.update(1, 0);
    assert.equal(pool.count, 1);
    const seen: Array<{ x: number; color: number; remaining: number }> = [];
    pool.forEach((p) => seen.push({ x: p.x, color: p.color, remaining: p.remaining }));
    assert.deepEqual(seen, [{ x: 10, color: 2, remaining: 0.5 }]);
  });

  it("a zero-capacity pool (static profile) spawns nothing", () => {
    const pool = new ParticlePool(0);
    assert.equal(pool.spawn(0, 0, 0, 0, 1, 1, 0), false);
    assert.equal(pool.count, 0);
  });
});

describe("LivePitchRenderer (#333)", () => {
  it("pre-renders the pitch once per size and caps the backing store's pixel ratio", () => {
    const h = harness(QUALITY_PROFILES.high);
    const afterSprite = h.surfaces();
    h.renderer.resize(400, 259, 3);
    assert.equal(h.canvas.width, 800, "DPR 3 capped to 2");
    h.renderer.resize(400, 259, 3);
    assert.equal(h.surfaces() - afterSprite, 1, "same size reuses the static layer");
    h.renderer.resize(320, 207, 3);
    assert.equal(h.surfaces() - afterSprite, 2);
  });

  it("spreads a 500-event burst over frames with bounded per-frame work and memory", () => {
    const h = harness(QUALITY_PROFILES.high);
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers());
    const events = Array.from({ length: 500 }, (_, i) => ({
      playerId: (i % 11) + 1,
      kind: (["GOAL", "ASSIST", "SAVE", "YELLOW_CARD", "RED_CARD"] as const)[i % 5],
    }));
    h.renderer.pushEvents(events);
    assert.equal(h.renderer.pendingEventCount, 96, "backlog bounded, oldest dropped");

    let previousPending = h.renderer.pendingEventCount;
    for (let frame = 0; frame < 60; frame++) {
      h.tick();
      const started = previousPending - h.renderer.pendingEventCount;
      assert.ok(started <= QUALITY_PROFILES.high.burstsPerFrame, `frame ${frame} started ${started} bursts`);
      assert.ok(h.renderer.particleCount <= QUALITY_PROFILES.high.maxParticles);
      previousPending = h.renderer.pendingEventCount;
    }
    assert.equal(h.renderer.pendingEventCount, 0);
  });

  it("goes idle once animations settle when there is no idle motion (low-power profile)", () => {
    const h = harness(QUALITY_PROFILES.low);
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers());
    h.renderer.pushEvents([{ playerId: 10, kind: "GOAL" }]);
    let frames = 0;
    while (h.tick(1000 / 30) && frames < 1000) frames++;
    assert.ok(frames < 1000, "the loop stops by itself");
    assert.equal(h.hasFrame(), false);
    assert.equal(h.renderer.particleCount, 0);

    h.renderer.pushEvents([{ playerId: 1, kind: "SAVE" }]);
    assert.equal(h.hasFrame(), true, "new events wake the loop");
  });

  it("the static profile draws one still frame and ignores effects", () => {
    const h = harness(QUALITY_PROFILES.static);
    h.renderer.resize(400, 259, 1);
    h.renderer.setLineup(pitchPlayers());
    h.renderer.pushEvents([{ playerId: 10, kind: "GOAL" }]);
    assert.equal(h.renderer.pendingEventCount, 0);
    assert.equal(h.tick(), true);
    assert.equal(h.hasFrame(), false, "nothing left to animate");
    assert.ok((h.canvas.calls.arc ?? 0) >= 11, "players were drawn");
  });

  it("downgrades itself to the low-power profile when frames are consistently slow", () => {
    const h = harness(QUALITY_PROFILES.high);
    h.renderer.resize(400, 259, 2);
    h.renderer.setLineup(pitchPlayers());
    for (let i = 0; i < 100; i++) h.tick(40);
    assert.equal(h.renderer.qualityProfile.name, "low");
    assert.equal(h.canvas.width, 400, "backing store dropped to DPR 1");
  });

  it("pauses while hidden and releases its buffers on destroy", () => {
    const h = harness(QUALITY_PROFILES.high);
    h.renderer.resize(400, 259, 1);
    h.renderer.setVisible(false);
    h.tick();
    h.renderer.setLineup(pitchPlayers());
    assert.equal(h.hasFrame(), false, "no frames while off-screen");
    h.renderer.setVisible(true);
    assert.equal(h.hasFrame(), true);
    h.renderer.destroy();
    assert.equal(h.cancelled(), 1);
    assert.equal(h.canvas.width, 0);
  });
});

describe("LivePitchCanvas (#333)", () => {
  it("renders an accessible, aspect-locked canvas describing the counting players", () => {
    const lineup = [...lineup442(), livePlayer(12, Position.FWD, { isStarter: false })];
    lineup[6] = { ...lineup[6], isCaptain: true, effectivePoints: 14 };
    const markup = renderToStaticMarkup(<LivePitchCanvas lineup={lineup} />);

    assert.match(markup, /<canvas[^>]*role="img"/);
    assert.match(markup, /data-testid="live-pitch-canvas"/);
    assert.match(markup, /aspect-ratio:105 \/ 68/);
    assert.match(markup, /Player 7 14 pts \(captain\)/);
    assert.doesNotMatch(markup, /Player 12/, "bench players are not on the pitch");
  });
});
