import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../config/db.js";
import { batchPlayerStats } from "../controllers/player.controller.js";

function createResponse() {
  const response: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
  };
  return response;
}

const restoreCallbacks: Array<() => void> = [];

function patchFindMany(implementation: (args: any) => Promise<any[]>): void {
  const delegate: any = (prisma as any).playerGameweekStats;
  const original = delegate.findMany;
  delegate.findMany = implementation;
  restoreCallbacks.push(() => {
    delegate.findMany = original;
  });
}

afterEach(() => {
  while (restoreCallbacks.length > 0) restoreCallbacks.pop()!();
});

describe("POST /players/batch-stats", () => {
  it("returns matching stats and an indexed map from one database query", async () => {
    const rows = [
      { playerId: 4, gameweekId: 9, points: 12 },
      { playerId: 7, gameweekId: 9, points: 5 },
    ];
    let queryCount = 0;
    let query: any;
    patchFindMany(async (args) => {
      queryCount += 1;
      query = args;
      return rows;
    });

    const res = createResponse();
    const next = (error?: unknown) => assert.fail(`unexpected error: ${String(error)}`);
    await batchPlayerStats(
      { body: { playerIds: [4, 7, 99], gameweekId: 9 } } as any,
      res,
      next as any
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(query, { where: { playerId: { in: [4, 7, 99] }, gameweekId: 9 } });
    assert.equal(queryCount, 1);
    assert.deepEqual(res.body.data, rows);
    assert.deepEqual(res.body.byPlayerId, { 4: rows[0], 7: rows[1] });
    assert.equal("99" in res.body.byPlayerId, false);
  });

  it("rejects more than 50 IDs before querying", async () => {
    let queried = false;
    patchFindMany(async () => {
      queried = true;
      return [];
    });

    const res = createResponse();
    await batchPlayerStats(
      { body: { playerIds: Array.from({ length: 51 }, (_, index) => index + 1), gameweekId: 9 } } as any,
      res,
      (() => assert.fail("invalid requests should not reach the error handler")) as any
    );

    assert.equal(res.statusCode, 400);
    assert.equal(queried, false);
  });
});
