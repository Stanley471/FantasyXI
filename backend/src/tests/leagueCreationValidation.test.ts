import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import { createLeague } from "../controllers/league.controller.js";
import {
  LEAGUE_NAME_MAX_LENGTH,
  LEAGUE_DESCRIPTION_MAX_LENGTH,
} from "../services/league/leagueService.js";
import { prisma } from "../config/db.js";

/**
 * League creation length limits (#31).
 *
 * Names over LEAGUE_NAME_MAX_LENGTH and descriptions over
 * LEAGUE_DESCRIPTION_MAX_LENGTH must be rejected with a standard 400 before
 * anything touches the database. Inputs at the limit must pass validation:
 * `prisma.user.findUnique` is stubbed to return no user, so reaching the
 * "not found" check proves the length checks were passed.
 */

function createMockReqRes(body: Record<string, unknown>) {
  let statusCode = 200;
  let jsonResponse: any = null;
  let nextError: any = null;

  const req = {
    user: { id: "creator-1", email: "c@example.com", username: "creator", role: "USER" },
    body,
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
    nextError = err;
  };

  return {
    req,
    res,
    next,
    getStatusCode: () => statusCode,
    getJsonResponse: () => jsonResponse,
    getNextError: () => nextError,
  };
}

const baseInput = {
  name: "Weekend Warriors",
  entryFee: 0,
  startGameweekId: 1,
  endGameweekId: 2,
  squadId: "squad-1",
};

const originalFindUnique = (prisma as any).user.findUnique;
let userLookups = 0;

function stubUserLookup() {
  userLookups = 0;
  (prisma as any).user.findUnique = async () => {
    userLookups++;
    return null;
  };
}

async function submit(body: Record<string, unknown>) {
  stubUserLookup();
  const harness = createMockReqRes(body);
  await createLeague(harness.req, harness.res, harness.next);
  return harness;
}

describe("League creation input length limits", () => {
  afterEach(() => {
    (prisma as any).user.findUnique = originalFindUnique;
  });

  it("uses the documented limits", () => {
    assert.equal(LEAGUE_NAME_MAX_LENGTH, 50);
    assert.equal(LEAGUE_DESCRIPTION_MAX_LENGTH, 200);
  });

  it("rejects a name over the limit with 400", async () => {
    const { getStatusCode, getJsonResponse, getNextError } = await submit({
      ...baseInput,
      name: "x".repeat(LEAGUE_NAME_MAX_LENGTH + 1),
    });

    assert.equal(getStatusCode(), 400);
    assert.deepEqual(getJsonResponse(), {
      success: false,
      message: `League name must not exceed ${LEAGUE_NAME_MAX_LENGTH} characters`,
    });
    assert.equal(getNextError(), null);
    assert.equal(userLookups, 0, "must reject before touching the database");
  });

  it("rejects a description over the limit with 400", async () => {
    const { getStatusCode, getJsonResponse } = await submit({
      ...baseInput,
      description: "d".repeat(LEAGUE_DESCRIPTION_MAX_LENGTH + 1),
    });

    assert.equal(getStatusCode(), 400);
    assert.deepEqual(getJsonResponse(), {
      success: false,
      message: `League description must not exceed ${LEAGUE_DESCRIPTION_MAX_LENGTH} characters`,
    });
    assert.equal(userLookups, 0);
  });

  it("rejects a non-string description with 400 instead of crashing", async () => {
    const { getStatusCode, getJsonResponse, getNextError } = await submit({
      ...baseInput,
      description: { text: "nested" },
    });

    assert.equal(getStatusCode(), 400);
    assert.equal(getJsonResponse().message, "League description must be a string");
    assert.equal(getNextError(), null);
  });

  it("rejects a non-string name with 400 instead of crashing", async () => {
    const { getStatusCode, getJsonResponse, getNextError } = await submit({
      ...baseInput,
      name: 12345,
    });

    assert.equal(getStatusCode(), 400);
    assert.equal(getJsonResponse().message, "League name is required");
    assert.equal(getNextError(), null);
  });

  it("measures length after trimming surrounding whitespace", async () => {
    const { getJsonResponse } = await submit({
      ...baseInput,
      name: `   ${"x".repeat(LEAGUE_NAME_MAX_LENGTH)}   `,
      description: `  ${"d".repeat(LEAGUE_DESCRIPTION_MAX_LENGTH)}  `,
    });

    assert.equal(userLookups, 1, "trimmed input at the limit passes the length checks");
    assert.match(getJsonResponse().message, /User with ID creator-1 not found/);
  });

  it("accepts a name and description exactly at the limits", async () => {
    const { getJsonResponse } = await submit({
      ...baseInput,
      name: "x".repeat(LEAGUE_NAME_MAX_LENGTH),
      description: "d".repeat(LEAGUE_DESCRIPTION_MAX_LENGTH),
    });

    assert.equal(userLookups, 1);
    assert.match(getJsonResponse().message, /not found/);
  });

  it("accepts a league without a description", async () => {
    const { getJsonResponse } = await submit({ ...baseInput, description: undefined });

    assert.equal(userLookups, 1);
    assert.match(getJsonResponse().message, /not found/);
  });
});
