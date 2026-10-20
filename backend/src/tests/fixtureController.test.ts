import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import { getFixtures } from "../controllers/fixture.controller.js";
import { prisma } from "../config/db.js";

/**
 * Unit tests for `fixture.controller.ts` (#32).
 *
 * Every error the controller returns itself must use the API-wide
 * `{ success: false, message }` shape with the right status code, and
 * unexpected failures must still be forwarded to the global error handler.
 * The `prisma.fixture.findMany` delegate is stubbed; no database is needed.
 */

function createMockReqRes(query: Record<string, unknown> = {}) {
  let statusCode = 200;
  let jsonResponse: any = null;
  let nextError: any = null;
  let nextCalled = false;

  const req = { query } as unknown as Request;
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

const originalFindMany = (prisma as any).fixture.findMany;
let findManyCalls: any[] = [];

function stubFindMany(impl: (args: any) => any) {
  findManyCalls = [];
  (prisma as any).fixture.findMany = async (args: any) => {
    findManyCalls.push(args);
    return impl(args);
  };
}

describe("Fixture Controller", () => {
  afterEach(() => {
    (prisma as any).fixture.findMany = originalFindMany;
  });

  describe("getFixtures: invalid query parameters", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["non-numeric gameweekId", { gameweekId: "abc" }, "gameweekId must be a positive integer"],
      ["partially numeric gameweekId", { gameweekId: "12abc" }, "gameweekId must be a positive integer"],
      ["zero gameweekId", { gameweekId: "0" }, "gameweekId must be a positive integer"],
      ["negative gameweekId", { gameweekId: "-3" }, "gameweekId must be a positive integer"],
      ["empty gameweekId", { gameweekId: "" }, "gameweekId must be a positive integer"],
      ["repeated gameweekId", { gameweekId: ["1", "2"] }, "gameweekId must be a positive integer"],
      ["non-numeric teamId", { teamId: "arsenal" }, "teamId must be a positive integer"],
      ["decimal teamId", { teamId: "1.5" }, "teamId must be a positive integer"],
      ["invalid upcoming flag", { upcoming: "yes" }, 'upcoming must be "true" or "false"'],
    ];

    for (const [label, query, message] of cases) {
      it(`rejects ${label} with a standard 400 error`, async () => {
        stubFindMany(() => []);
        const { req, res, next, getStatusCode, getJsonResponse, wasNextCalled } =
          createMockReqRes(query);

        await getFixtures(req, res, next);

        assert.equal(getStatusCode(), 400);
        assert.deepEqual(getJsonResponse(), { success: false, message });
        assert.equal(wasNextCalled(), false);
        assert.equal(findManyCalls.length, 0, "must not query with an ignored filter");
      });
    }
  });

  describe("getFixtures: valid query parameters", () => {
    it("returns fixtures in the standard success shape", async () => {
      const rows = [{ id: 1, gameweekId: 5 }];
      stubFindMany(() => rows);
      const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes();

      await getFixtures(req, res, next);

      assert.equal(getStatusCode(), 200);
      assert.deepEqual(getJsonResponse(), { success: true, data: rows });
      assert.deepEqual(findManyCalls[0].where, {});
    });

    it("applies gameweek, team and upcoming filters", async () => {
      stubFindMany(() => []);
      const { req, res, next, getStatusCode } = createMockReqRes({
        gameweekId: "7",
        teamId: "14",
        upcoming: "true",
      });

      await getFixtures(req, res, next);

      assert.equal(getStatusCode(), 200);
      assert.deepEqual(findManyCalls[0].where, {
        gameweekId: 7,
        OR: [{ homeTeamId: 14 }, { awayTeamId: 14 }],
        finished: false,
      });
    });

    it("treats upcoming=false as no finished filter", async () => {
      stubFindMany(() => []);
      const { req, res, next, getStatusCode } = createMockReqRes({ upcoming: "false" });

      await getFixtures(req, res, next);

      assert.equal(getStatusCode(), 200);
      assert.deepEqual(findManyCalls[0].where, {});
    });
  });

  describe("getFixtures: unexpected failures", () => {
    it("forwards database errors to the global error handler", async () => {
      const failure = new Error("connection lost");
      stubFindMany(() => {
        throw failure;
      });
      const { req, res, next, getNextError, getJsonResponse } = createMockReqRes();

      await getFixtures(req, res, next);

      assert.equal(getNextError(), failure);
      assert.equal(getJsonResponse(), null);
    });
  });
});
