import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import {
  getGameweeks,
  getCurrentGameweek,
  getGameweekById,
} from "../controllers/gameweek.controller.js";
import { prisma } from "../config/db.js";

/**
 * Unit tests for `gameweek.controller.ts` (#34).
 *
 * The controller was previously covered only indirectly: the endpoints were
 * exercised by the FPL sync and scoring suites, so a regression in its own
 * response shaping or error forwarding would not have failed anything.
 *
 * Every test replaces the relevant `prisma` delegate with a stub and restores
 * it afterwards, matching the pattern in `ownershipStats.test.ts` and
 * `referralService.test.ts`. No database connection is required.
 */

/** Minimal Express harness: records status, body and any forwarded error. */
function createMockReqRes(options: { params?: Record<string, string> } = {}) {
  let statusCode = 200;
  let jsonResponse: any = null;
  let nextError: any = null;
  let nextCalled = false;

  const req = {
    params: options.params ?? {},
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
    nextError = err;
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

/**
 * Swap a prisma delegate method for a stub and hand back a restore function.
 * `hooks` is reset before each test below so a leaked stub cannot make a later
 * test pass for the wrong reason.
 */
function stubPrisma(path: string, impl: (...args: any[]) => any) {
  const parts = path.split(".");
  const delegate = parts[0];
  const method = parts[1];

  const target = (prisma as any)[delegate];
  const original = target[method];
  target[method] = impl;

  return () => {
    target[method] = original;
  };
}

describe("Gameweek Controller", () => {
  describe("getGameweeks", () => {
    it("returns every gameweek ordered by fplId", async () => {
      const rows = [
        { id: 1, fplId: 1, name: "Gameweek 1", isCurrent: false, isFinished: true },
        { id: 2, fplId: 2, name: "Gameweek 2", isCurrent: true, isFinished: false },
      ];
      let receivedArgs: any = null;
      const restore = stubPrisma("gameweek.findMany", async (args: any) => {
        receivedArgs = args;
        return rows;
      });

      try {
        const { req, res, next, getJsonResponse, wasNextCalled } = createMockReqRes();
        await getGameweeks(req, res, next);

        assert.equal(wasNextCalled(), false, "should not forward an error");
        assert.deepEqual(getJsonResponse(), { success: true, data: rows });
        assert.deepEqual(receivedArgs, { orderBy: { fplId: "asc" } });
      } finally {
        restore();
      }
    });

    it("returns an empty list without erroring when there are no gameweeks", async () => {
      const restore = stubPrisma("gameweek.findMany", async () => []);

      try {
        const { req, res, next, getJsonResponse } = createMockReqRes();
        await getGameweeks(req, res, next);

        assert.deepEqual(getJsonResponse(), { success: true, data: [] });
      } finally {
        restore();
      }
    });

    it("forwards a database failure to the error handler", async () => {
      const failure = new Error("connection refused");
      const restore = stubPrisma("gameweek.findMany", async () => {
        throw failure;
      });

      try {
        const { req, res, next, getNextError, wasNextCalled } = createMockReqRes();
        await getGameweeks(req, res, next);

        assert.equal(wasNextCalled(), true);
        assert.equal(getNextError(), failure);
      } finally {
        restore();
      }
    });
  });

  describe("getCurrentGameweek", () => {
    it("returns the gameweek flagged as current, with fixtures and teams", async () => {
      const current = {
        id: 2,
        fplId: 2,
        name: "Gameweek 2",
        isCurrent: true,
        isFinished: false,
        fixtures: [
          {
            id: 10,
            kickoffTime: "2026-09-26T14:00:00.000Z",
            homeTeam: { id: 1, name: "Arsenal", shortName: "ARS" },
            awayTeam: { id: 2, name: "Chelsea", shortName: "CHE" },
          },
        ],
      };
      // findFirst is called once for the current gameweek here.
      const restore = stubPrisma("gameweek.findFirst", async () => current);

      try {
        const { req, res, next, getJsonResponse, wasNextCalled } = createMockReqRes();
        await getCurrentGameweek(req, res, next);

        assert.equal(wasNextCalled(), false);
        assert.deepEqual(getJsonResponse(), { success: true, data: current });
      } finally {
        restore();
      }
    });

    it("falls back to the next upcoming gameweek when none is marked current", async () => {
      const upcoming = {
        id: 3,
        fplId: 3,
        name: "Gameweek 3",
        isCurrent: false,
        isFinished: false,
        fixtures: [],
      };
      // First call (isCurrent: true) misses; second (upcoming by deadline) hits.
      let call = 0;
      const restore = stubPrisma("gameweek.findFirst", async (args: any) => {
        call += 1;
        if (call === 1) {
          assert.deepEqual(args.where, { isCurrent: true });
          return null;
        }
        assert.deepEqual(args.where, { isFinished: false });
        assert.deepEqual(args.orderBy, { deadline: "asc" });
        return upcoming;
      });

      try {
        const { req, res, next, getJsonResponse, wasNextCalled } = createMockReqRes();
        await getCurrentGameweek(req, res, next);

        assert.equal(wasNextCalled(), false);
        assert.deepEqual(getJsonResponse(), { success: true, data: upcoming });
        assert.equal(call, 2, "should query twice: current, then upcoming");
      } finally {
        restore();
      }
    });

    it("returns null when neither a current nor an upcoming gameweek exists", async () => {
      const restore = stubPrisma("gameweek.findFirst", async () => null);

      try {
        const { req, res, next, getJsonResponse, wasNextCalled } = createMockReqRes();
        await getCurrentGameweek(req, res, next);

        assert.equal(wasNextCalled(), false);
        // The contract is a 200 with a null payload, not a 404: callers use
        // this endpoint to render "no gameweek scheduled yet".
        assert.deepEqual(getJsonResponse(), { success: true, data: null });
      } finally {
        restore();
      }
    });

    it("forwards a database failure to the error handler", async () => {
      const failure = new Error("query timeout");
      const restore = stubPrisma("gameweek.findFirst", async () => {
        throw failure;
      });

      try {
        const { req, res, next, getNextError, wasNextCalled } = createMockReqRes();
        await getCurrentGameweek(req, res, next);

        assert.equal(wasNextCalled(), true);
        assert.equal(getNextError(), failure);
      } finally {
        restore();
      }
    });
  });

  describe("getGameweekById", () => {
    it("returns the matching gameweek with fixtures and teams", async () => {
      const gameweek = {
        id: 5,
        fplId: 5,
        name: "Gameweek 5",
        isCurrent: false,
        isFinished: false,
        fixtures: [
          {
            id: 50,
            homeTeam: { id: 3, name: "Spurs", shortName: "TOT" },
            awayTeam: { id: 4, name: "Everton", shortName: "EVE" },
          },
        ],
      };
      let receivedArgs: any = null;
      const restore = stubPrisma("gameweek.findUnique", async (args: any) => {
        receivedArgs = args;
        return gameweek;
      });

      try {
        const { req, res, next, getJsonResponse, wasNextCalled } = createMockReqRes({
          params: { id: "5" },
        });
        await getGameweekById(req, res, next);

        assert.equal(wasNextCalled(), false);
        assert.deepEqual(getJsonResponse(), { success: true, data: gameweek });
        assert.equal(receivedArgs.where.id, 5, "should parse the id to a number");
      } finally {
        restore();
      }
    });

    it("rejects a non-numeric id with 400 before querying the database", async () => {
      let queried = false;
      const restore = stubPrisma("gameweek.findUnique", async () => {
        queried = true;
        return null;
      });

      try {
        const { req, res, next, getStatusCode, getJsonResponse, wasNextCalled } =
          createMockReqRes({ params: { id: "not-a-number" } });
        await getGameweekById(req, res, next);

        assert.equal(getStatusCode(), 400);
        assert.deepEqual(getJsonResponse(), {
          success: false,
          message: "Invalid gameweek ID",
        });
        assert.equal(queried, false, "should not reach the database");
        assert.equal(wasNextCalled(), false, "a 400 is not forwarded as an error");
      } finally {
        restore();
      }
    });

    it("rejects an empty id with 400", async () => {
      const restore = stubPrisma("gameweek.findUnique", async () => null);

      try {
        const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
          params: { id: "" },
        });
        await getGameweekById(req, res, next);

        assert.equal(getStatusCode(), 400);
        assert.deepEqual(getJsonResponse(), {
          success: false,
          message: "Invalid gameweek ID",
        });
      } finally {
        restore();
      }
    });

    it("returns 404 when the gameweek does not exist", async () => {
      const restore = stubPrisma("gameweek.findUnique", async () => null);

      try {
        const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
          params: { id: "99999" },
        });
        await getGameweekById(req, res, next);

        assert.equal(getStatusCode(), 404);
        assert.deepEqual(getJsonResponse(), {
          success: false,
          message: "Gameweek with ID 99999 not found",
        });
      } finally {
        restore();
      }
    });

    it("forwards a database failure to the error handler", async () => {
      const failure = new Error("deadlock detected");
      const restore = stubPrisma("gameweek.findUnique", async () => {
        throw failure;
      });

      try {
        const { req, res, next, getNextError, wasNextCalled } = createMockReqRes({
          params: { id: "7" },
        });
        await getGameweekById(req, res, next);

        assert.equal(wasNextCalled(), true);
        assert.equal(getNextError(), failure);
      } finally {
        restore();
      }
    });
  });
});
