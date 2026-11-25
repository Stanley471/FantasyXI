/**
 * Drag-and-drop squad substitution and formation builder (#462).
 *
 * Pure, browser-free helpers behind the tactile pitch interface:
 *  - legal-formation rules and formation-change planning (which swaps a
 *    formation switch needs, and whether it is reachable with this bench),
 *  - valid swap targets for the player currently being dragged,
 *  - pointer collision detection over pitch/bench slot rectangles,
 *  - CSS FLIP (First, Last, Invert, Play) deltas for re-ordering animation,
 *  - keyboard navigation (Space to select, arrow keys to move, Enter to
 *    swap, Escape to cancel) as a pure state machine.
 *
 * Everything here is unit-testable without a browser; the components in
 * `components/pitch/` (PlayerCard, Pitch, Bench, FormationBuilder) and the
 * team page wire these helpers to pointer events and the DOM. Legality of
 * every swap still goes through `validateSubstitution` in `./formation`,
 * so the pitch, the bench and the formation builder share one rule set.
 */

import { Position, type Player } from "@/types";
import { validateSubstitution } from "./formation";

/** Minimal squad-entry shape shared by the store and these helpers. */
export interface SquadEntry {
  playerId: number;
  isStarter: boolean;
  player: Player;
}

// ---------------------------------------------------------------------------
// Legal formations
// ---------------------------------------------------------------------------

/** DEF-MID-FWD counts of a formation string such as "4-4-2". */
export interface FormationCounts {
  def: number;
  mid: number;
  fwd: number;
}

/**
 * Every formation legal under the squad rules: 1 GKP, 3-5 DEF, 2-5 MID,
 * 1-3 FWD, 10 outfielders. Derived from the bounds instead of hard-coded
 * so a rule change in `SQUAD_RULES` stays consistent.
 */
export const LEGAL_FORMATIONS: string[] = (() => {
  const formations: string[] = [];
  for (let def = 3; def <= 5; def++) {
    for (let mid = 2; mid <= 5; mid++) {
      const fwd = 10 - def - mid;
      if (fwd >= 1 && fwd <= 3) formations.push(`${def}-${mid}-${fwd}`);
    }
  }
  return formations;
})();

/** Parses "4-4-2" into counts, or returns null for anything malformed or illegal. */
export function parseFormation(formation: string): FormationCounts | null {
  const parts = formation.split("-");
  if (parts.length !== 3) return null;
  const [def, mid, fwd] = parts.map((part) => Number(part));
  if (![def, mid, fwd].every((n) => Number.isInteger(n))) return null;
  if (def < 3 || def > 5 || mid < 2 || mid > 5 || fwd < 1 || fwd > 3) return null;
  if (def + mid + fwd !== 10) return null;
  return { def, mid, fwd };
}

/** Counts the starters of each outfield position in the current lineup. */
export function countStarterPositions(players: SquadEntry[]): FormationCounts {
  const counts: FormationCounts = { def: 0, mid: 0, fwd: 0 };
  for (const p of players) {
    if (!p.isStarter) continue;
    if (p.player.position === Position.DEF) counts.def++;
    else if (p.player.position === Position.MID) counts.mid++;
    else if (p.player.position === Position.FWD) counts.fwd++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Valid swap targets for the dragged player
// ---------------------------------------------------------------------------

export interface SwapTarget {
  playerId: number;
  isStarter: boolean;
  /** True when dropping the dragged player here is a legal substitution. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
}

/**
 * Every other squad member as a potential drop target for `draggedPlayerId`,
 * each annotated with whether the swap is legal and why not. The pitch and
 * bench highlight `valid` targets and dim the rest while a drag is active.
 */
export function validSwapTargets(
  draggedPlayerId: number,
  players: SquadEntry[]
): SwapTarget[] {
  const dragged = players.find((p) => p.playerId === draggedPlayerId);
  if (!dragged) return [];
  return players
    .filter((p) => p.playerId !== draggedPlayerId)
    .map((p) => {
      const validation = validateSubstitution(dragged, p, players);
      return {
        playerId: p.playerId,
        isStarter: p.isStarter,
        valid: validation.valid,
        reason: validation.reason,
      };
    });
}

// ---------------------------------------------------------------------------
// Pointer collision detection
// ---------------------------------------------------------------------------

export interface SlotRect {
  id: number | string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** True when the pointer sits inside the slot rectangle (edges inclusive). */
export function pointInRect(point: Point, rect: SlotRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Collision detection for a pointer over pitch/bench slots: the slot whose
 * rectangle contains the point wins; when slots overlap, the slot whose
 * centre is nearest the pointer wins. Returns the slot id, or null when the
 * pointer is over no slot (a drop there snaps the player back).
 */
export function findDropTargetAtPoint(
  point: Point,
  rects: SlotRect[]
): number | string | null {
  let best: SlotRect | null = null;
  let bestDistance = Infinity;
  for (const rect of rects) {
    if (!pointInRect(point, rect)) continue;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const distance = Math.hypot(point.x - cx, point.y - cy);
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return best ? best.id : null;
}

// ---------------------------------------------------------------------------
// CSS FLIP (First, Last, Invert, Play) re-ordering animation
// ---------------------------------------------------------------------------

export interface FlipDelta {
  dx: number;
  dy: number;
}

/**
 * Given each card's position before the reorder (First) and after it
 * (Last), returns the Invert translation for every card that moved, so the
 * card can be painted at its old spot and then Played to its new one with
 * a CSS transform transition. Cards that did not move, appeared, or were
 * removed are omitted.
 */
export function computeFlipDeltas(
  first: ReadonlyMap<number, Point>,
  last: ReadonlyMap<number, Point>
): Map<number, FlipDelta> {
  const deltas = new Map<number, FlipDelta>();
  for (const [id, lastPoint] of last) {
    const firstPoint = first.get(id);
    if (!firstPoint) continue;
    const dx = firstPoint.x - lastPoint.x;
    const dy = firstPoint.y - lastPoint.y;
    if (dx !== 0 || dy !== 0) deltas.set(id, { dx, dy });
  }
  return deltas;
}

/** CSS transform for the Invert step of a FLIP animation, if the card moved. */
export function flipTransform(delta: FlipDelta | undefined): string | undefined {
  if (!delta || (delta.dx === 0 && delta.dy === 0)) return undefined;
  return `translate(${delta.dx}px, ${delta.dy}px)`;
}

/** Duration (ms) of the Play step; matches the FLIP transition in the UI. */
export const FLIP_DURATION_MS = 300;

// ---------------------------------------------------------------------------
// Keyboard navigation (Space / arrows / Enter / Escape)
// ---------------------------------------------------------------------------

/**
 * Focus order for keyboard navigation: starters in pitch order, then the
 * bench in priority order — the same order a sighted user reads the pitch.
 */
export function orderedSquadIds(players: SquadEntry[]): number[] {
  const byOrder = (a: SquadEntry, b: SquadEntry) =>
    (a as { positionOrder?: number }).positionOrder! -
    (b as { positionOrder?: number }).positionOrder!;
  const starters = players.filter((p) => p.isStarter).sort(byOrder);
  const bench = players.filter((p) => !p.isStarter).sort(byOrder);
  return [...starters, ...bench].map((p) => p.playerId);
}

export interface KeyboardNavState {
  focusedPlayerId: number | null;
  selectedPlayerId: number | null;
}

export type KeyboardNavAction =
  | { kind: "none" }
  | { kind: "select"; playerId: number }
  | { kind: "deselect" }
  | { kind: "swap"; sourcePlayerId: number; targetPlayerId: number }
  | { kind: "cancel" };

const HANDLED_KEYS = new Set([
  "ArrowRight",
  "ArrowDown",
  "ArrowLeft",
  "ArrowUp",
  "Home",
  "End",
  " ",
  "Spacebar",
  "Enter",
  "Escape",
]);

/** True for the keys the squad keyboard navigation handles. */
export function isKeyboardNavKey(key: string): boolean {
  return HANDLED_KEYS.has(key);
}

/**
 * Pure keyboard state machine. Space selects (or deselects) the focused
 * player, arrow keys move focus through `orderedIds`, Enter swaps the
 * selected player with the focused one, Escape cancels the selection.
 * The caller applies the returned action to the store (select, swap, or
 * clear) and moves DOM focus to `state.focusedPlayerId` when it changes.
 */
export function keyboardNavNext(
  state: KeyboardNavState,
  key: string,
  orderedIds: number[]
): { state: KeyboardNavState; action: KeyboardNavAction } {
  if (!isKeyboardNavKey(key) || orderedIds.length === 0) {
    return { state, action: { kind: "none" } };
  }

  const currentIndex =
    state.focusedPlayerId === null
      ? -1
      : orderedIds.indexOf(state.focusedPlayerId);
  const focusAt = (index: number): KeyboardNavState => ({
    ...state,
    focusedPlayerId: orderedIds[Math.max(0, Math.min(orderedIds.length - 1, index))],
  });

  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return {
        state: focusAt(currentIndex === -1 ? 0 : currentIndex + 1),
        action: { kind: "none" },
      };
    case "ArrowLeft":
    case "ArrowUp":
      return {
        state: focusAt(currentIndex === -1 ? 0 : currentIndex - 1),
        action: { kind: "none" },
      };
    case "Home":
      return { state: focusAt(0), action: { kind: "none" } };
    case "End":
      return { state: focusAt(orderedIds.length - 1), action: { kind: "none" } };
    case " ":
    case "Spacebar": {
      if (state.focusedPlayerId === null) return { state, action: { kind: "none" } };
      if (state.selectedPlayerId === state.focusedPlayerId) {
        return {
          state: { ...state, selectedPlayerId: null },
          action: { kind: "deselect" },
        };
      }
      return {
        state: { ...state, selectedPlayerId: state.focusedPlayerId },
        action: { kind: "select", playerId: state.focusedPlayerId },
      };
    }
    case "Enter": {
      if (
        state.selectedPlayerId !== null &&
        state.focusedPlayerId !== null &&
        state.selectedPlayerId !== state.focusedPlayerId
      ) {
        return {
          state,
          action: {
            kind: "swap",
            sourcePlayerId: state.selectedPlayerId,
            targetPlayerId: state.focusedPlayerId,
          },
        };
      }
      return { state, action: { kind: "none" } };
    }
    case "Escape":
      if (state.selectedPlayerId === null) return { state, action: { kind: "none" } };
      return {
        state: { ...state, selectedPlayerId: null },
        action: { kind: "cancel" },
      };
    default:
      return { state, action: { kind: "none" } };
  }
}

// ---------------------------------------------------------------------------
// Formation builder: plan a formation switch as starter <-> bench swaps
// ---------------------------------------------------------------------------

export interface FormationSwapStep {
  /** Starter leaving the pitch. */
  outPlayerId: number;
  /** Bench player coming on. */
  inPlayerId: number;
  outPosition: Position;
  inPosition: Position;
}

export type FormationPlan =
  | { ok: true; formation: string; swaps: FormationSwapStep[] }
  | { ok: false; reason: string };

const POSITION_LABEL: Record<Position, string> = {
  [Position.GKP]: "Goalkeeper",
  [Position.DEF]: "Defender",
  [Position.MID]: "Midfielder",
  [Position.FWD]: "Forward",
};

/**
 * Plans the smallest sequence of starter <-> bench swaps that moves the
 * current lineup to `targetFormation`, validating every step against the
 * formation rules. Returns the steps in the order they must be applied, or
 * a reason when the switch is impossible with this bench (for example, no
 * substitute forward is available to switch to 4-3-3).
 */
export function planFormationChange(
  players: SquadEntry[],
  targetFormation: string
): FormationPlan {
  const target = parseFormation(targetFormation);
  if (!target) {
    return {
      ok: false,
      reason: `"${targetFormation}" is not a legal formation (needs 3-5 defenders, 2-5 midfielders, 1-3 forwards).`,
    };
  }

  const current = countStarterPositions(players);
  if (
    current.def === target.def &&
    current.mid === target.mid &&
    current.fwd === target.fwd
  ) {
    return { ok: true, formation: targetFormation, swaps: [] };
  }

  // Working copy of starter flags; each step flips one starter and one sub.
  const working = players.map((p) => ({ ...p }));
  const swaps: FormationSwapStep[] = [];
  const usedBench = new Set<number>();

  const countsOf = (list: SquadEntry[]): FormationCounts =>
    countStarterPositions(list);
  const countFor = (counts: FormationCounts, pos: Position): number =>
    pos === Position.DEF ? counts.def : pos === Position.MID ? counts.mid : counts.fwd;

  for (let step = 0; step < 10; step++) {
    const counts = countsOf(working);
    if (
      counts.def === target.def &&
      counts.mid === target.mid &&
      counts.fwd === target.fwd
    ) {
      return { ok: true, formation: targetFormation, swaps };
    }

    // A position that needs one more starter, and one that has one too many.
    const needsMore = ([Position.DEF, Position.MID, Position.FWD] as const).find(
      (pos) => countFor(counts, pos) < countFor(target, pos)
    );
    const hasSurplus = ([Position.DEF, Position.MID, Position.FWD] as const).find(
      (pos) => countFor(counts, pos) > countFor(target, pos)
    );
    if (!needsMore || !hasSurplus) {
      return { ok: false, reason: `Cannot reach ${targetFormation} from this lineup.` };
    }

    const incoming = working
      .filter((p) => !p.isStarter && p.player.position === needsMore && !usedBench.has(p.playerId))
      .sort((a, b) => a.playerId - b.playerId)[0];
    if (!incoming) {
      return {
        ok: false,
        reason: `No substitute ${POSITION_LABEL[needsMore]} on the bench to switch to ${targetFormation}.`,
      };
    }
    const outgoing = working
      .filter((p) => p.isStarter && p.player.position === hasSurplus)
      .sort((a, b) => a.playerId - b.playerId)[0];
    if (!outgoing) {
      return { ok: false, reason: `Cannot reach ${targetFormation} from this lineup.` };
    }

    const validation = validateSubstitution(outgoing, incoming, working);
    if (!validation.valid) {
      return { ok: false, reason: validation.reason ?? `Cannot switch to ${targetFormation}.` };
    }

    outgoing.isStarter = false;
    incoming.isStarter = true;
    usedBench.add(incoming.playerId);
    swaps.push({
      outPlayerId: outgoing.playerId,
      inPlayerId: incoming.playerId,
      outPosition: hasSurplus,
      inPosition: needsMore,
    });
  }

  return { ok: false, reason: `Cannot reach ${targetFormation} from this lineup.` };
}

/**
 * Every legal formation reachable with the current bench, with how many
 * swaps the switch needs. Used to enable only the formations the squad can
 * actually switch to.
 */
export function reachableFormations(
  players: SquadEntry[]
): Array<{ formation: string; swapCount: number }> {
  const reachable: Array<{ formation: string; swapCount: number }> = [];
  for (const formation of LEGAL_FORMATIONS) {
    const plan = planFormationChange(players, formation);
    if (plan.ok) reachable.push({ formation, swapCount: plan.swaps.length });
  }
  return reachable;
}
