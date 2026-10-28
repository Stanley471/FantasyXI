import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { areRatingsCompatible, calculateEloDelta } from "../services/league/matchRatingService.js";

describe("Match rating calculations", () => {
  it("are deterministic and stable over a long balanced simulation", () => {
    let first = 1200;
    let second = 1200;
    for (let game = 0; game < 1000; game++) {
      const firstScore = game % 2 === 0 ? 1 : 0;
      const firstDelta = calculateEloDelta(first, second, firstScore, 0, game, game);
      const secondDelta = calculateEloDelta(second, first, 1 - firstScore, 0, game, game);
      assert.ok(Math.abs(firstDelta + secondDelta) < 1e-10);
      first += firstDelta;
      second += secondDelta;
    }
    assert.ok(Math.abs(first - 1200) < 50);
    assert.ok(Math.abs(second - 1200) < 50);
    assert.ok(Math.abs(first + second - 2400) < 1e-8);
  });

  it("uses a provisional adjustment for players with fewer than ten games", () => {
    const provisional = calculateEloDelta(1200, 1300, 1, 5, 0, 10);
    const established = calculateEloDelta(1200, 1300, 1, 5, 10, 10);
    assert.ok(provisional > established);
  });

  it("pairs players only when both players' rating bands overlap", () => {
    assert.equal(areRatingsCompatible(1200, 1350, 200, 200), true);
    assert.equal(areRatingsCompatible(1200, 1350, 200, 100), false);
  });
});
