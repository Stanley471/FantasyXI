import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FormationConstraintSolver,
  SolverPlayer,
  VALID_FORMATIONS,
} from "../lib/solver/formationConstraintSolver";
import { Position } from "../types";

function createMockSquad(): SolverPlayer[] {
  return [
    // 2 GKP
    { id: 1, position: Position.GKP, teamId: 1, price: 50, isStarter: true },
    { id: 2, position: Position.GKP, teamId: 2, price: 40, isStarter: false },
    // 5 DEF
    { id: 3, position: Position.DEF, teamId: 1, price: 60, isStarter: true },
    { id: 4, position: Position.DEF, teamId: 2, price: 55, isStarter: true },
    { id: 5, position: Position.DEF, teamId: 3, price: 50, isStarter: true },
    { id: 6, position: Position.DEF, teamId: 4, price: 45, isStarter: true },
    { id: 7, position: Position.DEF, teamId: 5, price: 40, isStarter: false },
    // 5 MID
    { id: 8, position: Position.MID, teamId: 1, price: 100, isStarter: true },
    { id: 9, position: Position.MID, teamId: 6, price: 80, isStarter: true },
    { id: 10, position: Position.MID, teamId: 7, price: 75, isStarter: true },
    { id: 11, position: Position.MID, teamId: 8, price: 70, isStarter: true },
    { id: 12, position: Position.MID, teamId: 9, price: 50, isStarter: false },
    // 3 FWD
    { id: 13, position: Position.FWD, teamId: 10, price: 120, isStarter: true },
    { id: 14, position: Position.FWD, teamId: 11, price: 85, isStarter: true },
    { id: 15, position: Position.FWD, teamId: 12, price: 50, isStarter: false },
  ];
}

describe("Formation Constraint Solver & Squad Optimizer (Issue #343)", () => {
  it("validates a standard 4-4-2 starting formation within budget and club caps", () => {
    const squad = createMockSquad();
    const result = FormationConstraintSolver.validateSquad(squad, 1000); // 100.0m

    assert.equal(result.valid, true);
    assert.equal(result.formation, "4-4-2");
    assert.equal(result.clubViolations.length, 0);
    assert.equal(result.errors.length, 0);
    assert.ok(result.totalCost <= 1000);
  });

  it("recognizes all 8 standard FPL formations", () => {
    assert.equal(FormationConstraintSolver.isValidFormation(3, 5, 2), true);
    assert.equal(FormationConstraintSolver.isValidFormation(3, 4, 3), true);
    assert.equal(FormationConstraintSolver.isValidFormation(4, 4, 2), true);
    assert.equal(FormationConstraintSolver.isValidFormation(4, 3, 3), true);
    assert.equal(FormationConstraintSolver.isValidFormation(4, 5, 1), true);
    assert.equal(FormationConstraintSolver.isValidFormation(5, 3, 2), true);
    assert.equal(FormationConstraintSolver.isValidFormation(5, 4, 1), true);
    assert.equal(FormationConstraintSolver.isValidFormation(5, 2, 3), true);

    // Invalid formations
    assert.equal(FormationConstraintSolver.isValidFormation(2, 5, 3), false); // Min 3 DEF
    assert.equal(FormationConstraintSolver.isValidFormation(6, 3, 1), false); // Max 5 DEF
    assert.equal(FormationConstraintSolver.isValidFormation(4, 1, 5), false); // Min 2 MID, Max 3 FWD
    assert.equal(FormationConstraintSolver.isValidFormation(4, 6, 0), false); // Max 5 MID, Min 1 FWD
  });

  it("enforces maximum 3 players per club constraint", () => {
    const squad = createMockSquad();
    // Set 4 players to teamId 1 (e.g. Arsenal)
    squad[0].teamId = 1;
    squad[2].teamId = 1;
    squad[7].teamId = 1;
    squad[8].teamId = 1; // 4th player from team 1

    const result = FormationConstraintSolver.validateSquad(squad);
    assert.equal(result.valid, false);
    assert.deepEqual(result.clubViolations, [1]);
    assert.ok(result.errors.some((e) => e.includes("Exceeded club limit")));
  });

  it("enforces budget cap constraint", () => {
    const squad = createMockSquad();
    // Budget set to 80.0m (800 tenths), whereas squad cost is ~97.0m (970 tenths)
    const result = FormationConstraintSolver.validateSquad(squad, 800);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("exceeds budget")));
  });

  it("finds all permissible formations that can be fielded from squad outfielders", () => {
    const squad = createMockSquad();
    const permissible = FormationConstraintSolver.findPermissibleFormations(squad);

    // Standard 5 DEF, 5 MID, 3 FWD can field all 8 official formations
    assert.equal(permissible.length, 8);
    for (const f of VALID_FORMATIONS) {
      assert.ok(permissible.includes(f));
    }
  });

  it("evaluates single transfer swaps incrementally in sub-milliseconds", () => {
    const squad = createMockSquad();
    const playerOut = squad.find((p) => p.id === 3)!; // DEF, team 1, price 60

    // 1. Valid transfer: Replace DEF price 60 with DEF price 55 (team 7)
    const validIn: SolverPlayer = {
      id: 99,
      position: Position.DEF,
      teamId: 7,
      price: 55,
    };
    const evalValid = FormationConstraintSolver.evaluateTransfer(squad, playerOut.id, validIn);
    assert.equal(evalValid.valid, true);
    assert.equal(evalValid.wouldViolateClubLimit, false);

    // 2. Invalid transfer: Position mismatch (DEF -> FWD)
    const invalidPosIn: SolverPlayer = {
      id: 100,
      position: Position.FWD,
      teamId: 7,
      price: 55,
    };
    const evalPos = FormationConstraintSolver.evaluateTransfer(squad, playerOut.id, invalidPosIn);
    assert.equal(evalPos.valid, false);
    assert.match(evalPos.reason!, /Position mismatch/);

    // 3. Invalid transfer: Club limit violation
    // Squad already has 2 players from team 1 (player 1 and player 8, player 3 was transferred out)
    // If incoming player is from team 2 (squad already has player 2 and player 4 from team 2)
    // plus another player from team 2 would be 3 (allowed), but adding a 4th violates
    const clubViolatorIn: SolverPlayer = {
      id: 101,
      position: Position.DEF,
      teamId: 2,
      price: 50,
    };
    // Make squad already have 3 players from team 2
    squad[4].teamId = 2; // player 2, 4, 5 all team 2
    const evalClub = FormationConstraintSolver.evaluateTransfer(squad, playerOut.id, clubViolatorIn);
    assert.equal(evalClub.valid, false);
    assert.equal(evalClub.wouldViolateClubLimit, true);
    assert.match(evalClub.reason!, /Exceeds club limit/);
  });

  it("filters candidate pool to only feasible transfers", () => {
    const squad = createMockSquad();
    const playerOut = squad.find((p) => p.id === 8)!; // MID, price 100, team 1

    const candidatePool: SolverPlayer[] = [
      { id: 201, position: Position.MID, teamId: 2, price: 90 }, // Feasible
      { id: 202, position: Position.MID, teamId: 3, price: 95 }, // Feasible
      { id: 203, position: Position.FWD, teamId: 4, price: 90 }, // Wrong position
      { id: 204, position: Position.MID, teamId: 5, price: 250 }, // Over budget
      { id: 1, position: Position.MID, teamId: 1, price: 50 }, // Already in squad
    ];

    const feasible = FormationConstraintSolver.filterFeasibleTransfers(
      squad,
      playerOut.id,
      candidatePool,
      1000
    );

    assert.equal(feasible.length, 2);
    assert.deepEqual(
      feasible.map((p) => p.id),
      [201, 202]
    );
  });

  it("performance benchmark: evaluates 1,000 transfer permutations in under 50ms", () => {
    const squad = createMockSquad();
    const playerOut = squad[2];

    const candidatePool: SolverPlayer[] = Array.from({ length: 1000 }, (_, i) => ({
      id: 1000 + i,
      position: Position.DEF,
      teamId: (i % 20) + 1,
      price: Math.floor(Math.random() * 40) + 40,
    }));

    const start = performance.now();
    const feasible = FormationConstraintSolver.filterFeasibleTransfers(
      squad,
      playerOut.id,
      candidatePool,
      1000
    );
    const duration = performance.now() - start;

    assert.ok(feasible.length > 0);
    assert.ok(
      duration < 50,
      `Evaluating 1,000 transfers took ${duration.toFixed(2)}ms, expected < 50ms`
    );
  });
});
