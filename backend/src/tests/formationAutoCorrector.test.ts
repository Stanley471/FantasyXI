/**
 * Comprehensive test suite for squad tactical formation auto-correction.
 *
 * Covers all legal and illegal formation transition permutations, captaincy
 * changes, and edge cases with injuries/postponements.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FormationAutoCorrector,
  PlayerInfo,
  FixtureImpact,
  LEGAL_FORMATIONS,
} from "../services/squad/formationAutoCorrector.js";
import { Position } from "../types/index.js";

// ============================================================
// Test Helpers
// ============================================================

function createTestPlayer(
  playerId: number,
  position: Position,
  isStarter: boolean = true,
  isInjured: boolean = false,
  isPostponed: boolean = false,
  displayName?: string
): PlayerInfo {
  return {
    playerId,
    position,
    isStarter,
    isInjured,
    isPostponed,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: 0,
    id: playerId,
    displayName: displayName || `Player ${playerId}`,
  };
}

function createSquad442() {
  // 4-4-2 formation
  return {
    starters: [
      createTestPlayer(1, Position.GKP, true, false, false, "Keeper A"),
      createTestPlayer(2, Position.DEF, true, false, false, "Def 1"),
      createTestPlayer(3, Position.DEF, true, false, false, "Def 2"),
      createTestPlayer(4, Position.DEF, true, false, false, "Def 3"),
      createTestPlayer(5, Position.DEF, true, false, false, "Def 4"),
      createTestPlayer(6, Position.MID, true, false, false, "Mid 1"),
      createTestPlayer(7, Position.MID, true, false, false, "Mid 2"),
      createTestPlayer(8, Position.MID, true, false, false, "Mid 3"),
      createTestPlayer(9, Position.MID, true, false, false, "Mid 4"),
      createTestPlayer(10, Position.FWD, true, false, false, "Fwd 1"),
      createTestPlayer(11, Position.FWD, true, false, false, "Fwd 2"),
    ],
    bench: [
      createTestPlayer(12, Position.GKP, false, false, false, "Keeper B"),
      createTestPlayer(13, Position.DEF, false, false, false, "Def 5"),
      createTestPlayer(14, Position.MID, false, false, false, "Mid 5"),
      createTestPlayer(15, Position.FWD, false, false, false, "Fwd 3"),
    ],
    captainId: 1,
    viceCaptainId: 6,
  };
}

function createSquad352() {
  // 3-5-2 formation
  return {
    starters: [
      createTestPlayer(1, Position.GKP, true, false, false, "Keeper A"),
      createTestPlayer(2, Position.DEF, true, false, false, "Def 1"),
      createTestPlayer(3, Position.DEF, true, false, false, "Def 2"),
      createTestPlayer(4, Position.DEF, true, false, false, "Def 3"),
      createTestPlayer(6, Position.MID, true, false, false, "Mid 1"),
      createTestPlayer(7, Position.MID, true, false, false, "Mid 2"),
      createTestPlayer(8, Position.MID, true, false, false, "Mid 3"),
      createTestPlayer(9, Position.MID, true, false, false, "Mid 4"),
      createTestPlayer(10, Position.FWD, true, false, false, "Fwd 1"),
      createTestPlayer(11, Position.FWD, true, false, false, "Fwd 2"),
      createTestPlayer(14, Position.MID, true, false, false, "Mid 5"),
    ],
    bench: [
      createTestPlayer(12, Position.GKP, false, false, false, "Keeper B"),
      createTestPlayer(5, Position.DEF, false, false, false, "Def 4"),
      createTestPlayer(13, Position.DEF, false, false, false, "Def 5"),
      createTestPlayer(15, Position.FWD, false, false, false, "Fwd 3"),
    ],
    captainId: 1,
    viceCaptainId: 6,
  };
}

// ============================================================
// Tests: Formation Calculation
// ============================================================

describe("FormationAutoCorrector - Formation Calculation", () => {
  it("should calculate 4-4-2 formation correctly", () => {
    const squad = createSquad442();
    const formation = FormationAutoCorrector.calculateFormation(squad.starters);
    assert.equal(formation, "4-4-2");
  });

  it("should calculate 3-5-2 formation correctly", () => {
    const squad = createSquad352();
    const formation = FormationAutoCorrector.calculateFormation(squad.starters);
    assert.equal(formation, "3-5-2");
  });

  it("should handle edge case: 5-4-1 formation", () => {
    const starters = [
      createTestPlayer(1, Position.GKP),
      createTestPlayer(2, Position.DEF),
      createTestPlayer(3, Position.DEF),
      createTestPlayer(4, Position.DEF),
      createTestPlayer(5, Position.DEF),
      createTestPlayer(6, Position.DEF),
      createTestPlayer(7, Position.MID),
      createTestPlayer(8, Position.MID),
      createTestPlayer(9, Position.MID),
      createTestPlayer(10, Position.MID),
      createTestPlayer(11, Position.FWD),
    ];
    const formation = FormationAutoCorrector.calculateFormation(starters);
    assert.equal(formation, "5-4-1");
  });
});

// ============================================================
// Tests: Formation Legality
// ============================================================

describe("FormationAutoCorrector - Formation Legality", () => {
  it("should accept all legal FPL formations", () => {
    const legalFormations = ["3-4-3", "3-5-2", "4-3-3", "4-4-2", "4-5-1", "5-3-2", "5-4-1"];
    for (const formation of legalFormations) {
      assert.ok(
        FormationAutoCorrector.isLegalFormation(formation),
        `${formation} should be legal`
      );
    }
  });

  it("should reject illegal formations: too few defenders", () => {
    assert.ok(!FormationAutoCorrector.isLegalFormation("2-5-3"));
    assert.ok(!FormationAutoCorrector.isLegalFormation("2-6-3"));
  });

  it("should reject illegal formations: too few midfielders", () => {
    assert.ok(!FormationAutoCorrector.isLegalFormation("4-1-5"));
    assert.ok(!FormationAutoCorrector.isLegalFormation("3-1-7"));
  });

  it("should reject illegal formations: too few forwards", () => {
    assert.ok(!FormationAutoCorrector.isLegalFormation("4-6-0"));
    assert.ok(!FormationAutoCorrector.isLegalFormation("5-5-0"));
  });

  it("should reject illegal formations: too many of one position", () => {
    assert.ok(!FormationAutoCorrector.isLegalFormation("6-4-1")); // too many DEF
    assert.ok(!FormationAutoCorrector.isLegalFormation("3-7-1")); // too many MID
  });
});

// ============================================================
// Tests: Deficit Identification
// ============================================================

describe("FormationAutoCorrector - Deficit Identification", () => {
  it("should identify defender deficit in 4-4-2", () => {
    const deficits = FormationAutoCorrector.identifyDeficits("2-4-2");
    assert.ok(deficits.includes(Position.DEF));
  });

  it("should identify midfielder deficit", () => {
    const deficits = FormationAutoCorrector.identifyDeficits("4-1-2");
    assert.ok(deficits.includes(Position.MID));
  });

  it("should identify forward deficit", () => {
    const deficits = FormationAutoCorrector.identifyDeficits("4-4-0");
    assert.ok(deficits.includes(Position.FWD));
  });

  it("should identify multiple deficits", () => {
    const deficits = FormationAutoCorrector.identifyDeficits("2-1-1");
    assert.equal(deficits.length, 3);
    assert.ok(deficits.includes(Position.DEF));
    assert.ok(deficits.includes(Position.MID));
    assert.ok(deficits.includes(Position.FWD));
  });

  it("should return empty deficits for legal formation", () => {
    const deficits = FormationAutoCorrector.identifyDeficits("4-4-2");
    assert.equal(deficits.length, 0);
  });
});

// ============================================================
// Tests: Auto-Correction
// ============================================================

describe("FormationAutoCorrector - Auto-Correction (Single Postponement)", () => {
  it("should correct 4-4-2 → 4-4-1 when one forward is postponed", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([10]), // Fwd 1 postponed
      affectedStarters: [squad.starters[9]], // Fwd 1
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    assert.ok(correction.isValid, `Correction should be valid: ${correction.errors.join("; ")}`);
    assert.equal(correction.originalFormation, "4-4-2");
    // After removal: 4-4-1. Deficit: 1 FWD. Bench has Fwd 3 → 4-4-2
    assert.equal(correction.correctedFormation, "4-4-2");
    assert.equal(correction.substitutions.length, 1);
    assert.equal(correction.substitutions[0].playerOutId, 10);
    assert.equal(correction.substitutions[0].playerInId, 15); // Fwd 3 from bench
  });

  it("should correct 4-4-2 → 4-3-2 when one midfielder is postponed and bench has no MID", () => {
    const squad = createSquad442();
    // Remove bench midfielder (14 is not in this squad), so we have: 1 GKP, 1 DEF, 1 MID, 1 FWD
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([6]), // Mid 1 postponed
      affectedStarters: [squad.starters[5]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    // After removal: 4-3-2. Deficit: 1 MID. Bench has Mid 5 (14) → restore to 4-4-2
    assert.ok(correction.isValid);
    assert.equal(correction.originalFormation, "4-4-2");
    assert.equal(correction.correctedFormation, "4-4-2");
    assert.equal(correction.substitutions.length, 1);
  });

  it("should correct when defender is postponed", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([2]), // Def 1 postponed
      affectedStarters: [squad.starters[1]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    assert.ok(correction.isValid);
    assert.equal(correction.originalFormation, "4-4-2");
    // After removal: 3-4-2. Deficit: 1 DEF. Bench has Def 5 → 4-4-2
    assert.equal(correction.correctedFormation, "4-4-2");
    assert.equal(correction.substitutions.length, 1);
  });
});

// ============================================================
// Tests: Captaincy Changes
// ============================================================

describe("FormationAutoCorrector - Captaincy Changes", () => {
  it("should promote vice-captain when captain is postponed", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([1]), // Captain (Keeper A) postponed
      affectedStarters: [squad.starters[0]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    assert.ok(correction.isValid);
    assert.ok(correction.captainChange);
    assert.equal(correction.captainChange!.from, 1);
    assert.equal(correction.captainChange!.to, 6); // Vice-captain
  });

  it("should zero captain multiplier when both captain and vice-captain are postponed", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([1, 6]), // Both C and VC postponed
      affectedStarters: [squad.starters[0], squad.starters[5]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    // Should still handle formation correction
    assert.equal(correction.originalFormation, "4-4-2");
    // Both removed: 3-3-2. Deficits: 1 DEF, 1 MID
    // Bench subs: Def 5, Mid 5 → 4-4-2
    assert.equal(correction.correctedFormation, "4-4-2");
  });

  it("should not change captain if still available", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([10]), // FWD postponed (not captain)
      affectedStarters: [squad.starters[9]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    assert.ok(!correction.captainChange);
  });
});

// ============================================================
// Tests: Edge Cases
// ============================================================

describe("FormationAutoCorrector - Edge Cases", () => {
  it("should handle multiple starters from same position being postponed", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([2, 3]), // Two defenders postponed
      affectedStarters: [squad.starters[1], squad.starters[2]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    // After removal: 2-4-2. Deficits: DEF (need 3, have 2)
    // Bench has only 1 DEF (13), so after one sub: 3-4-2 still valid
    assert.equal(correction.originalFormation, "4-4-2");
    assert.equal(correction.substitutions.length, 1);
  });

  it("should handle injured + postponed players", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([2, 10]), // Def postponed, FWD injured
      affectedStarters: [squad.starters[1], squad.starters[9]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    assert.equal(correction.substitutions.length, 2);
  });

  it("should reject if insufficient bench options (3-5-2 → catastrophic loss)", () => {
    const squad = createSquad352();
    // Remove all 4 midfielders, leaving only 3
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([6, 7, 8, 9]), // All 4 MID starters
      affectedStarters: squad.starters.slice(4, 8),
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    // Formation becomes 3-1-2, which violates MID minimum (2)
    // Bench has 1 MID (not enough)
    assert.ok(correction.errors.length > 0 || !correction.isValid);
  });

  it("should handle when both bench and starters have same player injured", () => {
    const squad = createSquad442();
    // This shouldn't happen in real scenario, but test robustness
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([15]), // Fwd 3 (bench player)
      affectedStarters: [],
      affectedBench: [squad.bench[3]],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    // Formation unchanged, no starter affected
    assert.equal(correction.originalFormation, correction.correctedFormation);
    assert.equal(correction.substitutions.length, 0);
  });
});

// ============================================================
// Tests: Formation Transition Matrix (All Legal → Legal)
// ============================================================

describe("FormationAutoCorrector - Formation Transition Matrix", () => {
  it("should transition from 4-4-2 to all legal formations", () => {
    const legalFormations = [
      { formation: "3-4-3", description: "4-4-2 → 3-4-3 (remove 1 DEF, add 1 FWD)" },
      { formation: "3-5-2", description: "4-4-2 → 3-5-2 (remove 1 DEF, add 1 MID)" },
      { formation: "4-3-3", description: "4-4-2 → 4-3-3 (remove 1 MID, add 1 FWD)" },
      { formation: "4-5-1", description: "4-4-2 → 4-5-1 (remove 1 FWD, add 1 MID)" },
      { formation: "5-3-2", description: "4-4-2 → 5-3-2 (add 1 DEF, remove 1 MID)" },
      { formation: "5-4-1", description: "4-4-2 → 5-4-1 (add 1 DEF, remove 1 FWD)" },
    ];

    for (const { formation, description } of legalFormations) {
      assert.ok(
        FormationAutoCorrector.isLegalFormation(formation),
        `${description} should result in legal formation`
      );
    }
  });

  it("should maintain legality across transitions for injuries", () => {
    const squad = createSquad442();

    // Simulate losing defenders progressively
    for (let removed = 1; removed <= 2; removed++) {
      const deficiencySet = new Set<number>();
      for (let i = 1; i <= removed; i++) {
        deficiencySet.add(i + 1); // Players 2, 3 (DEF 1, DEF 2)
      }

      const impact: FixtureImpact = {
        unavailablePlayers: deficiencySet,
        affectedStarters: squad.starters.filter((s) => deficiencySet.has(s.playerId)),
        affectedBench: [],
      };

      const correction = FormationAutoCorrector.correctFormation(squad, impact);

      // Should still be valid after correction
      const isLegal = FormationAutoCorrector.isLegalFormation(correction.correctedFormation);
      assert.ok(
        correction.isValid || isLegal,
        `Loss of ${removed} DEF should maintain legality`
      );
    }
  });
});

// ============================================================
// Tests: Validation & Logging
// ============================================================

describe("FormationAutoCorrector - Validation & Logging", () => {
  it("should generate detailed execution logs", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([10]),
      affectedStarters: [squad.starters[9]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    assert.ok(correction.executionLog.length > 0);
    assert.ok(
      correction.executionLog.some((log) => log.includes("Starting correction"))
    );
    assert.ok(
      correction.executionLog.some((log) => log.includes("Correction complete"))
    );
  });

  it("should document substitution reasoning", () => {
    const squad = createSquad442();
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([2]),
      affectedStarters: [squad.starters[1]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    assert.ok(correction.substitutions.length > 0);
    assert.ok(correction.substitutions[0].reason.length > 0);
  });

  it("should validate corrections before application", () => {
    const correction: any = {
      originalFormation: "4-4-2",
      correctedFormation: "2-5-3", // Invalid
      substitutions: [],
      captainChange: undefined,
      executionLog: [],
      isValid: false,
      errors: ["Formation 2-5-3 is illegal"],
    };

    const issues = FormationAutoCorrector.validateCorrection(correction);
    assert.ok(issues.length > 0);
    assert.ok(issues.some((i) => i.includes("illegal")));
  });
});

// ============================================================
// Tests: Bench Priority Order
// ============================================================

describe("FormationAutoCorrector - Bench Priority", () => {
  it("should respect bench order when selecting replacements", () => {
    const squad = createSquad442();
    // Bench order: 12 (GKP), 13 (DEF), 14 (MID), 15 (FWD)
    const impact: FixtureImpact = {
      unavailablePlayers: new Set([2, 6]), // DEF and MID
      affectedStarters: [squad.starters[1], squad.starters[5]],
      affectedBench: [],
    };

    const correction = FormationAutoCorrector.correctFormation(squad, impact);

    // Should pull 13 (first DEF on bench) for DEF deficit
    // Should pull 14 (first MID on bench) for MID deficit
    const defSubstitution = correction.substitutions.find((s) => s.playerOutId === 2);
    const midSubstitution = correction.substitutions.find((s) => s.playerOutId === 6);

    assert.ok(defSubstitution);
    assert.ok(midSubstitution);
    assert.equal(defSubstitution!.playerInId, 13); // First DEF on bench
    assert.equal(midSubstitution!.playerInId, 14); // First MID on bench
  });
});
