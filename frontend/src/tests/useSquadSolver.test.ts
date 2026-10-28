import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FormationConstraintSolver,
  SolverPlayer,
} from "../lib/solver/formationConstraintSolver";
import { Position } from "../types";

describe("useSquadSolver Hook & Fallback (Issue #343)", () => {
  it("provides synchronous constraint solver fallback in non-worker environments", async () => {
    const players: SolverPlayer[] = [
      { id: 1, position: Position.GKP, teamId: 1, price: 50, isStarter: true },
      { id: 2, position: Position.GKP, teamId: 2, price: 40, isStarter: false },
      { id: 3, position: Position.DEF, teamId: 1, price: 50, isStarter: true },
      { id: 4, position: Position.DEF, teamId: 2, price: 50, isStarter: true },
      { id: 5, position: Position.DEF, teamId: 3, price: 50, isStarter: true },
      { id: 6, position: Position.DEF, teamId: 4, price: 50, isStarter: true },
      { id: 7, position: Position.DEF, teamId: 5, price: 40, isStarter: false },
      { id: 8, position: Position.MID, teamId: 1, price: 60, isStarter: true },
      { id: 9, position: Position.MID, teamId: 6, price: 60, isStarter: true },
      { id: 10, position: Position.MID, teamId: 7, price: 60, isStarter: true },
      { id: 11, position: Position.MID, teamId: 8, price: 60, isStarter: true },
      { id: 12, position: Position.MID, teamId: 9, price: 50, isStarter: false },
      { id: 13, position: Position.FWD, teamId: 10, price: 80, isStarter: true },
      { id: 14, position: Position.FWD, teamId: 11, price: 80, isStarter: true },
      { id: 15, position: Position.FWD, teamId: 12, price: 50, isStarter: false },
    ];

    // Direct synchronous fallback invocation
    const result = FormationConstraintSolver.validateSquad(players, 1000);
    assert.equal(result.valid, true);
    assert.equal(result.formation, "4-4-2");

    const formations = FormationConstraintSolver.findPermissibleFormations(players);
    assert.equal(formations.length, 8);
  });
});
