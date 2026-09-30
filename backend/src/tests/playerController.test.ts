/**
 * Unit tests for the Player Controller edge cases.
 *
 * Covers the negative / error paths requested in the issue:
 *  - 400: getPlayerById with a non-numeric player ID.
 *  - 404: getPlayerById for an ID that does not exist.
 *  - 500: database failures are forwarded to `next()` and surface as an
 *         HTTP 500 through an Express error middleware.
 *  - Query-parameter sanitisation for getPlayers (invalid filters / paging).
 *
 * Prisma is monkey-patched the same way as `ownershipStats.test.ts` (the
 * client in `config/db.ts` is a lazy Proxy), so no real database connection
 * is required to exercise these paths.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { getPlayers, getPlayerById } from "../controllers/player.controller.js";
import { prisma } from "../config/db.js";

function createMockReqRes(options: {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, any>;
}) {
  let statusCode = 200;
  let jsonResponse: any = null;
  let nextError: any = null;
  let nextCalled = false;

  const req = {
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    headers: {},
  } as unknown as Request;

  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: any) => {
      jsonResponse = payload;
      return res;
    },
  } as unknown as Response;

  const next: NextFunction = (err?: any) => {
    nextCalled = true;
    nextError = err ?? null;
  };

  return {
    req,
    res,
    next,
    getStatusCode: () => statusCode,
    getJsonResponse: () => jsonResponse,
    getNextError: () => nextError,
    wasNextCalled: () => nextCalled,
  };
}

/** Boot a throwaway Express app on an ephemeral port and tear it down after. */
async function withExpressServer<T>(
  app: ReturnType<typeof express>,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

interface PrismaPlayerOriginals {
  findMany: any;
  findUnique: any;
  count: any;
}

// Snapshot the pristine Prisma delegate methods once, then reset them before
// every test so mocked queries never leak between cases.
let prismaPlayerOriginals: PrismaPlayerOriginals | null = null;

function getPrismaPlayerOriginals(): PrismaPlayerOriginals {
  if (!prismaPlayerOriginals) {
    prismaPlayerOriginals = {
      findMany: (prisma as any).player.findMany,
      findUnique: (prisma as any).player.findUnique,
      count: (prisma as any).player.count,
    };
  }
  return prismaPlayerOriginals;
}

describe("Player Controller edge cases", () => {
  beforeEach(() => {
    const originals = getPrismaPlayerOriginals();
    (prisma as any).player.findMany = originals.findMany;
    (prisma as any).player.findUnique = originals.findUnique;
    (prisma as any).player.count = originals.count;
  });

  describe("getPlayerById", () => {
    it("returns 400 when the player ID is not numeric", async () => {
      const { req, res, next, getStatusCode, getJsonResponse, wasNextCalled } =
        createMockReqRes({ params: { id: "abc" } });

      await getPlayerById(req, res, next);

      assert.equal(getStatusCode(), 400);
      assert.equal(getJsonResponse().success, false);
      assert.match(getJsonResponse().message, /Invalid player ID/);
      assert.equal(wasNextCalled(), false);
    });

    it("returns HTTP 400 for a non-numeric id through the Express router", async () => {
      const app = express();
      app.get("/players/:id", getPlayerById);

      await withExpressServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/players/abc`);
        assert.equal(response.status, 400);
        const body: any = await response.json();
        assert.equal(body.success, false);
        assert.match(body.message, /Invalid player ID/);
      });
    });

    it("returns 404 when the player does not exist", async () => {
      const original = (prisma as any).player.findUnique;
      (prisma as any).player.findUnique = async () => null;
      try {
        const { req, res, next, getStatusCode, getJsonResponse, wasNextCalled } =
          createMockReqRes({ params: { id: "7" } });

        await getPlayerById(req, res, next);

        assert.equal(getStatusCode(), 404);
        assert.equal(getJsonResponse().success, false);
        assert.match(getJsonResponse().message, /Player with ID 7 not found/);
        assert.equal(wasNextCalled(), false);
      } finally {
        (prisma as any).player.findUnique = original;
      }
    });

    it("returns the player and 200 on the happy path", async () => {
      const original = (prisma as any).player.findUnique;
      const player = {
        id: 7,
        displayName: "Bukayo Saka",
        position: "MID",
        team: { id: 1, name: "Arsenal" },
        gameweekStats: [],
      };
      (prisma as any).player.findUnique = async () => player;
      try {
        const { req, res, next, getStatusCode, getJsonResponse, wasNextCalled } =
          createMockReqRes({ params: { id: "7" } });

        await getPlayerById(req, res, next);

        assert.equal(getStatusCode(), 200);
        assert.equal(getJsonResponse().success, true);
        assert.deepEqual(getJsonResponse().data, player);
        assert.equal(wasNextCalled(), false);
      } finally {
        (prisma as any).player.findUnique = original;
      }
    });

    it("forwards database errors to next() instead of responding", async () => {
      const original = (prisma as any).player.findUnique;
      const dbError = new Error("db down");
      (prisma as any).player.findUnique = async () => {
        throw dbError;
      };
      try {
        const { req, res, next, getJsonResponse, getNextError, wasNextCalled } =
          createMockReqRes({ params: { id: "7" } });

        await getPlayerById(req, res, next);

        assert.equal(wasNextCalled(), true);
        assert.equal(getNextError(), dbError);
        // No response should have been written before delegating to next().
        assert.equal(getJsonResponse(), null);
      } finally {
        (prisma as any).player.findUnique = original;
      }
    });

    it("surfaces an HTTP 500 through an Express error middleware", async () => {
      const original = (prisma as any).player.findUnique;
      (prisma as any).player.findUnique = async () => {
        throw new Error("db down");
      };

      const app = express();
      app.get("/players/:id", getPlayerById);
      const errorHandler = (
        _err: any,
        _req: Request,
        res: Response,
        _next: NextFunction
      ) => {
        res.status(500).json({ success: false, message: "Internal Server Error" });
      };
      app.use(errorHandler);

      try {
        await withExpressServer(app, async (baseUrl) => {
          const response = await fetch(`${baseUrl}/players/7`);
          assert.equal(response.status, 500);
          const body: any = await response.json();
          assert.equal(body.success, false);
          assert.equal(body.message, "Internal Server Error");
        });
      } finally {
        (prisma as any).player.findUnique = original;
      }
    });
  });

  describe("getPlayers", () => {
    it("returns paginated players and applies query filters", async () => {
      const originalFindMany = (prisma as any).player.findMany;
      const originalCount = (prisma as any).player.count;

      const players = [
        { id: 1, displayName: "Erling Haaland", position: "FWD", price: 15, totalPoints: 120 },
      ];
      let capturedArgs: any = null;
      (prisma as any).player.findMany = async (args: any) => {
        capturedArgs = args;
        return players;
      };
      (prisma as any).player.count = async () => 1;

      try {
        const { req, res, next, getStatusCode, getJsonResponse, wasNextCalled } =
          createMockReqRes({
            query: {
              search: "haaland",
              position: "FWD",
              teamId: "3",
              minPrice: "5.5",
              maxPrice: "15",
              isAvailable: "true",
              sortBy: "price",
              sortOrder: "asc",
              page: "2",
              limit: "10",
            },
          });

        await getPlayers(req, res, next);

        const body = getJsonResponse();
        assert.equal(getStatusCode(), 200);
        assert.equal(body.success, true);
        assert.deepEqual(body.data, players);
        assert.deepEqual(body.pagination, {
          page: 2,
          limit: 10,
          total: 1,
          totalPages: 1,
        });
        assert.equal(wasNextCalled(), false);

        // Prisma where/orderBy/skip/take reflect the sanitised query.
        assert.deepEqual(capturedArgs.where.OR, [
          { displayName: { contains: "haaland", mode: "insensitive" } },
          { firstName: { contains: "haaland", mode: "insensitive" } },
          { lastName: { contains: "haaland", mode: "insensitive" } },
        ]);
        assert.equal(capturedArgs.where.position, "FWD");
        assert.equal(capturedArgs.where.teamId, 3);
        assert.deepEqual(capturedArgs.where.price, { gte: 5.5, lte: 15 });
        assert.equal(capturedArgs.where.isAvailable, true);
        assert.deepEqual(capturedArgs.orderBy, { price: "asc" });
        assert.equal(capturedArgs.skip, 10);
        assert.equal(capturedArgs.take, 10);
      } finally {
        (prisma as any).player.findMany = originalFindMany;
        (prisma as any).player.count = originalCount;
      }
    });

    it("sanitises invalid query parameters instead of erroring", async () => {
      const originalFindMany = (prisma as any).player.findMany;
      const originalCount = (prisma as any).player.count;

      let capturedArgs: any = null;
      (prisma as any).player.findMany = async (args: any) => {
        capturedArgs = args;
        return [];
      };
      (prisma as any).player.count = async () => 0;

      try {
        const { req, res, next, getStatusCode, getJsonResponse, wasNextCalled } =
          createMockReqRes({
            query: {
              position: "NOT_A_POSITION",
              teamId: "not-a-number",
              sortBy: "notAField",
              sortOrder: "sideways",
              page: "abc",
              limit: "-5",
            },
          });

        await getPlayers(req, res, next);

        const body = getJsonResponse();
        assert.equal(getStatusCode(), 200);
        assert.equal(body.success, true);
        // Paging falls back to sane bounds: page 1, smallest valid limit.
        assert.equal(body.pagination.page, 1);
        assert.equal(body.pagination.limit, 1);
        // Unknown filters are dropped and sorting falls back to the default.
        assert.equal("position" in capturedArgs.where, false);
        assert.equal("teamId" in capturedArgs.where, false);
        assert.equal("OR" in capturedArgs.where, false);
        assert.deepEqual(capturedArgs.orderBy, { totalPoints: "desc" });
        assert.equal(capturedArgs.skip, 0);
        assert.equal(capturedArgs.take, 1);
        assert.equal(wasNextCalled(), false);
      } finally {
        (prisma as any).player.findMany = originalFindMany;
        (prisma as any).player.count = originalCount;
      }
    });

    it("forwards database errors to next()", async () => {
      const originalFindMany = (prisma as any).player.findMany;
      const originalCount = (prisma as any).player.count;
      const dbError = new Error("db down");
      (prisma as any).player.findMany = async () => {
        throw dbError;
      };
      // Promise.all() in the controller also kicks off the count query, so it
      // must be mocked too — otherwise it would hit the real database.
      (prisma as any).player.count = async () => {
        throw dbError;
      };

      try {
        const { req, res, next, getNextError, getJsonResponse } = createMockReqRes({
          query: {},
        });

        await getPlayers(req, res, next);

        assert.equal(getNextError(), dbError);
        assert.equal(getJsonResponse(), null);
      } finally {
        (prisma as any).player.findMany = originalFindMany;
        (prisma as any).player.count = originalCount;
      }
    });
  });
});
