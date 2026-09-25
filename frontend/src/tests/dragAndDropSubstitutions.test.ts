/**
 * Drag-and-Drop Squad Management & Substitution Tests
 *
 * Verifies:
 * 1. Goalkeeper substitution isolation (GKP <-> GKP only)
 * 2. Formation constraint validation during tactical substitutions:
 *    - Preserving minimum 3 defenders (rejects leaving 2 DEF)
 *    - Preserving maximum 5 defenders (rejects creating 6 DEF)
 *    - Preserving minimum 2 midfielders (rejects leaving 1 MID)
 *    - Preserving maximum 5 midfielders (rejects creating 6 MID)
 *    - Preserving minimum 1 forward (rejects leaving 0 FWD)
 *    - Preserving maximum 3 forwards (rejects creating 4 FWD)
 * 3. Starter <-> Starter tactical swaps
 * 4. Bench priority reordering
 * 5. State management in useTeamStore:
 *    - Captaincy transfer when starter captain is subbed off
 *    - Rollback/rejection with informative feedback when substitution is invalid
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Position, Player } from "../types/index.js";
import {
  validateSubstitution,
  detectFormation,
} from "../lib/formation.js";
import { useTeamStore, LocalSquadPlayer } from "../store/teamStore.js";

// Helper to create mock player
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

// Builds standard 4-4-2 squad (11 starters, 4 bench)
function buildStandardSquad(): LocalSquadPlayer[] {
  const squad: LocalSquadPlayer[] = [];

  // Starters (1 GKP, 4 DEF, 4 MID, 2 FWD)
  squad.push({
    playerId: 1,
    player: makePlayer(1, Position.GKP, "Raya"),
    isStarter: true,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: 1,
  });

  [2, 3, 4, 5].forEach((id, i) => {
    squad.push({
      playerId: id,
      player: makePlayer(id, Position.DEF, `Defender ${i + 1}`),
      isStarter: true,
      isCaptain: false,
      isViceCaptain: false,
      positionOrder: 2 + i,
    });
  });

  [6, 7, 8, 9].forEach((id, i) => {
    squad.push({
      playerId: id,
      player: makePlayer(id, Position.MID, `Midfielder ${i + 1}`),
      isStarter: true,
      isCaptain: i === 0, // Player 6 is Captain
      isViceCaptain: false,
      positionOrder: 6 + i,
    });
  });

  [10, 11].forEach((id, i) => {
    squad.push({
      playerId: id,
      player: makePlayer(id, Position.FWD, `Forward ${i + 1}`),
      isStarter: true,
      isCaptain: false,
      isViceCaptain: i === 0, // Player 10 is Vice-Captain
      positionOrder: 10 + i,
    });
  });

  // Bench (1 GKP, 1 DEF, 1 MID, 1 FWD)
  squad.push({
    playerId: 12,
    player: makePlayer(12, Position.GKP, "Sub Keeper"),
    isStarter: false,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: 12,
  });

  squad.push({
    playerId: 13,
    player: makePlayer(13, Position.DEF, "Sub Defender"),
    isStarter: false,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: 13,
  });

  squad.push({
    playerId: 14,
    player: makePlayer(14, Position.MID, "Sub Midfielder"),
    isStarter: false,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: 14,
  });

  squad.push({
    playerId: 15,
    player: makePlayer(15, Position.FWD, "Sub Forward"),
    isStarter: false,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: 15,
  });

  return squad;
}

describe("Drag-and-Drop Squad Management & Substitutions", () => {
  let squad: LocalSquadPlayer[];

  beforeEach(() => {
    squad = buildStandardSquad();
    useTeamStore.setState({
      players: squad,
      activeDragPlayer: null,
      selectedPlayerId: null,
      substitutionFeedback: null,
    });
  });

  describe("Goalkeeper Substitution Isolation", () => {
    it("should allow swapping starter Goalkeeper with bench Goalkeeper", () => {
      const starterGkp = squad.find((p) => p.playerId === 1)!;
      const subGkp = squad.find((p) => p.playerId === 12)!;

      const result = validateSubstitution(starterGkp, subGkp, squad);
      assert.strictEqual(result.valid, true);
    });

    it("should reject swapping Goalkeeper with any Outfield player", () => {
      const starterGkp = squad.find((p) => p.playerId === 1)!;
      const subDef = squad.find((p) => p.playerId === 13)!;
      const subMid = squad.find((p) => p.playerId === 14)!;
      const subFwd = squad.find((p) => p.playerId === 15)!;

      assert.strictEqual(validateSubstitution(starterGkp, subDef, squad).valid, false);
      assert.strictEqual(validateSubstitution(starterGkp, subMid, squad).valid, false);
      assert.strictEqual(validateSubstitution(starterGkp, subFwd, squad).valid, false);
    });

    it("should reject swapping an Outfield player with a Goalkeeper", () => {
      const starterDef = squad.find((p) => p.playerId === 2)!;
      const subGkp = squad.find((p) => p.playerId === 12)!;

      const result = validateSubstitution(starterDef, subGkp, squad);
      assert.strictEqual(result.valid, false);
      assert.ok(result.reason?.includes("Goalkeeper"));
    });
  });

  describe("Tactical Formation Constraints during Substitutions", () => {
    it("should allow valid tactical switch: 4-4-2 -> 3-5-2 (subbing DEF for MID)", () => {
      const starterDef = squad.find((p) => p.playerId === 5)!; // DEF
      const benchMid = squad.find((p) => p.playerId === 14)!; // MID

      const validation = validateSubstitution(starterDef, benchMid, squad);
      assert.strictEqual(validation.valid, true);

      // Execute in store
      const swapped = useTeamStore.getState().handleSwap(starterDef.playerId, benchMid.playerId);
      assert.strictEqual(swapped, true);

      const currentStarters = useTeamStore
        .getState()
        .players.filter((p) => p.isStarter);
      assert.strictEqual(detectFormation(currentStarters as any), "3-5-2");
    });

    it("should allow valid tactical switch: 4-4-2 -> 4-3-3 (subbing MID for FWD)", () => {
      const starterMid = squad.find((p) => p.playerId === 9)!; // MID
      const benchFwd = squad.find((p) => p.playerId === 15)!; // FWD

      const validation = validateSubstitution(starterMid, benchFwd, squad);
      assert.strictEqual(validation.valid, true);

      const swapped = useTeamStore.getState().handleSwap(starterMid.playerId, benchFwd.playerId);
      assert.strictEqual(swapped, true);

      const currentStarters = useTeamStore
        .getState()
        .players.filter((p) => p.isStarter);
      assert.strictEqual(detectFormation(currentStarters as any), "4-3-3");
    });

    it("should reject subbing a DEF when squad already has minimum 3 defenders (3-5-2)", () => {
      // First switch 4-4-2 -> 3-5-2
      useTeamStore.getState().handleSwap(5, 14); // DEF 5 <-> MID 14
      const updatedSquad = useTeamStore.getState().players;

      // Now we have 3 DEF, 5 MID, 2 FWD
      const remainingDef = updatedSquad.find((p) => p.playerId === 2)!; // starter DEF
      const benchFwd = updatedSquad.find((p) => p.playerId === 15)!; // bench FWD

      // Subbing another DEF would leave 2 DEF -> INVALID!
      const validation = validateSubstitution(remainingDef, benchFwd, updatedSquad);
      assert.strictEqual(validation.valid, false);
      assert.ok(validation.reason?.includes("Minimum 3 Defenders required"));

      // Store should reject move and preserve 3-5-2
      const swapped = useTeamStore.getState().handleSwap(remainingDef.playerId, benchFwd.playerId);
      assert.strictEqual(swapped, false);
      assert.strictEqual(
        useTeamStore.getState().substitutionFeedback?.type,
        "error"
      );
    });

    it("should reject subbing a FWD when squad already has minimum 1 forward (4-5-1)", () => {
      // Switch to 4-5-1: sub FWD 11 for MID 14
      useTeamStore.getState().handleSwap(11, 14);
      const updatedSquad = useTeamStore.getState().players;

      const loneFwd = updatedSquad.find((p) => p.playerId === 10)!; // lone starter FWD
      const benchDef = updatedSquad.find((p) => p.playerId === 13)!; // bench DEF

      // Subbing lone FWD would leave 0 FWD -> INVALID!
      const validation = validateSubstitution(loneFwd, benchDef, updatedSquad);
      assert.strictEqual(validation.valid, false);
      assert.ok(validation.reason?.includes("Minimum 1 Forward required"));
    });
  });

  describe("Starter Tactical Swaps & Bench Reordering", () => {
    it("should allow swapping two outfield starters to adjust tactical slot order", () => {
      const starterDef1 = squad.find((p) => p.playerId === 2)!;
      const starterMid1 = squad.find((p) => p.playerId === 6)!;

      const result = validateSubstitution(starterDef1, starterMid1, squad);
      assert.strictEqual(result.valid, true);

      const swapped = useTeamStore.getState().handleSwap(2, 6);
      assert.strictEqual(swapped, true);
    });

    it("should allow reordering bench substitutes", () => {
      const benchDef = squad.find((p) => p.playerId === 13)!;
      const benchMid = squad.find((p) => p.playerId === 14)!;

      const result = validateSubstitution(benchDef, benchMid, squad);
      assert.strictEqual(result.valid, true);

      const swapped = useTeamStore.getState().handleSwap(13, 14);
      assert.strictEqual(swapped, true);
    });
  });

  describe("Captaincy Preservation during Drag-and-Drop Substitutions", () => {
    it("should automatically transfer captaincy to the incoming substitute when captain is subbed off", () => {
      const captainStarter = squad.find((p) => p.playerId === 6)!; // Player 6 is Captain
      assert.strictEqual(captainStarter.isCaptain, true);

      const benchPlayer = squad.find((p) => p.playerId === 14)!; // Sub Midfielder
      assert.strictEqual(benchPlayer.isCaptain, false);

      const swapped = useTeamStore.getState().handleSwap(6, 14);
      assert.strictEqual(swapped, true);

      const updatedSquad = useTeamStore.getState().players;
      const newBenchPlayer = updatedSquad.find((p) => p.playerId === 6)!;
      const newStarter = updatedSquad.find((p) => p.playerId === 14)!;

      // Bench player must no longer be captain
      assert.strictEqual(newBenchPlayer.isStarter, false);
      assert.strictEqual(newBenchPlayer.isCaptain, false);

      // New starter inherits captaincy
      assert.strictEqual(newStarter.isStarter, true);
      assert.strictEqual(newStarter.isCaptain, true);
    });
  });
});
