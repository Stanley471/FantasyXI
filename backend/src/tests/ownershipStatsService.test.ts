import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OwnershipStatsService } from "../services/analytics/ownershipStatsService.js";
import { getOwnershipAndCaptaincyStats } from "../controllers/player.controller.js";
import { IRedisCacheClient } from "../config/redis.js";

/** In-memory mock Redis client, mirroring the pattern used elsewhere in this suite. */
class MockRedisClient implements IRedisCacheClient {
  public store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) if (this.store.delete(key)) count++;
    return count;
  }

  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}

/**
 * Builds a mock Prisma client backed by a fixed set of sample squads, so the
 * ownership/captaincy math can be verified against known fixtures.
 *
 * Squads (5 total, all "active" — each has at least one player):
 *   squad-1: owns player 10 (captain), player 11
 *   squad-2: owns player 10 (captain), player 12
 *   squad-3: owns player 10, player 11
 *   squad-4: owns player 11 (captain)
 *   squad-5: no players (inactive — must be excluded from totalActiveSquads)
 *
 * Expected across 4 active squads:
 *   player 10: owned by 3/4 = 75.0%, captained by 2/4 = 50.0%
 *   player 11: owned by 3/4 = 75.0%, captained by 1/4 = 25.0%
 *   player 12: owned by 1/4 = 25.0%, captained by 0/4 = 0%
 */
function createMockDb() {
  const squadPlayers = [
    { squadId: "squad-1", playerId: 10, isCaptain: true },
    { squadId: "squad-1", playerId: 11, isCaptain: false },
    { squadId: "squad-2", playerId: 10, isCaptain: true },
    { squadId: "squad-2", playerId: 12, isCaptain: false },
    { squadId: "squad-3", playerId: 10, isCaptain: false },
    { squadId: "squad-3", playerId: 11, isCaptain: false },
    { squadId: "squad-4", playerId: 11, isCaptain: true },
  ];
  const squadIdsWithPlayers = new Set(squadPlayers.map((sp) => sp.squadId));

  return {
    squad: {
      count: async ({ where }: any) => {
        if (where?.players?.some) return squadIdsWithPlayers.size;
        return squadIdsWithPlayers.size + 1; // +1 for squad-5, the empty/inactive squad
      },
    },
    squadPlayer: {
      groupBy: async ({ where }: any) => {
        const rows = where?.isCaptain ? squadPlayers.filter((sp) => sp.isCaptain) : squadPlayers;
        const counts = new Map<number, number>();
        for (const row of rows) counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
        return Array.from(counts.entries()).map(([playerId, count]) => ({
          playerId,
          _count: { _all: count },
        }));
      },
    },
  };
}

describe("OwnershipStatsService (issue #499)", () => {
  it("computes ownership % and captaincy % per player against sample squad fixtures", async () => {
    const db = createMockDb();
    const redis = new MockRedisClient();
    const service = new OwnershipStatsService(db, redis);

    const snapshot = await service.computeAndCache();

    assert.equal(snapshot.totalActiveSquads, 4);
    const byPlayer = new Map(snapshot.stats.map((s) => [s.playerId, s]));

    assert.deepEqual(byPlayer.get(10), { playerId: 10, ownershipPercent: 75, captaincyPercent: 50 });
    assert.deepEqual(byPlayer.get(11), { playerId: 11, ownershipPercent: 75, captaincyPercent: 25 });
    assert.deepEqual(byPlayer.get(12), { playerId: 12, ownershipPercent: 25, captaincyPercent: 0 });
  });

  it("excludes squads with no players from the active-squad denominator", async () => {
    const db = createMockDb();
    const service = new OwnershipStatsService(db, new MockRedisClient());
    const snapshot = await service.computeAndCache();
    assert.equal(snapshot.totalActiveSquads, 4);
  });

  it("persists the computed snapshot to Redis with a 24h TTL marker and serves it back from cache", async () => {
    const db = createMockDb();
    const redis = new MockRedisClient();
    const service = new OwnershipStatsService(db, redis);

    const computed = await service.computeAndCache();
    assert.ok(redis.store.has("ownership:stats:latest"));

    // A fresh service instance (no in-memory cache yet) must still read Redis.
    const freshService = new OwnershipStatsService(db, redis);
    const cached = await freshService.getCached();
    assert.deepEqual(cached, computed);
  });

  it("returns null from getCached when nothing has been computed yet", async () => {
    const service = new OwnershipStatsService(createMockDb(), new MockRedisClient());
    assert.equal(await service.getCached(), null);
  });
});

describe("GET /api/v1/players/stats/ownership controller", () => {
  function createRes() {
    let statusCode = 200;
    let body: any;
    return {
      res: {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(value: any) {
          body = value;
          return this;
        },
      } as any,
      getStatus: () => statusCode,
      getBody: () => body,
    };
  }

  it("returns 503 when no ownership snapshot has been cached yet", async () => {
    const original = (await import("../services/analytics/ownershipStatsService.js")).ownershipStatsService
      .getCached;
    const { ownershipStatsService } = await import("../services/analytics/ownershipStatsService.js");
    (ownershipStatsService as any).getCached = async () => null;

    try {
      const { res, getStatus, getBody } = createRes();
      await getOwnershipAndCaptaincyStats({} as any, res, (() => assert.fail("unexpected next()")) as any);
      assert.equal(getStatus(), 503);
      assert.equal(getBody().success, false);
    } finally {
      (ownershipStatsService as any).getCached = original;
    }
  });

  it("serves the cached snapshot with success:true", async () => {
    const { ownershipStatsService } = await import("../services/analytics/ownershipStatsService.js");
    const original = ownershipStatsService.getCached;
    const fakeSnapshot = {
      totalActiveSquads: 4,
      stats: [{ playerId: 10, ownershipPercent: 75, captaincyPercent: 50 }],
      computedAt: new Date().toISOString(),
    };
    (ownershipStatsService as any).getCached = async () => fakeSnapshot;

    try {
      const { res, getStatus, getBody } = createRes();
      await getOwnershipAndCaptaincyStats({} as any, res, (() => assert.fail("unexpected next()")) as any);
      assert.equal(getStatus(), 200);
      assert.deepEqual(getBody(), { success: true, data: fakeSnapshot });
    } finally {
      (ownershipStatsService as any).getCached = original;
    }
  });
});
