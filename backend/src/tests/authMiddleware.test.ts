import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import { requireAuth, optionalAuth } from "../middleware/authMiddleware.js";
import { signAccessToken, jwtKeyRing } from "../config/jwt.js";

/**
 * Creates mock Express Request and Response objects.
 */
function createMockReqRes(authHeader?: string) {
  let statusCode = 200;
  let jsonResponse: unknown = null;
  let nextCalled = false;

  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    user: undefined,
  } as unknown as Request;

  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      jsonResponse = payload;
      return res;
    },
  } as unknown as Response;

  const next: NextFunction = () => {
    nextCalled = true;
  };

  return {
    req,
    res,
    next,
    getStatusCode: () => statusCode,
    getJsonResponse: () => jsonResponse as { success: boolean; message: string },
    wasNextCalled: () => nextCalled,
  };
}

describe("JWT Authentication Middleware", () => {
  it("should authenticate request with valid Bearer token and attach req.user", () => {
    const token = signAccessToken({
      userId: "usr_12345",
      email: "stanley@example.com",
      username: "stanley",
    });

    const { req, res, next, wasNextCalled } = createMockReqRes(`Bearer ${token}`);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), true);
    assert.ok(req.user);
    assert.equal(req.user?.id, "usr_12345");
    assert.equal(req.user?.email, "stanley@example.com");
    assert.equal(req.user?.username, "stanley");
  });

  it("should reject request with missing Authorization header (401)", () => {
    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes(undefined);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.equal(getJsonResponse().success, false);
    assert.match(getJsonResponse().message, /missing/i);
  });

  it("should reject request with malformed Authorization header (missing Bearer prefix)", () => {
    const token = signAccessToken({
      userId: "usr_12345",
      email: "stanley@example.com",
      username: "stanley",
    });

    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes(`Token ${token}`);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.match(getJsonResponse().message, /expected bearer/i);
  });

  it("should reject request with invalid signature / corrupted token (401)", () => {
    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes("Bearer corrupted.invalid.token");

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.match(getJsonResponse().message, /invalid authentication token/i);
  });

  it("should reject expired token with clear 401 expiration message", () => {
    // Generate a token that expired 10 seconds ago, signed with the current key
    const expiredToken = jwtKeyRing.sign(
      {
        userId: "usr_expired",
        email: "expired@example.com",
        username: "expired",
      },
      "-10s"
    );

    const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
      createMockReqRes(`Bearer ${expiredToken}`);

    requireAuth(req, res, next);

    assert.equal(wasNextCalled(), false);
    assert.equal(getStatusCode(), 401);
    assert.match(getJsonResponse().message, /expired/i);
  });

  it("optionalAuth should attach user when valid token present", () => {
    const token = signAccessToken({
      userId: "usr_guest",
      email: "guest@example.com",
      username: "guest",
    });

    const { req, res, next, wasNextCalled } = createMockReqRes(`Bearer ${token}`);

    optionalAuth(req, res, next);

    assert.equal(wasNextCalled(), true);
    assert.equal(req.user?.id, "usr_guest");
  });

  it("optionalAuth should continue without error when token is absent", () => {
    const { req, res, next, wasNextCalled } = createMockReqRes(undefined);

    optionalAuth(req, res, next);

    assert.equal(wasNextCalled(), true);
    assert.equal(req.user, undefined);
  });
});
