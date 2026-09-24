import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getPlayerOwnershipStats, clearOwnershipStatsCache } from "../controllers/player.controller.js";
import { prisma } from "../config/db.js";

describe("Player Ownership & Point Efficiency Analytics Service", () => {
  beforeEach(() => {
    clearOwnershipStatsCache();
  });

  it("should return ownership stats structure with top 20 and scatter plot data", async () => {
    // Mock prisma queries if database connection is unavailable
    const originalCount = prisma.squad.count;
    const originalFindMany = prisma.player.findMany;

    (prisma as any).squad.count = async () => 10;
    (prisma as any).player.findMany = async () => [
      {
        id: 1,
        displayName: "Erling Haaland",
        position: "FWD",
        price: 15.0,
        totalPoints: 120,
        selectedByPercent: 80.0,
        team: { name: "Man City", shortName: "MCI" },
        _count: { squadPlayers: 8 },
      },
      {
        id: 2,
        displayName: "Mohamed Salah",
        position: "MID",
        price: 12.5,
        totalPoints: 115,
        selectedByPercent: 60.0,
        team: { name: "Liverpool", shortName: "LIV" },
        _count: { squadPlayers: 6 },
      },
    ];

    try {
      const req: any = {};
      let responseData: any = null;

      const res: any = {
        json: (data: any) => {
          responseData = data;
        },
      };
      const next = (err: any) => {
        if (err) throw err;
      };

      await getPlayerOwnershipStats(req, res, next);

      assert.strictEqual(responseData.success, true);
      assert.strictEqual(responseData.cached, false);
      assert.strictEqual(responseData.data.totalSquads, 10);
      assert.strictEqual(responseData.data.topOwned.length, 2);
      assert.strictEqual(responseData.data.topOwned[0].displayName, "Erling Haaland");
      assert.strictEqual(responseData.data.topOwned[0].selectedByPercent, 80.0);
      assert.strictEqual(responseData.data.topOwned[0].ppm, 8.0); // 120 / 15.0
    } finally {
      (prisma as any).squad.count = originalCount;
      (prisma as any).player.findMany = originalFindMany;
    }
  });

  it("should return cached response on immediate second call", async () => {
    const originalCount = prisma.squad.count;
    const originalFindMany = prisma.player.findMany;

    (prisma as any).squad.count = async () => 5;
    (prisma as any).player.findMany = async () => [
      {
        id: 1,
        displayName: "Bukayo Saka",
        position: "MID",
        price: 10.0,
        totalPoints: 90,
        selectedByPercent: 40.0,
        team: { name: "Arsenal", shortName: "ARS" },
        _count: { squadPlayers: 2 },
      },
    ];

    try {
      const req: any = {};
      let res1Data: any = null;
      let res2Data: any = null;

      const res1: any = { json: (d: any) => { res1Data = d; } };
      const res2: any = { json: (d: any) => { res2Data = d; } };
      const next = (err: any) => { if (err) throw err; };

      await getPlayerOwnershipStats(req, res1, next);
      await getPlayerOwnershipStats(req, res2, next);

      assert.strictEqual(res1Data.cached, false);
      assert.strictEqual(res2Data.cached, true);
      assert.deepStrictEqual(res1Data.data, res2Data.data);
    } finally {
      (prisma as any).squad.count = originalCount;
      (prisma as any).player.findMany = originalFindMany;
    }
  });
});
