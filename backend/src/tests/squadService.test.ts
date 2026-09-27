import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { SquadService } from "../services/squad/squadService.js";
import { fplSyncService } from "../services/fpl/fplSyncService.js";
import { syncDailyPlayerPrices } from "../jobs/priceSync.js";
import { prisma } from "../config/db.js";

describe("SquadService selling price and team value", () => {
  it("keeps the selling price equal to the purchase price when it has not moved", () => {
    assert.equal(SquadService.calculateSellingPrice(7.0, 7.0), 7.0);
  });

  it("keeps half the profit (rounded down) when a player's price has risen", () => {
    // Bought at 10.0, now 10.5: profit 0.5 -> half is 0.25, floored to 0.2 -> sell at 10.2
    assert.equal(SquadService.calculateSellingPrice(10.0, 10.5), 10.2);
    // Bought at 5.0, now 5.9: profit 0.9 -> half is 0.45, floored to 0.4 -> sell at 5.4
    assert.equal(SquadService.calculateSellingPrice(5.0, 5.9), 5.4);
  });

  it("takes the full loss when a player's price has dropped", () => {
    assert.equal(SquadService.calculateSellingPrice(8.0, 7.5), 7.5);
    assert.equal(SquadService.calculateSellingPrice(6.5, 6.0), 6.0);
  });

  it("computes team value as bank plus the selling price of every squad player", () => {
    const players = [
      { purchasePrice: 10.0, currentPrice: 10.5 }, // sells at 10.2
      { purchasePrice: 5.0, currentPrice: 4.5 }, // sells at 4.5 (full loss)
      { purchasePrice: 6.0, currentPrice: 6.0 }, // unchanged
    ];

    // squad value = 10.2 + 4.5 + 6.0 = 20.7, bank = 5.3 -> team value = 26.0
    const teamValue = SquadService.calculateTeamValue(5.3, players);
    assert.equal(teamValue, 26.0);
  });

  it("returns the bank untouched when a squad owns no players", () => {
    assert.equal(SquadService.calculateTeamValue(100.0, []), 100.0);
  });
});

describe("SquadService.getSquadValuation", () => {
  function createMockDb(squad: any) {
    return {
      squad: {
        findUnique: async () => squad,
      },
    };
  }

  it("reports bank, squad value and team value using each player's live price", async () => {
    const db = createMockDb({
      id: "squad-1",
      budgetRemaining: 5.3,
      players: [
        { purchasePrice: 10.0, player: { price: 10.5 } },
        { purchasePrice: 5.0, player: { price: 4.5 } },
      ],
    });

    const service = new SquadService(db);
    const valuation = await service.getSquadValuation("squad-1");

    assert.equal(valuation.bank, 5.3);
    assert.equal(valuation.squadValue, 14.7); // 10.2 + 4.5
    assert.equal(valuation.teamValue, 20.0);
  });

  it("throws a validation error when the squad does not exist", async () => {
    const db = createMockDb(null);
    const service = new SquadService(db);

    await assert.rejects(() => service.getSquadValuation("missing"), /not found/);
  });
});

describe("Daily price synchronization job", () => {
  it("syncs FPL prices and reports how many squads currently exist", async () => {
    mock.method(fplSyncService, "syncBootstrap", async () => ({
      teamsCount: 20,
      gameweeksCount: 38,
      playersCount: 7,
    }));

    const originalCount = prisma.squad.count;
    (prisma as any).squad.count = async () => 3;

    try {
      const result = await syncDailyPlayerPrices();
      assert.equal(result.playersUpdated, 7);
      assert.equal(result.squadsAffected, 3);
    } finally {
      mock.restoreAll();
      (prisma as any).squad.count = originalCount;
    }
  });

  it("propagates errors from the underlying FPL sync so the job queue retries", async () => {
    mock.method(fplSyncService, "syncBootstrap", async () => {
      throw new Error("FPL API request failed: [503] Service Unavailable");
    });

    try {
      await assert.rejects(() => syncDailyPlayerPrices(), /503/);
    } finally {
      mock.restoreAll();
    }
  });
});
