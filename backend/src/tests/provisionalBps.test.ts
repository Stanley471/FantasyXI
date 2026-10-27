import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocateProvisionalBonus } from "../services/scoring/provisionalBps.js";

describe("provisional BPS bonus allocation", () => {
  it("awards 3, 2, and 1 points to the top three distinct BPS ranks", () => {
    const result = allocateProvisionalBonus([
      { playerId: 1, fixtureId: 10, bps: 33, minutes: 90 },
      { playerId: 2, fixtureId: 10, bps: 22, minutes: 90 },
      { playerId: 3, fixtureId: 10, bps: 11, minutes: 90 },
      { playerId: 4, fixtureId: 10, bps: 8, minutes: 90 },
    ]);
    assert.deepEqual([...result.entries()].sort(), [["10:1", 3], ["10:2", 2], ["10:3", 1]]);
  });

  it("shares tie awards and advances the next rank by the number tied", () => {
    const result = allocateProvisionalBonus([
      { playerId: 1, fixtureId: 10, bps: 30, minutes: 90 },
      { playerId: 2, fixtureId: 10, bps: 30, minutes: 90 },
      { playerId: 3, fixtureId: 10, bps: 20, minutes: 90 },
      { playerId: 4, fixtureId: 10, bps: 10, minutes: 90 },
    ]);
    assert.equal(result.get("10:1"), 3);
    assert.equal(result.get("10:2"), 3);
    assert.equal(result.get("10:3"), 1);
    assert.equal(result.has("10:4"), false);
  });

  it("keeps fixture allocations separate and ignores players without live minutes", () => {
    const result = allocateProvisionalBonus([
      { playerId: 1, fixtureId: 10, bps: 25, minutes: 90 },
      { playerId: 1, fixtureId: 11, bps: 9, minutes: 90 },
      { playerId: 2, fixtureId: 10, bps: 24, minutes: 0 },
    ]);
    assert.equal(result.get("10:1"), 3);
    assert.equal(result.get("11:1"), 3);
    assert.equal(result.has("10:2"), false);
  });
});
