/**
 * Drag-and-drop squad substitution and formation builder (#462).
 *
 * Covers the pure interaction layer behind the tactile pitch interface:
 *  1. Valid swap targets for the dragged player, including the illegal
 *     2-defender substitution and goalkeeper isolation.
 *  2. Pointer collision detection over pitch/bench slot rectangles.
 *  3. CSS FLIP deltas for smooth re-ordering animation.
 *  4. Keyboard navigation parity: Space to select, arrow keys to navigate,
 *     Enter to swap, Escape to cancel — as a pure state machine plus the
 *     same flow driven through the store.
 *  5. Formation-change planning (which swaps a switch needs, and when the
 *     bench cannot supply the players) and reachable formations.
 *  6. Snap-back state: an illegal swap records the rejected move and its
 *     reason, and a legal swap clears it.
 *
 * No browser is involved: pointer/keyboard events are exercised against the
 * pure helpers and the store, following the existing tsx test style.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Position, type Player } from "../types/index.js";
import { detectFormation } from "../lib/formation.js";
import {
  LEGAL_FORMATIONS,
  parseFormation,
  countStarterPositions,
  validSwapTargets,
  findDropTargetAtPoint,
  computeFlipDeltas,
  flipTransform,
  orderedSquadIds,
  keyboardNavNext,
  isKeyboardNavKey,
  planFormationChange,
  reachableFormations,
  type KeyboardNavState,
} from "../lib/dragDropFormation.js";
import { useTeamStore, type LocalSquadPlayer } from "../store/teamStore.js";

function makePlayer(id: number, pos: Position, name: string): Player {
  return {
    id,
    fplId: id * 10,
    firstName: "Player",
    lastName: name,
    displayName: name,
    position: pos,
    teamId: (id % 5) + 1,
    price: 60,
    totalPoints: 50,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 0,
    minutesPlayed: 90,
    photoUrl: null,
    isAvailable: true,
  };
}

/** Standard 4-4-2 squad: 11 starters, 4 bench (1 GKP, 1 DEF, 1 MID, 1 FWD). */
function buildStandardSquad(): LocalSquadPlayer[] {
  const squad: LocalSquadPlayer[] = [];
  squad.push({
    playerId: 1, player: makePlayer(1, Position.GKP, "Raya"),
    isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 1,
  });
  [2, 3, 4, 5].forEach((id, i) => {
    squad.push({
      playerId: id, player: makePlayer(id, Position.DEF, `Defender ${i + 1}`),
      isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 + i,
    });
  });
  [6, 7, 8, 9].forEach((id, i) => {
    squad.push({
      playerId: id, player: makePlayer(id, Position.MID, `Midfielder ${i + 1}`),
      isStarter: true, isCaptain: i === 0, isViceCaptain: false, positionOrder: 6 + i,
    });
  });
  [10, 11].forEach((id, i) => {
    squad.push({
      playerId: id, player: makePlayer(id, Position.FWD, `Forward ${i + 1}`),
      isStarter: true, isCaptain: false, isViceCaptain: i === 0, positionOrder: 10 + i,
    });
  });
  squad.push({
    playerId: 12, player: makePlayer(12, Position.GKP, "Sub Keeper"),
    isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12,
  });
  squad.push({
    playerId: 13, player: makePlayer(13, Position.DEF, "Sub Defender"),
    isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13,
  });
  squad.push({
    playerId: 14, player: makePlayer(14, Position.MID, "Sub Midfielder"),
    isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14,
  });
  squad.push({
    playerId: 15, player: makePlayer(15, Position.FWD, "Sub Forward"),
    isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15,
  });
  return squad;
}

/** Same squad but the bench has no forward (two midfielders instead). */
function buildSquadWithoutBenchForward(): LocalSquadPlayer[] {
  const squad = buildStandardSquad();
  const fwd = squad.find((p) => p.playerId === 15)!;
  fwd.player = makePlayer(15, Position.MID, "Second Sub Midfielder");
  return squad;
}

function resetStore(squad: LocalSquadPlayer[]) {
  useTeamStore.setState({
    players: squad,
    activeDragPlayer: null,
    selectedPlayerId: null,
    substitutionFeedback: null,
    rejectedSwap: null,
    keyboardFocusedPlayerId: null,
  });
}

describe("Legal formations (#462)", () => {
  it("lists exactly the eight formations allowed by the squad rules", () => {
    assert.deepEqual(LEGAL_FORMATIONS, [
      "3-4-3", "3-5-2",
      "4-3-3", "4-4-2", "4-5-1",
      "5-2-3", "5-3-2", "5-4-1",
    ]);
  });

  it("parses legal formations and rejects illegal or malformed ones", () => {
    assert.deepEqual(parseFormation("4-4-2"), { def: 4, mid: 4, fwd: 2 });
    assert.equal(parseFormation("2-5-3"), null, "2 defenders is illegal");
    assert.equal(parseFormation("4-4-4"), null, "4 forwards is illegal");
    assert.equal(parseFormation("4-4"), null);
    assert.equal(parseFormation("banana"), null);
    assert.equal(parseFormation("4-4-2-0"), null);
  });

  it("counts starter positions in the standard 4-4-2 squad", () => {
    assert.deepEqual(countStarterPositions(buildStandardSquad()), { def: 4, mid: 4, fwd: 2 });
    assert.equal(detectFormation(buildStandardSquad().filter((p) => p.isStarter) as never), "4-4-2");
  });
});

describe("Valid swap targets while dragging (#462)", () => {
  let squad: LocalSquadPlayer[];

  beforeEach(() => {
    squad = buildStandardSquad();
    resetStore(squad);
  });

  it("highlights every bench outfielder as valid for a dragged defender in 4-4-2", () => {
    const targets = validSwapTargets(2, squad);
    assert.equal(targets.length, 14, "every other squad member is a target");
    assert.ok(!targets.some((t) => t.playerId === 2), "the dragged player is not its own target");
    const byId = new Map(targets.map((t) => [t.playerId, t]));
    assert.equal(byId.get(13)?.valid, true, "bench defender");
    assert.equal(byId.get(14)?.valid, true, "bench midfielder (tactical 3-5-2)");
    assert.equal(byId.get(15)?.valid, true, "bench forward (tactical 4-4-2 stays legal)");
    assert.equal(byId.get(12)?.valid, false, "bench goalkeeper is never a target for an outfielder");
    assert.match(byId.get(12)?.reason ?? "", /Goalkeeper/);
  });

  it("marks the bench forward invalid once the lineup is already at 3 defenders", () => {
    useTeamStore.getState().handleSwap(5, 14); // 4-4-2 -> 3-5-2
    const updated = useTeamStore.getState().players;
    assert.equal(detectFormation(updated.filter((p) => p.isStarter) as never), "3-5-2");

    const targets = validSwapTargets(2, updated);
    const byId = new Map(targets.map((t) => [t.playerId, t]));
    assert.equal(byId.get(15)?.valid, false, "subbing a defender for a forward would leave 2 defenders");
    assert.match(byId.get(15)?.reason ?? "", /Minimum 3 Defenders required \(would leave 2\)/);
    assert.equal(byId.get(14)?.valid, true, "bench midfielder is still a legal target");
    assert.equal(byId.get(13)?.valid, true, "bench defender is still a legal target");
  });

  it("returns no targets for an unknown dragged player", () => {
    assert.deepEqual(validSwapTargets(999, squad), []);
  });
});

describe("Pointer collision detection (#462)", () => {
  const rects = [
    { id: 2, x: 0, y: 0, width: 100, height: 100 },
    { id: 13, x: 200, y: 0, width: 100, height: 100 },
    { id: 14, x: 90, y: 0, width: 100, height: 100 },
  ];

  it("finds the slot under the pointer", () => {
    assert.equal(findDropTargetAtPoint({ x: 50, y: 50 }, rects), 2);
    assert.equal(findDropTargetAtPoint({ x: 250, y: 50 }, rects), 13);
  });

  it("returns null when the pointer is over no slot, so the player snaps back", () => {
    assert.equal(findDropTargetAtPoint({ x: 150, y: 200 }, rects), null);
    assert.equal(findDropTargetAtPoint({ x: 50, y: 50 }, []), null);
  });

  it("breaks overlapping slots by nearest centre", () => {
    // x=96 sits in both slot 2 (0-100) and slot 14 (90-190); slot 14's centre (140) is nearer than slot 2's (50).
    assert.equal(findDropTargetAtPoint({ x: 96, y: 50 }, rects), 14);
    // x=94 is nearer slot 2's centre (44 away) than slot 14's (46 away), so slot 2 wins.
    assert.equal(findDropTargetAtPoint({ x: 94, y: 50 }, rects), 2);
  });

  it("treats slot edges as inside", () => {
    assert.equal(findDropTargetAtPoint({ x: 0, y: 0 }, rects), 2);
    assert.equal(findDropTargetAtPoint({ x: 200, y: 0 }, rects), 13);
    assert.equal(findDropTargetAtPoint({ x: 300, y: 100 }, rects), 13);
  });
});

describe("CSS FLIP re-ordering animation (#462)", () => {
  it("returns invert deltas only for cards that moved", () => {
    const first = new Map([
      [2, { x: 0, y: 0 }],
      [6, { x: 100, y: 0 }],
      [13, { x: 0, y: 200 }],
    ]);
    const last = new Map([
      [2, { x: 100, y: 0 }], // moved right: invert left
      [6, { x: 100, y: 0 }], // unmoved
      [13, { x: 0, y: 100 }], // moved up
      [99, { x: 0, y: 0 }], // newly added: no invert
    ]);
    const deltas = computeFlipDeltas(first, last);
    assert.deepEqual([...deltas.entries()], [
      [2, { dx: -100, dy: 0 }],
      [13, { dx: 0, dy: 100 }],
    ]);
  });

  it("builds the invert transform, and none for an unmoved card", () => {
    assert.equal(flipTransform({ dx: -100, dy: 25 }), "translate(-100px, 25px)");
    assert.equal(flipTransform({ dx: 0, dy: 0 }), undefined);
    assert.equal(flipTransform(undefined), undefined);
  });

  it("produces no deltas when nothing moved", () => {
    const positions = new Map([[2, { x: 0, y: 0 }]]);
    assert.equal(computeFlipDeltas(positions, new Map(positions)).size, 0);
  });
});

describe("Keyboard navigation (#462)", () => {
  const ordered = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

  it("orders focus as starters in pitch order, then the bench in priority order", () => {
    assert.deepEqual(orderedSquadIds(buildStandardSquad()), ordered);
  });

  it("recognises the navigation keys and ignores the rest", () => {
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End", " ", "Enter", "Escape"]) {
      assert.equal(isKeyboardNavKey(key), true, key);
    }
    assert.equal(isKeyboardNavKey("Tab"), false);
    assert.equal(isKeyboardNavKey("a"), false);
  });

  it("moves focus with the arrow keys and clamps at both ends", () => {
    let state: KeyboardNavState = { focusedPlayerId: null, selectedPlayerId: null };
    state = keyboardNavNext(state, "ArrowRight", ordered).state;
    assert.equal(state.focusedPlayerId, 1, "first arrow focuses the first player");
    state = keyboardNavNext(state, "ArrowDown", ordered).state;
    assert.equal(state.focusedPlayerId, 2);
    state = keyboardNavNext(state, "ArrowLeft", ordered).state;
    assert.equal(state.focusedPlayerId, 1);
    state = keyboardNavNext(state, "ArrowLeft", ordered).state;
    assert.equal(state.focusedPlayerId, 1, "clamps at the start");
    state = keyboardNavNext(state, "End", ordered).state;
    assert.equal(state.focusedPlayerId, 15);
    state = keyboardNavNext(state, "ArrowRight", ordered).state;
    assert.equal(state.focusedPlayerId, 15, "clamps at the end");
    state = keyboardNavNext(state, "Home", ordered).state;
    assert.equal(state.focusedPlayerId, 1);
  });

  it("selects with Space, deselects with Space again, cancels with Escape", () => {
    const state: KeyboardNavState = { focusedPlayerId: 5, selectedPlayerId: null };
    let next = keyboardNavNext(state, " ", ordered);
    assert.deepEqual(next.action, { kind: "select", playerId: 5 });
    assert.equal(next.state.selectedPlayerId, 5);

    next = keyboardNavNext(next.state, " ", ordered);
    assert.deepEqual(next.action, { kind: "deselect" });
    assert.equal(next.state.selectedPlayerId, null);

    next = keyboardNavNext({ focusedPlayerId: 5, selectedPlayerId: 5 }, "Escape", ordered);
    assert.deepEqual(next.action, { kind: "cancel" });
    assert.equal(next.state.selectedPlayerId, null);
    assert.equal(next.state.focusedPlayerId, 5, "Escape keeps focus, only the selection goes");
  });

  it("swaps with Enter only when a different player is selected", () => {
    const selected: KeyboardNavState = { focusedPlayerId: 14, selectedPlayerId: 5 };
    assert.deepEqual(keyboardNavNext(selected, "Enter", ordered).action, {
      kind: "swap",
      sourcePlayerId: 5,
      targetPlayerId: 14,
    });
    assert.deepEqual(
      keyboardNavNext({ focusedPlayerId: 5, selectedPlayerId: 5 }, "Enter", ordered).action,
      { kind: "none" },
      "Enter on the selected player itself is a no-op"
    );
    assert.deepEqual(
      keyboardNavNext({ focusedPlayerId: 14, selectedPlayerId: null }, "Enter", ordered).action,
      { kind: "none" },
      "Enter with nothing selected is a no-op"
    );
  });

  it("Space switches the selection to another focused player", () => {
    const state: KeyboardNavState = { focusedPlayerId: 14, selectedPlayerId: 5 };
    const next = keyboardNavNext(state, " ", ordered);
    assert.deepEqual(next.action, { kind: "select", playerId: 14 });
    assert.equal(next.state.selectedPlayerId, 14);
  });
});

describe("Keyboard flow through the store (#462)", () => {
  beforeEach(() => resetStore(buildStandardSquad()));

  it("performs the same 4-4-2 -> 3-5-2 swap by keyboard as by drag", () => {
    const orderedIds = orderedSquadIds(useTeamStore.getState().players);
    // Focus defender 5, Space to select, arrows to bench midfielder 14, Enter to swap.
    let state: KeyboardNavState = { focusedPlayerId: 5, selectedPlayerId: null };
    let next = keyboardNavNext(state, " ", orderedIds);
    useTeamStore.getState().setSelectedPlayerId(next.state.selectedPlayerId);
    state = next.state;
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]) {
      state = keyboardNavNext(state, key, orderedIds).state;
    }
    assert.equal(state.focusedPlayerId, 14);
    next = keyboardNavNext(state, "Enter", orderedIds);
    assert.deepEqual(next.action, { kind: "swap", sourcePlayerId: 5, targetPlayerId: 14 });

    const swapped = useTeamStore.getState().handleSwap(5, 14);
    assert.equal(swapped, true);
    const starters = useTeamStore.getState().players.filter((p) => p.isStarter);
    assert.equal(detectFormation(starters as never), "3-5-2");
  });

  it("keeps the selection after an illegal keyboard swap so another target can be tried", () => {
    useTeamStore.getState().handleSwap(5, 14); // now 3-5-2
    useTeamStore.getState().setSelectedPlayerId(2);
    const swapped = useTeamStore.getState().handleSwap(2, 15);
    assert.equal(swapped, false, "leaving 2 defenders is illegal");
    assert.equal(useTeamStore.getState().selectedPlayerId, 2, "the store never clears the selection on failure");
    assert.equal(
      detectFormation(useTeamStore.getState().players.filter((p) => p.isStarter) as never),
      "3-5-2",
      "the formation is unchanged"
    );
  });
});

describe("Formation-change planning (#462)", () => {
  it("plans 4-4-2 -> 3-5-2 as a single defender-for-midfielder swap", () => {
    const plan = planFormationChange(buildStandardSquad(), "3-5-2");
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.swaps.length, 1);
    assert.equal(plan.swaps[0].outPosition, Position.DEF);
    assert.equal(plan.swaps[0].inPosition, Position.MID);
    // Applying the plan really lands on 3-5-2.
    const squad = buildStandardSquad();
    resetStore(squad);
    for (const step of plan.swaps) {
      assert.equal(useTeamStore.getState().handleSwap(step.outPlayerId, step.inPlayerId), true);
    }
    assert.equal(
      detectFormation(useTeamStore.getState().players.filter((p) => p.isStarter) as never),
      "3-5-2"
    );
  });

  it("plans 4-4-2 -> 5-2-3 as two swaps and applies them in order", () => {
    const plan = planFormationChange(buildStandardSquad(), "5-2-3");
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.swaps.length, 2);
    resetStore(buildStandardSquad());
    for (const step of plan.swaps) {
      assert.equal(useTeamStore.getState().handleSwap(step.outPlayerId, step.inPlayerId), true);
    }
    assert.equal(
      detectFormation(useTeamStore.getState().players.filter((p) => p.isStarter) as never),
      "5-2-3"
    );
  });

  it("returns an empty plan when already in the target formation", () => {
    const plan = planFormationChange(buildStandardSquad(), "4-4-2");
    assert.equal(plan.ok, true);
    if (plan.ok) assert.deepEqual(plan.swaps, []);
  });

  it("rejects illegal and malformed formation strings", () => {
    for (const bad of ["2-5-3", "4-4-4", "banana", "4-4"]) {
      const plan = planFormationChange(buildStandardSquad(), bad);
      assert.equal(plan.ok, false, bad);
      if (!plan.ok) assert.match(plan.reason, /not a legal formation/);
    }
  });

  it("reports the switch as impossible when the bench has no forward", () => {
    const plan = planFormationChange(buildSquadWithoutBenchForward(), "4-3-3");
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /No substitute Forward on the bench to switch to 4-3-3/);
  });

  it("lists every legal formation as reachable for the standard squad", () => {
    const reachable = reachableFormations(buildStandardSquad());
    assert.equal(reachable.length, 8);
    const byFormation = new Map(reachable.map((r) => [r.formation, r.swapCount]));
    assert.equal(byFormation.get("4-4-2"), 0);
    assert.equal(byFormation.get("3-5-2"), 1);
    assert.equal(byFormation.get("5-3-2"), 1);
    assert.equal(byFormation.get("5-2-3"), 2);
  });

  it("drops unreachable formations from the reachable list without a bench forward", () => {
    const reachable = reachableFormations(buildSquadWithoutBenchForward());
    const formations = reachable.map((r) => r.formation);
    assert.ok(!formations.includes("4-3-3"), "needs a bench forward");
    assert.ok(!formations.includes("3-4-3"), "needs a bench forward");
    assert.ok(formations.includes("3-5-2"), "only needs a bench midfielder");
    assert.ok(formations.includes("4-4-2"), "current formation is always reachable");
  });
});

describe("Illegal substitution snap-back (#462)", () => {
  beforeEach(() => resetStore(buildStandardSquad()));

  it("records the rejected swap and its warning when a drop would leave 2 defenders", () => {
    useTeamStore.getState().handleSwap(5, 14); // 4-4-2 -> 3-5-2
    const swapped = useTeamStore.getState().handleSwap(2, 15);
    assert.equal(swapped, false);

    const rejected = useTeamStore.getState().rejectedSwap;
    assert.ok(rejected, "the rejected move is recorded for the snap-back animation");
    assert.equal(rejected?.sourcePlayerId, 2);
    assert.equal(rejected?.targetPlayerId, 15);
    assert.match(rejected?.reason ?? "", /Minimum 3 Defenders required \(would leave 2\)/);
    assert.equal(useTeamStore.getState().substitutionFeedback?.type, "error");
    assert.match(useTeamStore.getState().substitutionFeedback?.message ?? "", /Minimum 3 Defenders/);
    assert.equal(
      detectFormation(useTeamStore.getState().players.filter((p) => p.isStarter) as never),
      "3-5-2",
      "the lineup is unchanged after the rejected drop"
    );
  });

  it("clears the rejected swap on the next legal swap", () => {
    useTeamStore.getState().handleSwap(5, 14);
    useTeamStore.getState().handleSwap(2, 15);
    assert.ok(useTeamStore.getState().rejectedSwap);

    const swapped = useTeamStore.getState().handleSwap(2, 13);
    assert.equal(swapped, true);
    assert.equal(useTeamStore.getState().rejectedSwap, null);
    assert.equal(useTeamStore.getState().substitutionFeedback?.type, "success");
  });

  it("clears the rejected swap when a new drag starts", () => {
    useTeamStore.getState().handleSwap(5, 14);
    useTeamStore.getState().handleSwap(2, 15);
    assert.ok(useTeamStore.getState().rejectedSwap);

    const player = useTeamStore.getState().players.find((p) => p.playerId === 2)!;
    useTeamStore.getState().setActiveDragPlayer(player);
    assert.equal(useTeamStore.getState().rejectedSwap, null);
  });
});
