import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import {
  fileDisputeHandler,
  getLeagueDisputesHandler,
  addEvidenceHandler,
  rejectDisputeHandler,
} from "../controllers/financial.controller.js";

function createMockReqRes(options: {
  user?: { id: string; email: string; username: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, any>;
}) {
  let statusCode = 200;
  let jsonResponse: any = null;
  let nextError: any = null;

  const req = {
    user: options.user,
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

describe("Dispute HTTP Endpoints", () => {
  it("fileDisputeHandler rejects missing required fields", async () => {
    const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
      params: { leagueId: "11111111-2222-3333-4444-555555555555" },
      body: {},
    });

    await fileDisputeHandler(req, res, next);
    assert.equal(getStatusCode(), 400);
    assert.match(getJsonResponse().message, /claimantAddress and reason are required/);
  });

  it("fileDisputeHandler files dispute successfully", async () => {
    const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
      params: { leagueId: "11111111-2222-3333-4444-555555555555" },
      body: {
        claimantAddress: "GA1111111111111111111111111111111111111111111111111111111111",
        reason: "Score dispute on bonus point allocation",
        autoFreeze: false,
      },
    });

    await fileDisputeHandler(req, res, next);
    assert.equal(getStatusCode(), 201);
    assert.equal(getJsonResponse().success, true);
    assert.equal(getJsonResponse().data.leagueId, "11111111-2222-3333-4444-555555555555");
  });

  it("getLeagueDisputesHandler retrieves list of disputes", async () => {
    const leagueId = "22222222-3333-4444-5555-666666666666";
    // File one dispute first
    const fileReq = createMockReqRes({
      params: { leagueId },
      body: {
        claimantAddress: "GA2222222222222222222222222222222222222222222222222222222222",
        reason: "Test dispute",
        autoFreeze: false,
      },
    });
    await fileDisputeHandler(fileReq.req, fileReq.res, fileReq.next);

    const getReq = createMockReqRes({ params: { leagueId } });
    await getLeagueDisputesHandler(getReq.req, getReq.res, getReq.next);

    assert.equal(getReq.getStatusCode(), 200);
    assert.equal(getReq.getJsonResponse().success, true);
    assert.ok(Array.isArray(getReq.getJsonResponse().data));
    assert.ok(getReq.getJsonResponse().data.length >= 1);
  });

  it("addEvidenceHandler validates required fields", async () => {
    const { req, res, next, getStatusCode, getJsonResponse } = createMockReqRes({
      params: { disputeId: "some-id" },
      body: {},
    });

    await addEvidenceHandler(req, res, next);
    assert.equal(getStatusCode(), 400);
    assert.match(getJsonResponse().message, /submittedBy and description are required/);
  });
});
