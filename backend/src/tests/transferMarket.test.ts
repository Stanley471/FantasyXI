import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SquadService } from "../services/squad/squadService.js";
import { SquadValidationError } from "../services/squad/squadValidator.js";
import { ScoringService } from "../services/scoring/scoringService.js";
import { Position } from "../types/index.js";

describe("Transfer Market Economics", () => {
  describe("Selling price", () => {
    it("keeps half the profit, rounded down, when the price has risen", () => {
      assert.equal(SquadService.calculateSellingPrice(5.0, 5.4), 5.2);
      assert.equal(SquadService.calculateSellingPrice(5.0, 5.3), 5.1); // 0.15 -> 0.1
      assert.equal(SquadService.calculateSellingPrice(7.5, 7.6), 7.5); // 0.05 -> 0.0
      assert.equal(SquadService.calculateSellingPrice(10.0, 12.1), 11.0);
    });

    it("sells at the current price when the price is unchanged or has dropped", () => {
      assert.equal(SquadService.calculateSellingPrice(6.0, 6.0), 6.0);
      assert.equal(SquadService.calculateSellingPrice(6.0, 5.7), 5.7);
    });
  });

  describe("Free transfer rollover", () => {
    it("adds one free transfer per elapsed gameweek", () => {
      assert.equal(SquadService.rollFreeTransfers(1, 0), 1);
      assert.equal(SquadService.rollFreeTransfers(1, 1), 2);
      assert.equal(SquadService.rollFreeTransfers(0, 1), 1);
      assert.equal(SquadService.rollFreeTransfers(2, 2), 4);
    });

    it("caps the banked free transfers at 5", () => {
      assert.equal(SquadService.rollFreeTransfers(4, 3), 5);
      assert.equal(SquadService.rollFreeTransfers(5, 1), 5);
    });
  });

  describe("-4 point hits", () => {
    it("charges nothing while within the free allowance", () => {
      assert.deepEqual(SquadService.calculateTransferCosts(2, 2), [0, 0]);
    });

    it("charges -4 for every transfer beyond the free allowance", () => {
      assert.deepEqual(SquadService.calculateTransferCosts(3, 1), [0, 4, 4]);
      assert.deepEqual(SquadService.calculateTransferCosts(2, 0), [4, 4]);
    });

    it("deducts the hits from the gameweek score", () => {
      const lineup = [
        { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 1 },
        { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 2 },
      ];
      const stats = new Map([
        [1, { minutes: 90, totalPoints: 6 }],
        [2, { minutes: 90, totalPoints: 5 }],
      ]);

      const result = ScoringService.calculateLineupScore(lineup, stats, { transferCost: 8 });
      assert.equal(result.startingPoints, 16);
      assert.equal(result.transferCost, 8);
      assert.equal(result.totalPoints, 8);
    });
  });

  describe("Transfer pairing", () => {
    it("pairs sold and bought players by position", () => {
      const pairs = SquadService.pairTransfers(
        [
          { id: 1, position: Position.MID },
          { id: 2, position: Position.DEF },
        ],
        [
          { id: 10, position: Position.DEF },
          { id: 11, position: Position.MID },
        ]
      );
      assert.deepEqual(pairs, [
        { playerOutId: 1, playerInId: 11 },
        { playerOutId: 2, playerInId: 10 },
      ]);
    });

    it("rejects a transfer without a same-position replacement", () => {
      assert.throws(
        () =>
          SquadService.pairTransfers(
            [{ id: 1, position: Position.GKP }],
            [{ id: 10, position: Position.FWD }]
          ),
        SquadValidationError
      );
    });
  });
});
