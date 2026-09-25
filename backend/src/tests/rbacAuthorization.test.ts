import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { Request, Response, NextFunction, Router } from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { signAccessToken } from "../config/jwt.js";
import {
  Permission,
  Role,
  ROLE_PERMISSIONS,
  hasPermission,
  isElevatedPermission,
} from "../config/permissions.js";
import { authenticateServiceKey, parseServiceApiKeys } from "../config/serviceAuth.js";
import { createPermissionGuard, requireAuth } from "../middleware/authMiddleware.js";
import apiV1Router from "../routes/index.js";
import authRoutes from "../routes/auth.routes.js";
import syncRoutes from "../routes/sync.routes.js";
import adminRoutes from "../routes/admin.routes.js";
import playerRoutes from "../routes/player.routes.js";
import teamRoutes from "../routes/team.routes.js";
import gameweekRoutes from "../routes/gameweek.routes.js";
import fixtureRoutes from "../routes/fixture.routes.js";
import squadRoutes from "../routes/squad.routes.js";
import leagueRoutes from "../routes/league.routes.js";
import financialRoutes from "../routes/financial.routes.js";
import liveRoutes from "../routes/live.routes.js";
import { UserRole } from "../types/index.js";

const SERVICE_KEY = "a".repeat(40);
process.env.SERVICE_API_KEYS = `scheduler:${SERVICE_KEY}`;

function tokenFor(role: string, userId = `usr_${role.toLowerCase()}`) {
  return signAccessToken({ userId, email: `${userId}@example.com`, username: userId, role });
}

function mockReqRes(user?: Request["user"]) {
  let status = 200;
  let nextCalled = false;
  const req = { headers: {}, user } as unknown as Request;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: () => res,
  } as unknown as Response;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  return { req, res, next, status: () => status, nextCalled: () => nextCalled };
}

describe("RBAC policy", () => {
  it("defines an explicit permission set for USER, MODERATOR, ADMIN and SERVICE", () => {
    assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), ["ADMIN", "MODERATOR", "SERVICE", "USER"]);
  });

  it("grants every permission to at least one role", () => {
    for (const permission of Object.values(Permission)) {
      assert.ok(
        Object.values(Role).some((role) => hasPermission(role, permission)),
        `${permission} is not granted to any role`
      );
    }
  });

  it("keeps operational permissions away from regular users", () => {
    for (const p of [Permission.FPL_SYNC, Permission.SCORE_CALCULATE, Permission.FINANCIAL_RECONCILE, Permission.SYSTEM_HEALTH_READ]) {
      assert.equal(hasPermission(Role.USER, p), false, p);
      assert.equal(isElevatedPermission(p), true, p);
    }
  });

  it("does not let SERVICE principals act as a manager", () => {
    for (const p of [Permission.SQUAD_CREATE, Permission.SQUAD_UPDATE_OWN, Permission.LEAGUE_JOIN, Permission.PAYMENT_MANAGE_OWN]) {
      assert.equal(hasPermission(Role.SERVICE, p), false, p);
    }
  });

  it("keeps moving funds and the full audit log ADMIN-only", () => {
    for (const p of [Permission.PAYOUT_MANAGE, Permission.FINANCIAL_AUDIT_READ]) {
      assert.equal(hasPermission(Role.ADMIN, p), true, p);
      assert.equal(hasPermission(Role.MODERATOR, p), false, p);
      assert.equal(hasPermission(Role.SERVICE, p), false, p);
    }
    assert.equal(hasPermission(Role.MODERATOR, Permission.PAYOUT_READ), true);
  });

  it("reserves score calculation for ADMIN and SERVICE", () => {
    assert.equal(hasPermission(Role.ADMIN, Permission.SCORE_CALCULATE), true);
    assert.equal(hasPermission(Role.SERVICE, Permission.SCORE_CALCULATE), true);
    assert.equal(hasPermission(Role.MODERATOR, Permission.SCORE_CALCULATE), false);
  });
});

describe("Service API keys", () => {
  it("authenticates a configured key and names the service", () => {
    assert.deepEqual(authenticateServiceKey(SERVICE_KEY), { name: "scheduler" });
  });

  it("rejects unknown, empty and near-miss keys", () => {
    assert.equal(authenticateServiceKey("b".repeat(40)), null);
    assert.equal(authenticateServiceKey(""), null);
    assert.equal(authenticateServiceKey(SERVICE_KEY.slice(1)), null);
  });

  it("ignores keys that are too short or malformed", () => {
    assert.deepEqual(parseServiceApiKeys("short:abc,:nokeyname,valid:" + "c".repeat(32)).map((k) => k.name), ["valid"]);
    assert.equal(authenticateServiceKey("abc", "short:abc"), null);
  });
});

describe("requirePermission middleware", () => {
  const adminUser = { id: "usr_admin", email: "", username: "admin", role: UserRole.ADMIN };

  it("returns 401 when no principal is attached", async () => {
    const guard = createPermissionGuard(async () => UserRole.ADMIN)(Permission.FPL_SYNC);
    const ctx = mockReqRes();
    await guard(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.status(), 401);
    assert.equal(ctx.nextCalled(), false);
  });

  it("returns 403 when the role lacks the permission, without hitting the database", async () => {
    let lookups = 0;
    const guard = createPermissionGuard(async () => {
      lookups++;
      return UserRole.USER;
    })(Permission.FPL_SYNC);
    const ctx = mockReqRes({ id: "usr_1", email: "", username: "u", role: UserRole.USER });
    await guard(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.status(), 403);
    assert.equal(lookups, 0);
  });

  it("allows an ADMIN whose role is confirmed by the database", async () => {
    const guard = createPermissionGuard(async () => UserRole.ADMIN)(Permission.SCORE_CALCULATE);
    const ctx = mockReqRes({ ...adminUser });
    await guard(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled(), true);
  });

  it("rejects an ADMIN token after the account was demoted", async () => {
    const guard = createPermissionGuard(async () => UserRole.USER)(Permission.FPL_SYNC);
    const ctx = mockReqRes({ ...adminUser });
    await guard(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.status(), 403);
    assert.equal(ctx.nextCalled(), false);
  });

  it("rejects an elevated token whose account was deleted", async () => {
    const guard = createPermissionGuard(async () => null)(Permission.FPL_SYNC);
    const ctx = mockReqRes({ ...adminUser });
    await guard(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.status(), 401);
  });

  it("does not look up the database for regular user permissions", async () => {
    let lookups = 0;
    const guard = createPermissionGuard(async () => {
      lookups++;
      return UserRole.USER;
    })(Permission.SQUAD_UPDATE_OWN);
    const ctx = mockReqRes({ id: "usr_1", email: "", username: "u", role: UserRole.USER });
    await guard(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled(), true);
    assert.equal(lookups, 0);
  });

  it("allows SERVICE principals their operational permissions", async () => {
    const guard = createPermissionGuard(async () => null)(Permission.FPL_SYNC);
    const ctx = mockReqRes({ id: "service:scheduler", email: "", username: "scheduler", role: Role.SERVICE });
    await guard(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled(), true);
  });
});

describe("requireAuth with service credentials", () => {
  it("attaches a SERVICE principal for a valid X-Service-Key", () => {
    const ctx = mockReqRes();
    (ctx.req as any).headers = { "x-service-key": SERVICE_KEY };
    requireAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.nextCalled(), true);
    assert.equal(ctx.req.user?.role, Role.SERVICE);
    assert.equal(ctx.req.user?.id, "service:scheduler");
  });

  it("rejects an invalid service key even when a valid JWT is also sent", () => {
    const ctx = mockReqRes();
    (ctx.req as any).headers = {
      "x-service-key": "wrong".repeat(10),
      authorization: `Bearer ${tokenFor(UserRole.ADMIN)}`,
    };
    requireAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.status(), 401);
    assert.equal(ctx.nextCalled(), false);
  });

  it("never grants SERVICE from a JWT role claim", () => {
    const ctx = mockReqRes();
    (ctx.req as any).headers = { authorization: `Bearer ${tokenFor("SERVICE")}` };
    requireAuth(ctx.req, ctx.res, ctx.next);
    assert.equal(ctx.req.user?.role, UserRole.USER);
  });
});

describe("Route authorization audit", () => {
  /** Endpoints intentionally reachable without authentication. */
  const PUBLIC_ROUTES = new Set([
    "POST /auth/register",
    "POST /auth/login",
    "GET /auth/google",
    "GET /auth/google/callback",
    "GET /players/",
    "GET /players/ownership-stats",
    "GET /players/:id",
    "GET /teams/",
    "GET /teams/:id",
    "GET /gameweeks/",
    "GET /gameweeks/current",
    "GET /gameweeks/:id",
    "GET /fixtures/",
    "GET /squads/:id",
    "GET /squads/user/:userId",
    "GET /leagues/",
    "GET /leagues/:id",
    "GET /leagues/invitations/:token",
    "GET /leagues/:id/members",
    "GET /leagues/:id/standings",
    "GET /leagues/:id/h2h-standings",
    "GET /live/timeline/:gameweekId",
    "GET /live/timeline/:gameweekId/stream",
  ]);

  const MOUNTS: Array<[string, Router]> = [
    ["/auth", authRoutes],
    ["/admin/sync", syncRoutes],
    ["/admin", adminRoutes],
    ["/players", playerRoutes],
    ["/teams", teamRoutes],
    ["/gameweeks", gameweekRoutes],
    ["/fixtures", fixtureRoutes],
    ["/squads", squadRoutes],
    ["/leagues", leagueRoutes],
    ["/leagues/:leagueId/financial", financialRoutes],
    ["/live", liveRoutes],
  ];

  /** Lists every route of a router with the middleware names guarding it. */
  function collectRoutes(prefix: string, router: Router) {
    const routes: Array<{ key: string; guards: string[] }> = [];
    const routerLevel: string[] = [];
    for (const layer of (router as any).stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
        const handlers = layer.route.stack.map((l: any) => l.name);
        for (const method of methods) {
          routes.push({ key: `${method} ${prefix}${layer.route.path}`, guards: [...routerLevel, ...handlers] });
        }
      } else if (layer.name !== "router") {
        routerLevel.push(layer.name);
      }
    }
    return routes;
  }

  const allRoutes = MOUNTS.flatMap(([prefix, router]) => collectRoutes(prefix, router));

  it("discovers the API's routes", () => {
    assert.ok(allRoutes.length >= 40, `expected the full route table, found ${allRoutes.length}`);
  });

  it("protects every non-public endpoint with requireAuth and a permission guard", () => {
    const unguarded = allRoutes
      .filter((r) => !PUBLIC_ROUTES.has(r.key))
      .filter((r) => !r.guards.includes("requireAuth") || !r.guards.includes("permissionGuard"))
      .map((r) => r.key);
    assert.deepEqual(unguarded, []);
  });

  it("keeps every public route read-only apart from sign-up and sign-in", () => {
    const mutatingPublic = [...PUBLIC_ROUTES].filter(
      (key) => !key.startsWith("GET ") && key !== "POST /auth/register" && key !== "POST /auth/login"
    );
    assert.deepEqual(mutatingPublic, []);
  });
});

describe("Unauthorized access attempts (HTTP)", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1", apiV1Router);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  after(() => {
    server.close();
  });

  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: method === "GET" ? undefined : "{}",
    });

  const ADMIN_ENDPOINTS: Array<[string, string]> = [
    ["POST", "/admin/sync/bootstrap"],
    ["POST", "/admin/sync/fixtures"],
    ["POST", "/admin/sync/gameweek/1"],
    ["POST", "/squads/sq_1/calculate-score/1"],
    ["GET", "/leagues/lg_1/reconcile"],
    ["GET", "/leagues/lg_1/financial/reconcile"],
    ["GET", "/admin/payouts/dead-letter"],
    ["POST", "/admin/payouts/dead-letter/1/retry"],
    ["POST", "/admin/payouts/dead-letter/1/discard"],
    ["GET", "/admin/audit/financial"],
  ];

  it("rejects anonymous requests to admin endpoints with 401", async () => {
    for (const [method, path] of ADMIN_ENDPOINTS) {
      const res = await call(method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it("rejects regular users from admin endpoints with 403", async () => {
    const auth = { Authorization: `Bearer ${tokenFor(UserRole.USER)}` };
    for (const [method, path] of ADMIN_ENDPOINTS) {
      const res = await call(method, path, auth);
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });

  it("rejects a forged SERVICE role claim in a user JWT", async () => {
    const res = await call("POST", "/admin/sync/bootstrap", { Authorization: `Bearer ${tokenFor("SERVICE")}` });
    assert.equal(res.status, 403);
  });

  it("rejects invalid service keys with 401", async () => {
    const res = await call("POST", "/admin/sync/bootstrap", { "X-Service-Key": "x".repeat(40) });
    assert.equal(res.status, 401);
  });

  it("stops SERVICE principals from using manager endpoints", async () => {
    const service = { "X-Service-Key": SERVICE_KEY };
    for (const [method, path] of [
      ["POST", "/squads"],
      ["PUT", "/squads/sq_1"],
      ["POST", "/leagues"],
      ["POST", "/leagues/lg_1/join"],
      ["POST", "/leagues/lg_1/submit-payment"],
      ["GET", "/auth/me"],
    ]) {
      const res = await call(method, path, service);
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });

  it("rejects tampered tokens", async () => {
    const token = tokenFor(UserRole.ADMIN);
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const res = await call("POST", "/admin/sync/bootstrap", { Authorization: `Bearer ${tampered}` });
    assert.equal(res.status, 401);
  });
});
