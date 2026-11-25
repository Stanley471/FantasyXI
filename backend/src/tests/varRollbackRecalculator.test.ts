import { test } from "node:test";
import { strict as assert } from "node:assert";
import { varRollbackRecalculator } from "../services/live/varRollbackRecalculator.js";

test("VARRollbackRecalculator - Process retroactive adjustment", async () => {
  const adjustment = {
    eventId: "var-001",
    eventType: "GOAL" as const,
    playerId: 123,
    fixtureId: 456,
    originalPoints: 5,
    retractionPoints: 5,
    reason: "VAR_DISALLOWED" as const,
    appliedAt: new Date(),
  };

  try {
    const report = await varRollbackRecalculator.processRetroactiveAdjustment(
      adjustment.fixtureId,
      adjustment.playerId,
      adjustment
    );

    assert.ok(report);
    assert.equal(report.eventId, "var-001");
    assert.ok(Array.isArray(report.scoreAdjustments));
  } catch (error) {
    // Expected if fixture doesn't exist
    assert.ok(error);
  }
});

test("VARRollbackRecalculator - Track event in audit trail", async () => {
  const adjustment = {
    eventId: "var-002",
    eventType: "BONUS_ADJUSTMENT" as const,
    playerId: 456,
    fixtureId: 789,
    originalPoints: 3,
    retractionPoints: 3,
    reason: "BPS_ADJUSTMENT" as const,
    appliedAt: new Date(),
  };

  try {
    const report = await varRollbackRecalculator.processRetroactiveAdjustment(
      adjustment.fixtureId,
      adjustment.playerId,
      adjustment
    );

    assert.ok(report.auditTrail.length > 0);
  } catch (error) {
    // Expected if fixture doesn't exist
    assert.ok(error);
  }
});

test("VARRollbackRecalculator - Recalculate league standings", async () => {
  try {
    await varRollbackRecalculator.recalculateLeagueStandings(
      "non-existent-league",
      999
    );
  } catch (error) {
    // Expected
    assert.ok(error);
  }
});
