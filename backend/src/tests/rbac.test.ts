import { setAccountStatusResolver } from "../services/privacy/accountStatus.js";
setAccountStatusResolver(() => false); // Active-account fixture for this isolated unit suite.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import {
  requireAuth,
  requireRole,
  requireStaff,
} from "../middleware/authMiddleware.js";
import { signAccessToken } from "../config/jwt.js";
import { UserRole } from "../types/index.js";

/**
 * Creates mock Express Request/Response helpers for middleware tests.
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

function roleToken(role: UserRole) {
  return signAccessToken({
    userId: `usr_${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@example.com`,
    username: role.toLowerCase(),
    role,
  });
}

describe("Role-Based Access Control (RBAC)", () => {
  describe("requireRole middleware", () => {
    it("should allow an ADMIN through an admin-only route", () => {
      const { req, res, next, wasNextCalled } = createMockReqRes();
      req.user = {
        id: "usr_admin",
        email: "admin@example.com",
        username: "admin",
        role: UserRole.ADMIN,
      };

      requireRole(UserRole.ADMIN)(req, res, next);

      assert.equal(wasNextCalled(), true);
    });

    it("should reject a regular USER with 403 on an admin-only route", () => {
      const { req, res, next, wasNextCalled, getStatusCode, getJsonResponse } =
        createMockReqRes();
      req.user = {
        id: "usr_user",
        email: "user@example.com",
        username: "user",
        role: UserRole.USER,
      };

      requireRole(UserRole.ADMIN)(req, res, next);

      assert.equal(wasNextCalled(), false);
      assert.equal(getStatusCode(), 403);
      assert.equal(getJsonResponse().success, false);
      assert.match(getJsonResponse().message, /permission/i);
    });

    it("should allow a MODERATOR through a staff-only route", () => {
      const { req, res, next, wasNextCalled } = createMockReqRes();
      req.user = {
        id: "usr_mod",
        email: "mod@example.com",
        username: "mod",
        role: UserRole.MODERATOR,
      };

      requireStaff(req, res, next);

      assert.equal(wasNextCalled(), true);
    });

    it("should allow any allowed role when multiple roles are supplied", () => {
      const { req, res, next, wasNextCalled } = createMockReqRes();
      req.user = {
        id: "usr_mod",
        email: "mod@example.com",
        username: "mod",
        role: UserRole.MODERATOR,
      };

      requireRole(UserRole.ADMIN, UserRole.MODERATOR)(req, res, next);

      assert.equal(wasNextCalled(), true);
    });

    it("should return 401 rather than 403 when no user is attached", () => {
      const { req, res, next, wasNextCalled, getStatusCode } =
        createMockReqRes();

      requireRole(UserRole.ADMIN)(req, res, next);

      assert.equal(wasNextCalled(), false);
      assert.equal(getStatusCode(), 401);
    });
  });

  describe("JWT role propagation", () => {
    it("should attach the ADMIN role from a signed JWT through requireAuth", () => {
      const token = roleToken(UserRole.ADMIN);
      const { req, res, next, wasNextCalled } = createMockReqRes(
        `Bearer ${token}`
      );

      requireAuth(req, res, next);

      assert.equal(wasNextCalled(), true);
      assert.equal(req.user?.role, UserRole.ADMIN);
    });

    it("should default to USER role when the JWT carries no role claim", () => {
      const token = signAccessToken({
        userId: "usr_legacy",
        email: "legacy@example.com",
        username: "legacy",
      });
      const { req, res, next, wasNextCalled } = createMockReqRes(
        `Bearer ${token}`
      );

      requireAuth(req, res, next);

      assert.equal(wasNextCalled(), true);
      assert.equal(req.user?.role, UserRole.USER);
    });
  });

  describe("Admin endpoint rejection", () => {
    it("should reject a regular USER token from a sync endpoint protected by requireStaff", () => {
      // Mirrors the route decorator: requireAuth + requireStaff
      const { req, res, next, getStatusCode } = createMockReqRes(
        `Bearer ${roleToken(UserRole.USER)}`
      );

      requireAuth(req, res, next);
      requireStaff(req, res, next);

      assert.equal(getStatusCode(), 403);
    });
  });
});