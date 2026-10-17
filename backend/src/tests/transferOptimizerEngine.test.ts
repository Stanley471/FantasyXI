import test from "node:test";
import assert from "node:assert/strict";
import { Position } from "../types/index.js";
import {
  TransferOptimizerEngine,
  OptimizableSquadPlayer,
  MarketCandidatePlayer,
} from "../services/fpl/transferOptimizerEngine.js";

test("TransferOptimizerEngine.calculateSellingPrice: enforces FPL 50% sell-on profit rule", () => {
  // Bought at 100 (10.0m), rose to 105 (10.5m) -> profit 5, keep floor(5/2)=2 -> sell at 102 (10.2m)
  assert.equal(TransferOptimizerEngine.calculateSellingPrice(100, 105), 102);

  // Bought at 80 (8.0m), dropped to 77 (7.7m) -> full loss absorbed -> sell at 77
  assert.equal(TransferOptimizerEngine.calculateSellingPrice(80, 77), 77);

  // Decimal format: bought at 7.5, rose to 7.9 -> profit 0.4, keep 0.2 -> sell at 7.7
  assert.equal(TransferOptimizerEngine.calculateSellingPrice(7.5, 7.9), 7.7);
});

test("TransferOptimizerEngine: optimizes multi-gameweek transfer plan respecting budget, club cap, and FT rollover", () => {
  const engine = new TransferOptimizerEngine();

  // Build a 15-man squad (2 GKP, 5 DEF, 5 MID, 3 FWD)
  const initialSquad: OptimizableSquadPlayer[] = [
    { playerId: 1, name: "GKP1", teamId: 1, position: Position.GKP, purchasePrice: 50, currentPrice: 50 },
    { playerId: 2, name: "GKP2", teamId: 2, position: Position.GKP, purchasePrice: 40, currentPrice: 40 },
    { playerId: 3, name: "DEF1", teamId: 1, position: Position.DEF, purchasePrice: 60, currentPrice: 60 },
    { playerId: 4, name: "DEF2", teamId: 2, position: Position.DEF, purchasePrice: 55, currentPrice: 55 },
    { playerId: 5, name: "DEF3", teamId: 3, position: Position.DEF, purchasePrice: 50, currentPrice: 50 },
    { playerId: 6, name: "DEF4", teamId: 4, position: Position.DEF, purchasePrice: 45, currentPrice: 45 },
    { playerId: 7, name: "DEF5", teamId: 5, position: Position.DEF, purchasePrice: 40, currentPrice: 40 },
    { playerId: 8, name: "MID1", teamId: 1, position: Position.MID, purchasePrice: 90, currentPrice: 90 },
    { playerId: 9, name: "MID2", teamId: 6, position: Position.MID, purchasePrice: 75, currentPrice: 75 },
    { playerId: 10, name: "MID3", teamId: 7, position: Position.MID, purchasePrice: 65, currentPrice: 65 },
    { playerId: 11, name: "MID4", teamId: 8, position: Position.MID, purchasePrice: 55, currentPrice: 55 },
    { playerId: 12, name: "MID5", teamId: 9, position: Position.MID, purchasePrice: 50, currentPrice: 50 },
    { playerId: 13, name: "FWD1", teamId: 10, position: Position.FWD, purchasePrice: 110, currentPrice: 110 },
    { playerId: 14, name: "FWD2", teamId: 11, position: Position.FWD, purchasePrice: 75, currentPrice: 75 },
    { playerId: 15, name: "FWD3", teamId: 12, position: Position.FWD, purchasePrice: 60, currentPrice: 60 },
  ];

  const market: MarketCandidatePlayer[] = [
    ...initialSquad.map((s) => ({
      playerId: s.playerId,
      name: s.name,
      teamId: s.teamId,
      position: s.position,
      currentPrice: s.currentPrice,
      expectedPointsByGw: { 10: 4.5, 11: 4.5, 12: 4.5 },
    })),
    {
      playerId: 101,
      name: "ClubCapLockedStar",
      teamId: 1, // Already 3 players on Team 1
      position: Position.FWD,
      currentPrice: 110,
      expectedPointsByGw: { 10: 7.0, 11: 7.0, 12: 7.0 },
    },
    {
      playerId: 102,
      name: "DGWMidfielder",
      teamId: 15,
      position: Position.MID,
      currentPrice: 75,
      expectedPointsByGw: { 10: 9.5, 11: 14.0, 12: 12.0 },
    },
    {
      playerId: 103,
      name: "StarForward",
      teamId: 16,
      position: Position.FWD,
      currentPrice: 80,
      expectedPointsByGw: { 10: 8.0, 11: 10.5, 12: 10.5 },
    },
  ];

  const plan = engine.optimizeTransferPlan(initialSquad, market, {
    horizonGameweeks: [10, 11, 12],
    initialFreeTransfers: 1,
    initialBank: 5, // 0.5m in bank (allows upgrading 75 -> 80)
  });

  assert.equal(plan.steps.length, 3);
  assert.ok(plan.finalBank >= 0, "Remaining bank must never be negative");

  // Verify no step ever violates the 3-players-per-club constraint across the squad
  const currentTeamByPlayer = new Map<number, number>(
    market.map((m) => [m.playerId, m.teamId])
  );
  let activeSquadIds = initialSquad.map((s) => s.playerId);

  for (const step of plan.steps) {
    assert.equal(step.startingPlayerIds.length, 11);
    for (const move of step.transfersMade) {
      activeSquadIds = activeSquadIds.map((id) =>
        id === move.playerOutId ? move.playerInId : id
      );
    }
    const countsByTeam = new Map<number, number>();
    for (const pid of activeSquadIds) {
      const tid = currentTeamByPlayer.get(pid)!;
      const nextCount = (countsByTeam.get(tid) ?? 0) + 1;
      assert.ok(nextCount <= 3, `Club ${tid} exceeded 3 players (${nextCount})`);
      countsByTeam.set(tid, nextCount);
    }
  }

  // Verify DGWMidfielder (102) was brought in and captained in GW 11
  const gw11Step = plan.steps.find((s) => s.gameweekId === 11)!;
  assert.ok(gw11Step.startingPlayerIds.includes(102));
  assert.equal(gw11Step.captainPlayerId, 102);

  // Verify plan caching
  assert.equal(engine.getCacheSize(), 1);
  const cachedPlan = engine.optimizeTransferPlan(initialSquad, market, {
    horizonGameweeks: [10, 11, 12],
    initialFreeTransfers: 1,
    initialBank: 5,
  });
  assert.equal(cachedPlan.planHash, plan.planHash);
});
