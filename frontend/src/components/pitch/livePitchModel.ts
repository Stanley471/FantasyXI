import { LivePlayerEvent, LivePlayerPoints, Position } from "@/types";

/**
 * Pure model for the live canvas pitch (issue #333): formation layout, event
 * detection between live snapshots, and device quality profiles. No DOM.
 */

/**
 * FIFA's recommended field of play (Football Stadiums Guidelines), in metres;
 * within the IFAB Law 1 range for international matches (100-110 x 64-75 m).
 */
export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;

/**
 * Horizontal pitch, own goal on the left. Depth of each line as a fraction of
 * the pitch length; players spread evenly across the width.
 */
const LINE_DEPTH: Record<Position, number> = {
  [Position.GKP]: 0.06,
  [Position.DEF]: 0.27,
  [Position.MID]: 0.51,
  [Position.FWD]: 0.76,
};
const WIDTH_MARGIN = 0.1;

/** Normalized slot on the pitch: x along the length (0 = own goal line), y across the width. */
export interface PitchSlot {
  playerId: number;
  x: number;
  y: number;
}

/** Players who count this gameweek: starters not subbed out, plus bench players subbed in. */
export function countingPlayers(lineup: LivePlayerPoints[]): LivePlayerPoints[] {
  return lineup.filter((p) => (p.isStarter && !p.subbedOut) || p.subbedIn);
}

/** Lays players out in their formation lines. O(n log n) for n players (n = 11). */
export function layoutFormation(
  players: Array<Pick<LivePlayerPoints, "playerId" | "position" | "positionOrder">>
): PitchSlot[] {
  const lines = new Map<Position, typeof players>();
  for (const player of players) {
    const line = lines.get(player.position) ?? [];
    line.push(player);
    lines.set(player.position, line);
  }

  const slots: PitchSlot[] = [];
  for (const [position, line] of lines) {
    line.sort((a, b) => a.positionOrder - b.positionOrder);
    line.forEach((player, index) => {
      slots.push({
        playerId: player.playerId,
        x: LINE_DEPTH[position],
        y: WIDTH_MARGIN + ((1 - 2 * WIDTH_MARGIN) * (index + 1)) / (line.length + 1),
      });
    });
  }
  return slots;
}

export type PitchEventKind = "GOAL" | "ASSIST" | "SAVE" | "YELLOW_CARD" | "RED_CARD";

export interface PitchEvent {
  playerId: number;
  kind: PitchEventKind;
}

const EVENT_COUNTERS: Array<[keyof LivePlayerEvent, PitchEventKind]> = [
  ["goals", "GOAL"],
  ["assists", "ASSIST"],
  ["saves", "SAVE"],
  ["yellowCards", "YELLOW_CARD"],
  ["redCards", "RED_CARD"],
];

/**
 * New match events for players on the pitch, from the growth of each
 * player's cumulative counters between two live snapshots. At most
 * `maxPerCounter` animations per counter, so a late-joining client or a
 * keeper with many saves cannot flood the renderer. O(E) for E event rows.
 */
export function diffPlayerEvents(
  previous: ReadonlyMap<number, LivePlayerEvent>,
  next: LivePlayerEvent[],
  onPitch: ReadonlySet<number>,
  maxPerCounter = 3
): PitchEvent[] {
  const events: PitchEvent[] = [];
  for (const row of next) {
    if (!onPitch.has(row.playerId)) continue;
    const before = previous.get(row.playerId);
    for (const [counter, kind] of EVENT_COUNTERS) {
      const delta = Math.min(maxPerCounter, (row[counter] as number) - ((before?.[counter] as number) ?? 0));
      for (let i = 0; i < delta; i++) events.push({ playerId: row.playerId, kind });
    }
  }
  return events;
}

export interface QualityProfile {
  name: "high" | "low" | "static";
  /** Particle pool capacity; 0 disables particle effects. */
  maxParticles: number;
  /** Upper bound on the backing-store pixel ratio. */
  dprCap: number;
  /** Continuous idle movement of players around their slots. */
  idleMotion: boolean;
  /** Minimum time between rendered frames (0 = every animation frame). */
  minFrameIntervalMs: number;
  /** Burst animations started per frame; the rest wait their turn. */
  burstsPerFrame: number;
}

export const QUALITY_PROFILES: Record<QualityProfile["name"], QualityProfile> = {
  high: { name: "high", maxParticles: 640, dprCap: 2, idleMotion: true, minFrameIntervalMs: 0, burstsPerFrame: 4 },
  low: { name: "low", maxParticles: 160, dprCap: 1, idleMotion: false, minFrameIntervalMs: 1000 / 30, burstsPerFrame: 2 },
  static: { name: "static", maxParticles: 0, dprCap: 2, idleMotion: false, minFrameIntervalMs: 0, burstsPerFrame: 0 },
};

export interface DeviceCapabilities {
  prefersReducedMotion: boolean;
  /** navigator.deviceMemory (GB, Chromium only). */
  deviceMemory?: number;
  hardwareConcurrency?: number;
  /** navigator.connection.saveData (Chromium only). */
  saveData?: boolean;
}

/**
 * Reduced-motion users get a still pitch; devices reporting little memory,
 * few cores or data saver get the low-power profile. The renderer also
 * downgrades itself at runtime if frames run long.
 */
export function selectQualityProfile(device: DeviceCapabilities): QualityProfile {
  if (device.prefersReducedMotion) return QUALITY_PROFILES.static;
  const lowPower =
    device.saveData === true ||
    (device.deviceMemory !== undefined && device.deviceMemory <= 2) ||
    (device.hardwareConcurrency !== undefined && device.hardwareConcurrency <= 2);
  return lowPower ? QUALITY_PROFILES.low : QUALITY_PROFILES.high;
}
