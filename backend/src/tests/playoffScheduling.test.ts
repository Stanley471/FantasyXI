import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePlayoffAction } from "../jobs/gameweekSettlement.js";

describe("H2H Playoffs — end-of-season scheduling", () => {
  it("does nothing before the regular season has ended", () => {
    const league = { endGameweekId: 38 };
    assert.deepEqual(resolvePlayoffAction(league, 8, 20), { type: "none" });
  });

  it("generates the bracket on the last regular-season gameweek", () => {
    // 8 members -> 3 rounds -> playoffs start at 38 - 3 + 1 = 36, so the
    // regular season's last gameweek is 35.
    const league = { endGameweekId: 38 };
    assert.deepEqual(resolvePlayoffAction(league, 8, 35), { type: "generate" });
  });

  it("advances the bracket for every gameweek inside the playoff window", () => {
    const league = { endGameweekId: 38 };
    assert.deepEqual(resolvePlayoffAction(league, 8, 36), { type: "advance" });
    assert.deepEqual(resolvePlayoffAction(league, 8, 37), { type: "advance" });
    assert.deepEqual(resolvePlayoffAction(league, 8, 38), { type: "advance" });
  });

  it("scales the playoff window down for a smaller qualifying bracket", () => {
    // 3 active members -> bracket size 2 -> a single final on the last gameweek.
    const league = { endGameweekId: 38 };
    assert.deepEqual(resolvePlayoffAction(league, 3, 37), { type: "generate" });
    assert.deepEqual(resolvePlayoffAction(league, 3, 38), { type: "advance" });
  });

  it("never schedules a bracket for fewer than 2 members", () => {
    const league = { endGameweekId: 38 };
    assert.deepEqual(resolvePlayoffAction(league, 1, 37), { type: "none" });
    assert.deepEqual(resolvePlayoffAction(league, 1, 38), { type: "none" });
  });

  it("does nothing once the season (and its playoffs) has fully concluded", () => {
    const league = { endGameweekId: 38 };
    assert.deepEqual(resolvePlayoffAction(league, 8, 39), { type: "none" });
  });
});
