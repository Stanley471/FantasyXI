import test from "node:test";
import assert from "node:assert/strict";
import { createSettlementProof } from "../services/financial/settlementProof.js";

test("settlement proof is deterministic regardless of winner input order", () => {
  const base = {
    leagueId: "league-1",
    grossPool: 100,
    platformFee: 5,
  };
  const first = createSettlementProof({
    ...base,
    winners: [
      { rank: 2, userId: "u2", stellarAddress: "G2", totalPoints: 90, prizeAmount: 28.5 },
      { rank: 1, userId: "u1", stellarAddress: "G1", totalPoints: 100, prizeAmount: 66.5 },
    ],
  });
  const second = createSettlementProof({
    ...base,
    winners: [
      { rank: 1, userId: "u1", stellarAddress: "G1", totalPoints: 100, prizeAmount: 66.5 },
      { rank: 2, userId: "u2", stellarAddress: "G2", totalPoints: 90, prizeAmount: 28.5 },
    ],
  });
  assert.equal(first, second);
  assert.equal(first.length, 64);
});
