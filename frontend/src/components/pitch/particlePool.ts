/**
 * Fixed-capacity particle pool for the live pitch (issue #333).
 *
 * Particles live in one preallocated Float32Array (struct of arrays packed
 * per particle), so spawning and updating never allocate: memory is
 * O(capacity) for the pool's whole life and there is no garbage-collection
 * pressure during event bursts. Live particles are kept contiguous in
 * [0, count); a dead particle is replaced by the last live one (swap-remove),
 * so update is O(count) and spawn/kill are O(1). When full, spawning
 * overwrites slots round-robin, recycling the oldest effects first.
 */

const STRIDE = 8;
const X = 0;
const Y = 1;
const VX = 2;
const VY = 3;
const AGE = 4;
const LIFE = 5;
const SIZE = 6;
const COLOR = 7;

export interface ParticleView {
  x: number;
  y: number;
  /** 1 at birth, 0 at death. */
  remaining: number;
  size: number;
  color: number;
}

export class ParticlePool {
  readonly capacity: number;
  private readonly data: Float32Array;
  private live = 0;
  private recycleCursor = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(0, Math.floor(capacity));
    this.data = new Float32Array(this.capacity * STRIDE);
  }

  get count(): number {
    return this.live;
  }

  /** Returns false only when the pool has no capacity at all. */
  spawn(x: number, y: number, vx: number, vy: number, lifeSeconds: number, size: number, color: number): boolean {
    if (this.capacity === 0) return false;
    let slot: number;
    if (this.live < this.capacity) {
      slot = this.live++;
    } else {
      slot = this.recycleCursor;
      this.recycleCursor = (this.recycleCursor + 1) % this.capacity;
    }
    const o = slot * STRIDE;
    const d = this.data;
    d[o + X] = x;
    d[o + Y] = y;
    d[o + VX] = vx;
    d[o + VY] = vy;
    d[o + AGE] = 0;
    d[o + LIFE] = lifeSeconds;
    d[o + SIZE] = size;
    d[o + COLOR] = color;
    return true;
  }

  /** Advances every particle by `dt` seconds with velocity damping. */
  update(dt: number, damping: number): void {
    const d = this.data;
    const decay = Math.exp(-damping * dt);
    let i = 0;
    while (i < this.live) {
      const o = i * STRIDE;
      d[o + AGE] += dt;
      if (d[o + AGE] >= d[o + LIFE]) {
        this.live--;
        if (i !== this.live) d.copyWithin(o, this.live * STRIDE, this.live * STRIDE + STRIDE);
        continue; // re-examine the particle moved into this slot
      }
      d[o + X] += d[o + VX] * dt;
      d[o + Y] += d[o + VY] * dt;
      d[o + VX] *= decay;
      d[o + VY] *= decay;
      i++;
    }
    if (this.recycleCursor >= this.live) this.recycleCursor = 0;
  }

  /** Visits live particles; `view` is reused between calls, so copy what you keep. */
  forEach(visit: (view: ParticleView) => void): void {
    const d = this.data;
    const view: ParticleView = { x: 0, y: 0, remaining: 0, size: 0, color: 0 };
    for (let i = 0; i < this.live; i++) {
      const o = i * STRIDE;
      view.x = d[o + X];
      view.y = d[o + Y];
      view.remaining = 1 - d[o + AGE] / d[o + LIFE];
      view.size = d[o + SIZE];
      view.color = d[o + COLOR];
      visit(view);
    }
  }

  clear(): void {
    this.live = 0;
    this.recycleCursor = 0;
  }
}
