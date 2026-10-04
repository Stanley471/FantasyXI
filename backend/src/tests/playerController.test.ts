import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getPlayers, getPlayerById } from "../controllers/player.controller.js";
import { prisma } from "../config/db.js";

/**
 * Unit tests for the negative paths of player.controller.ts (issue #33).
 *
 * Acceptance criteria covered:
 *  - 404 when a player id does not resolve to a row
 *  - 400 when the id parameter is not a number
 *  - 500 when the database call fails (the error reaches the error handler)
 *
 * The controller itself is intentionally left untouched: the Prisma delegate is
 * patched per test and restored afterwards, following the pattern already used
 * in ownershipStats.test.ts.
 */

type MockResponse = {
  statusCode: number;
  body: any;
  status(code: number): MockResponse;
  json(payload: any): MockResponse;
};

function createResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function createNext() {
  const calls: any[] = [];
  const next = (err?: any) => {
    calls.push(err);
  };
  return { next, calls };
}

type PlayerDelegateMethod = "findUnique" | "findMany" | "count";

const restoreCallbacks: Array<() => void> = [];

/** Replaces prisma.player methods for the duration of a single test. */
function patchPrismaPlayer(methods: Partial<Record<PlayerDelegateMethod, any>>): void {
  const delegate: any = (prisma as any).player;
  for (const [name, implementation] of Object.entries(methods)) {
    const original = delegate[name];
    delegate[name] = implementation;
    restoreCallbacks.push(() => {
      delegate[name] = original;
    });
  }
}

afterEach(() => {
  while (restoreCallbacks.length > 0) {
    restoreCallbacks.pop()!();
  }
});

describe("getPlayerById", () => {
  it("responds 404 when the player id does not exist", async () => {
    let queriedId: number | undefined;
    patchPrismaPlayer({
      findUnique: async (args: any) => {
        queriedId = args.where.id;
        return null;
      },
    });

    const res = createResponse();
    const { next, calls } = createNext();

    await getPlayerById({ params: { id: "999" }, query: {} } as any, res as any, next as any);

    assert.strictEqual(queriedId, 999);
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, {
      success: false,
      message: "Player with ID 999 not found",
    });
    assert.strictEqual(calls.length, 0, "handled 404 must not reach the error handler");
  });

  it("responds 400 for a non-numeric id without touching the database", async () => {
    let databaseHit = false;
    patchPrismaPlayer({
      findUnique: async () => {
        databaseHit = true;
        return null;
      },
    });

    const res = createResponse();
    const { next, calls } = createNext();

    await getPlayerById({ params: { id: "abc" }, query: {} } as any, res as any, next as any);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { success: false, message: "Invalid player ID" });
    assert.strictEqual(databaseHit, false, "an invalid id must be rejected before querying");
    assert.strictEqual(calls.length, 0);
  });

  it("responds 400 for an empty id", async () => {
    patchPrismaPlayer({ findUnique: async () => null });

    const res = createResponse();
    const { next } = createNext();

    await getPlayerById({ params: { id: "" }, query: {} } as any, res as any, next as any);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.message, "Invalid player ID");
  });

  it("forwards a database failure to the error handler", async () => {
    const failure = new Error("connection terminated unexpectedly");
    patchPrismaPlayer({
      findUnique: async () => {
        throw failure;
      },
    });

    const res = createResponse();
    const { next, calls } = createNext();

    await getPlayerById({ params: { id: "7" }, query: {} } as any, res as any, next as any);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], failure);
    assert.strictEqual(res.body, undefined, "no response body should be written on failure");
  });
});

describe("getPlayers", () => {
  it("forwards a database failure to the error handler", async () => {
    const failure = new Error("connection terminated unexpectedly");
    patchPrismaPlayer({
      findMany: async () => {
        throw failure;
      },
      count: async () => {
        throw failure;
      },
    });

    const res = createResponse();
    const { next, calls } = createNext();

    await getPlayers({ params: {}, query: {} } as any, res as any, next as any);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], failure);
    assert.strictEqual(res.body, undefined);
  });

  it("applies pagination and clamps the limit to 100", async () => {
    let capturedArgs: any = null;
    patchPrismaPlayer({
      findMany: async (args: any) => {
        capturedArgs = args;
        return [];
      },
      count: async () => 120,
    });

    const res = createResponse();
    const { next, calls } = createNext();

    await getPlayers({ params: {}, query: { page: "3", limit: "1000" } } as any, res as any, next as any);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.deepStrictEqual(res.body.pagination, {
      page: 3,
      limit: 100,
      total: 120,
      totalPages: 2,
    });
    assert.strictEqual(capturedArgs.skip, 200);
    assert.strictEqual(capturedArgs.take, 100);
    assert.strictEqual(calls.length, 0);
  });

  it("falls back to the default page when the query parameters are not numbers", async () => {
    let capturedArgs: any = null;
    patchPrismaPlayer({
      findMany: async (args: any) => {
        capturedArgs = args;
        return [];
      },
      count: async () => 0,
    });

    const res = createResponse();
    const { next } = createNext();

    await getPlayers({ params: {}, query: { page: "abc", limit: "-5" } } as any, res as any, next as any);

    assert.strictEqual(res.body.pagination.page, 1);
    assert.strictEqual(capturedArgs.skip, 0);
  });

  it("builds filters from allowed values and ignores unknown ones", async () => {
    let capturedArgs: any = null;
    patchPrismaPlayer({
      findMany: async (args: any) => {
        capturedArgs = args;
        return [];
      },
      count: async () => 0,
    });

    const { next } = createNext();

    await getPlayers(
      {
        params: {},
        query: {
          search: "haaland",
          position: "FWD",
          teamId: "7",
          minPrice: "5.5",
          maxPrice: "15",
          isAvailable: "true",
          sortBy: "price",
          sortOrder: "asc",
        },
      } as any,
      createResponse() as any,
      next as any
    );

    assert.strictEqual(capturedArgs.where.position, "FWD");
    assert.strictEqual(capturedArgs.where.teamId, 7);
    assert.deepStrictEqual(capturedArgs.where.price, { gte: 5.5, lte: 15 });
    assert.strictEqual(capturedArgs.where.isAvailable, true);
    assert.deepStrictEqual(capturedArgs.orderBy, { price: "asc" });
    assert.deepStrictEqual(capturedArgs.where.OR, [
      { displayName: { contains: "haaland", mode: "insensitive" } },
      { firstName: { contains: "haaland", mode: "insensitive" } },
      { lastName: { contains: "haaland", mode: "insensitive" } },
    ]);
  });

  it("drops an unknown position and falls back to the default sort field", async () => {
    let capturedArgs: any = null;
    patchPrismaPlayer({
      findMany: async (args: any) => {
        capturedArgs = args;
        return [];
      },
      count: async () => 0,
    });

    const { next } = createNext();

    await getPlayers(
      { params: {}, query: { position: "GOALKEEPER", sortBy: "password", sortOrder: "sideways" } } as any,
      createResponse() as any,
      next as any
    );

    assert.strictEqual(capturedArgs.where.position, undefined);
    assert.deepStrictEqual(capturedArgs.orderBy, { totalPoints: "desc" });
  });
});
