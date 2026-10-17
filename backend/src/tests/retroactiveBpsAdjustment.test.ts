import test from "node:test";
import assert from "node:assert/strict";
import {
  RetroactiveBpsAdjustmentService,
  LeagueAdjustmentTarget,
} from "../services/scoring/retroactiveBpsAdjustmentService.js";

test("RetroactiveBpsAdjustmentService.allocateFixtureBonusPoints: enforces official FPL tie-breaking rules", () => {
  // Case 1: Tie for 1st (2 players at 45 BPS), next at 38 BPS -> 3, 3, 1, 0
  const tieFirstTwo = RetroactiveBpsAdjustmentService.allocateFixtureBonusPoints([
    { playerId: 1, minutes: 90, bps: 45 },
    { playerId: 2, minutes: 90, bps: 45 },
    { playerId: 3, minutes: 90, bps: 38 },
    { playerId: 4, minutes: 90, bps: 35 },
  ]);
  assert.equal(tieFirstTwo.get(1), 3);
  assert.equal(tieFirstTwo.get(2), 3);
  assert.equal(tieFirstTwo.get(3), 1);
  assert.equal(tieFirstTwo.get(4), 0);

  // Case 2: Tie for 2nd (1st at 50 BPS, two tied at 42 BPS, next at 39 BPS) -> 3, 2, 2, 0
  const tieSecond = RetroactiveBpsAdjustmentService.allocateFixtureBonusPoints([
    { playerId: 1, minutes: 90, bps: 50 },
    { playerId: 2, minutes: 90, bps: 42 },
    { playerId: 3, minutes: 90, bps: 42 },
    { playerId: 4, minutes: 90, bps: 39 },
  ]);
  assert.equal(tieSecond.get(1), 3);
  assert.equal(tieSecond.get(2), 2);
  assert.equal(tieSecond.get(3), 2);
  assert.equal(tieSecond.get(4), 0);
});

test("RetroactiveBpsAdjustmentService: propagates stat corrections, records state diffs, and blocks on-chain settled leagues", () => {
  const service = new RetroactiveBpsAdjustmentService();

  const previousStats = [
    {
      playerId: 10,
      fixtureId: 400,
      gameweekId: 15,
      minutes: 90,
      bps: 40,
      bonus: 3,
      basePointsWithoutBonus: 7,
      totalPoints: 10,
    },
    {
      playerId: 20,
      fixtureId: 400,
      gameweekId: 15,
      minutes: 90,
      bps: 38,
      bonus: 2,
      basePointsWithoutBonus: 6,
      totalPoints: 8,
    },
  ];

  // Post-match Opta review awards an assist (+3 base, +6 BPS) to Player 20,
  // flipping bonus from Player 10 (now 40 BPS -> 2 bonus -> 9 pts, delta = -1)
  // to Player 20 (now 44 BPS -> 3 bonus + 9 base -> 12 pts, delta = +4)
  const updatedRawStats = [
    { playerId: 10, minutes: 90, bps: 40, basePointsWithoutBonus: 7 },
    { playerId: 20, minutes: 90, bps: 44, basePointsWithoutBonus: 9 },
  ];

  const activeLeague: LeagueAdjustmentTarget = {
    leagueId: "league-unsettled",
    leagueName: "Active Weekly League",
    onChainSettled: false,
    squads: [
      {
        squadId: "sq-leader",
        userId: "u-1",
        gameweekPoints: 65,
        totalSeasonPoints: 500,
        rank: 1,
        lineup: [{ playerId: 10, isStarter: true, multiplier: 2 }], // Captained Player 10 (-2 delta -> 498)
      },
      {
        squadId: "sq-challenger",
        userId: "u-2",
        gameweekPoints: 60,
        totalSeasonPoints: 495,
        rank: 2,
        lineup: [{ playerId: 20, isStarter: true, multiplier: 2 }], // Captained Player 20 (+8 delta -> 503)
      },
    ],
  };

  const settledLeague: LeagueAdjustmentTarget = {
    leagueId: "league-settled-onchain",
    leagueName: "Already Settled Escrow League",
    onChainSettled: true,
    settlementTxHash: "0xabc123settled",
    squads: [
      {
        squadId: "sq-settled-1",
        userId: "u-9",
        gameweekPoints: 70,
        totalSeasonPoints: 70,
        rank: 1,
        lineup: [{ playerId: 20, isStarter: true, multiplier: 3 }],
      },
    ],
  };

  const audit = service.applyRetroactiveFixtureAdjustment({
    gameweekId: 15,
    fixtureId: 400,
    reason: "Opta post-match assist & BPS correction",
    previousStats,
    updatedRawStats,
    leagues: [activeLeague, settledLeague],
  });

  // 1. Verify player stat deltas
  assert.equal(audit.playerDeltas.length, 2);
  const p20Delta = audit.playerDeltas.find((d) => d.playerId === 20)!;
  assert.equal(p20Delta.bonusBefore, 2);
  assert.equal(p20Delta.bonusAfter, 3);
  assert.equal(p20Delta.pointsDelta, 4);

  // 2. Verify unsettled league rankings flipped atomically
  assert.equal(activeLeague.squads[0].squadId, "sq-challenger");
  assert.equal(activeLeague.squads[0].totalSeasonPoints, 503);
  assert.equal(activeLeague.squads[0].rank, 1);
  assert.equal(activeLeague.squads[1].squadId, "sq-leader");
  assert.equal(activeLeague.squads[1].totalSeasonPoints, 498);
  assert.equal(activeLeague.squads[1].rank, 2);

  // 3. Verify settled league was NOT mutated and emitted a critical discrepancy alert
  assert.equal(settledLeague.squads[0].totalSeasonPoints, 70);
  assert.equal(audit.postSettlementAlerts.length, 1);
  assert.equal(
    audit.postSettlementAlerts[0].alertType,
    "POST_SETTLEMENT_STAT_DISCREPANCY"
  );
  assert.equal(audit.postSettlementAlerts[0].leagueId, "league-settled-onchain");
});
