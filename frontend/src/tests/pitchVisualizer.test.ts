import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Position, Player } from "../types/index.js";
import {
  getTacticalSlotCoordinates,
  calculateSubstitutionPaths,
  SquadPlayerLike,
} from "../lib/pitch/substitutionPathSolver.js";

function makePlayer(id: number, pos: Position, name: string): Player {
  return {
    id,
    fplId: id * 10,
    firstName: "Player",
    lastName: name,
    displayName: name,
    position: pos,
    teamId: 1,
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

function buildTestSquad(formation: "4-4-2" | "3-5-2"): SquadPlayerLike[] {
  const squad: SquadPlayerLike[] = [];

  // GKP (1 starter, 1 bench)
  squad.push({ playerId: 1, isStarter: true, player: makePlayer(1, Position.GKP, "Raya") });
  squad.push({ playerId: 12, isStarter: false, player: makePlayer(12, Position.GKP, "Ramsdale") });

  if (formation === "4-4-2") {
    // 4 DEF starters, 1 bench
    squad.push({ playerId: 2, isStarter: true, player: makePlayer(2, Position.DEF, "Saliba") });
    squad.push({ playerId: 3, isStarter: true, player: makePlayer(3, Position.DEF, "Gabriel") });
    squad.push({ playerId: 4, isStarter: true, player: makePlayer(4, Position.DEF, "White") });
    squad.push({ playerId: 5, isStarter: true, player: makePlayer(5, Position.DEF, "Timber") });
    squad.push({ playerId: 13, isStarter: false, player: makePlayer(13, Position.DEF, "Zinchenko") });

    // 4 MID starters, 1 bench
    squad.push({ playerId: 6, isStarter: true, player: makePlayer(6, Position.MID, "Saka") });
    squad.push({ playerId: 7, isStarter: true, player: makePlayer(7, Position.MID, "Rice") });
    squad.push({ playerId: 8, isStarter: true, player: makePlayer(8, Position.MID, "Odegaard") });
    squad.push({ playerId: 9, isStarter: true, player: makePlayer(9, Position.MID, "Martinelli") });
    squad.push({ playerId: 14, isStarter: false, player: makePlayer(14, Position.MID, "Trossard") });

    // 2 FWD starters, 1 bench
    squad.push({ playerId: 10, isStarter: true, player: makePlayer(10, Position.FWD, "Havertz") });
    squad.push({ playerId: 11, isStarter: true, player: makePlayer(11, Position.FWD, "Jesus") });
    squad.push({ playerId: 15, isStarter: false, player: makePlayer(15, Position.FWD, "Nketiah") });
  } else if (formation === "3-5-2") {
    // 3 DEF starters, 2 bench
    squad.push({ playerId: 2, isStarter: true, player: makePlayer(2, Position.DEF, "Saliba") });
    squad.push({ playerId: 3, isStarter: true, player: makePlayer(3, Position.DEF, "Gabriel") });
    squad.push({ playerId: 4, isStarter: true, player: makePlayer(4, Position.DEF, "White") });
    squad.push({ playerId: 13, isStarter: false, player: makePlayer(13, Position.DEF, "Timber") });
    squad.push({ playerId: 14, isStarter: false, player: makePlayer(14, Position.DEF, "Zinchenko") });

    // 5 MID starters, 0 bench
    squad.push({ playerId: 5, isStarter: true, player: makePlayer(5, Position.MID, "Trossard") });
    squad.push({ playerId: 6, isStarter: true, player: makePlayer(6, Position.MID, "Saka") });
    squad.push({ playerId: 7, isStarter: true, player: makePlayer(7, Position.MID, "Rice") });
    squad.push({ playerId: 8, isStarter: true, player: makePlayer(8, Position.MID, "Odegaard") });
    squad.push({ playerId: 9, isStarter: true, player: makePlayer(9, Position.MID, "Martinelli") });

    // 2 FWD starters, 1 bench
    squad.push({ playerId: 10, isStarter: true, player: makePlayer(10, Position.FWD, "Havertz") });
    squad.push({ playerId: 11, isStarter: true, player: makePlayer(11, Position.FWD, "Jesus") });
    squad.push({ playerId: 15, isStarter: false, player: makePlayer(15, Position.FWD, "Nketiah") });
  }

  return squad;
}

describe("SVG Tactical Pitch & Substitution Path Solver (Issue #357)", () => {
  it("computes responsive coordinates centering players within tactical zones", () => {
    // GKP is always centered horizontally at y = 88%
    const gkpCoords = getTacticalSlotCoordinates(Position.GKP, 0, 1);
    assert.equal(gkpCoords.x, 50);
    assert.equal(gkpCoords.y, 88);

    // 4 Defenders row: spacing distributes across width
    const def4_0 = getTacticalSlotCoordinates(Position.DEF, 0, 4);
    const def4_1 = getTacticalSlotCoordinates(Position.DEF, 1, 4);
    const def4_2 = getTacticalSlotCoordinates(Position.DEF, 2, 4);
    const def4_3 = getTacticalSlotCoordinates(Position.DEF, 3, 4);
    assert.equal(def4_0.x, 23);
    assert.equal(def4_1.x, 41);
    assert.equal(def4_2.x, 59);
    assert.equal(def4_3.x, 77);

    // Morphs to 3 Defenders row: spacing morphs and centers
    const def3_0 = getTacticalSlotCoordinates(Position.DEF, 0, 3);
    const def3_1 = getTacticalSlotCoordinates(Position.DEF, 1, 3);
    const def3_2 = getTacticalSlotCoordinates(Position.DEF, 2, 3);
    assert.equal(def3_0.x, 27.5);
    assert.equal(def3_1.x, 50);
    assert.equal(def3_2.x, 72.5);
  });

  it("restricts Goalkeeper substitution paths strictly to bench Goalkeepers", () => {
    const squad = buildTestSquad("4-4-2");
    const starterGkp = squad.find((p) => p.playerId === 1)!;

    const paths = calculateSubstitutionPaths(starterGkp, squad);

    // Only bench GKP (playerId 12) is eligible
    assert.deepEqual(paths.eligiblePlayerIds, [12]);
    assert.ok(paths.ineligibleTargets.length > 0);

    // Outfield players are marked ineligible
    const defenderTarget = paths.allTargets.get(2);
    assert.equal(defenderTarget?.isEligible, false);
    assert.match(defenderTarget?.reason || "", /Goalkeepers can only be swapped with another Goalkeeper/);
  });

  it("calculates tactical formation morphing when subbing DEF for bench MID (4-4-2 -> 3-5-2)", () => {
    const squad = buildTestSquad("4-4-2");
    const starterDef = squad.find((p) => p.playerId === 5)!; // Timber (DEF)

    const paths = calculateSubstitutionPaths(starterDef, squad);

    // Bench Midfielder Trossard (id 14) is an eligible target that morphs formation to 3-5-2
    assert.ok(paths.eligiblePlayerIds.includes(14));

    const morph = paths.possibleFormationMorphs.find((m) => m.targetPlayerId === 14);
    assert.ok(morph, "Should detect formation morph for bench MID");
    assert.equal(morph?.newFormation, "3-5-2");
  });

  it("rejects subbing a Defender when squad is already at minimum 3 defenders", () => {
    const squad = buildTestSquad("3-5-2");
    const starterDef = squad.find((p) => p.playerId === 2)!; // Saliba (one of 3 DEF starters)

    const paths = calculateSubstitutionPaths(starterDef, squad);

    // Bench forward Nketiah (id 15) would leave only 2 defenders -> must be INELIGIBLE
    const fwdTarget = paths.allTargets.get(15);
    assert.equal(fwdTarget?.isEligible, false);
    assert.match(fwdTarget?.reason || "", /Minimum 3 Defenders required/);

    // Bench DEF (id 13) is a like-for-like position swap -> ELIGIBLE
    const defBenchTarget = paths.allTargets.get(13);
    assert.equal(defBenchTarget?.isEligible, true);
  });

  it("allows all Starter <-> Starter tactical swaps for positional reorganization", () => {
    const squad = buildTestSquad("4-4-2");
    const starterMid = squad.find((p) => p.playerId === 6)!; // Saka

    const paths = calculateSubstitutionPaths(starterMid, squad);

    // Swapping with another starter midfielder or forward is allowed
    assert.ok(paths.eligiblePlayerIds.includes(7)); // Rice (MID)
    assert.ok(paths.eligiblePlayerIds.includes(10)); // Havertz (FWD)
  });
});
