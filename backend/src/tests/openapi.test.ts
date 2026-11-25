import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openApiSpec } from "../docs/openapi.js";
import { createDocsRouter, isDocsEnabled } from "../routes/docs.routes.js";

type OperationMap = Record<string, Record<string, any>>;

function operations(): Array<{ method: string; path: string; op: any }> {
  const out: Array<{ method: string; path: string; op: any }> = [];
  const paths = (openApiSpec as unknown as { paths: OperationMap }).paths;
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        out.push({ method, path, op });
      }
    }
  }
  return out;
}

function hasOperation(method: string, path: string): boolean {
  const paths = (openApiSpec as unknown as { paths: OperationMap }).paths;
  return typeof (paths[path] as any)?.[method] === "object";
}

// Core v1 operations the spec must cover, grouped by area. These mirror the
// Express routers under src/routes; if a route is added or renamed, add or
// rename its entry here in the same change.
const REQUIRED_OPERATIONS: Array<[string, string]> = [
  ["post", "/api/v1/auth/register"],
  ["post", "/api/v1/auth/login"],
  ["post", "/api/v1/auth/login/verify"],
  ["post", "/api/v1/auth/refresh"],
  ["post", "/api/v1/auth/logout"],
  ["get", "/api/v1/auth/me"],
  ["get", "/api/v1/auth/sessions"],
  ["post", "/api/v1/auth/webauthn/login/options"],
  ["post", "/api/v1/auth/webauthn/login/verify"],
  ["get", "/api/v1/players"],
  ["get", "/api/v1/players/{id}"],
  ["get", "/api/v1/players/{id}/analytics"],
  ["post", "/api/v1/players/batch-stats"],
  ["get", "/api/v1/teams"],
  ["get", "/api/v1/teams/{id}"],
  ["get", "/api/v1/gameweeks"],
  ["get", "/api/v1/gameweeks/current"],
  ["get", "/api/v1/gameweeks/{id}"],
  ["get", "/api/v1/fixtures"],
  ["post", "/api/v1/squads"],
  ["get", "/api/v1/squads/me"],
  ["get", "/api/v1/squads/{id}"],
  ["get", "/api/v1/squads/{id}/value"],
  ["put", "/api/v1/squads/{id}"],
  ["post", "/api/v1/squads/{id}/chip"],
  ["post", "/api/v1/leagues"],
  ["get", "/api/v1/leagues"],
  ["get", "/api/v1/leagues/{id}"],
  ["post", "/api/v1/leagues/{id}/join"],
  ["get", "/api/v1/leagues/{id}/members"],
  ["get", "/api/v1/leagues/{id}/standings"],
  ["get", "/api/v1/leagues/{id}/h2h-standings"],
  ["get", "/api/v1/leagues/{leagueId}/chat/messages"],
  ["post", "/api/v1/leagues/{leagueId}/chat/messages"],
  ["get", "/api/v1/live/timeline/{gameweekId}"],
  ["get", "/api/v1/live/leaderboard/{leagueId}"],
  ["get", "/api/v1/leaderboard"],
  ["post", "/api/v1/leaderboard/matchmaking/join"],
  ["get", "/api/v1/analytics/me/performance"],
  ["get", "/api/v1/proof-of-reserve"],
  ["post", "/api/v1/financial/submit"],
  ["post", "/api/v1/financial/verify"],
  ["get", "/api/v1/financial/settlement-plan"],
  ["post", "/api/v1/financial/disputes"],
  ["get", "/api/v1/financial/disputes"],
  ["get", "/api/v1/admin/payouts/dead-letter"],
  ["get", "/api/v1/admin/audit/verify"],
  ["post", "/api/v1/admin/sync/bootstrap"],
  ["post", "/api/v1/admin/sync/gameweek/{id}"],
  ["post", "/api/v1/webhooks/endpoints"],
  ["get", "/api/v1/webhooks/endpoints"],
  ["post", "/api/v1/sep8/tx_approve"],
  ["get", "/api/v1/sep8/kyc/status"],
  ["get", "/api/health"],
];

describe("OpenAPI v1 specification", () => {
  it("is a valid OpenAPI 3.0 document (swagger-parser, no schema errors)", async () => {
    const api = await SwaggerParser.validate(
      JSON.parse(JSON.stringify(openApiSpec)) as any,
    );
    assert.equal((api as any).openapi, "3.0.3");
    assert.equal((api as any).info.title, "FantasyXI API");
  });

  it("dereferences cleanly (every $ref resolves)", async () => {
    const api = await SwaggerParser.dereference(
      JSON.parse(JSON.stringify(openApiSpec)) as any,
    );
    // Dereference inlines every $ref; a dangling reference throws.
    assert.equal((api as any).info.title, "FantasyXI API");
    assert.ok(Object.keys((api as any).paths).length > 0);
  });

  it("covers the core v1 operations", () => {
    const missing = REQUIRED_OPERATIONS.filter(
      ([method, path]) => !hasOperation(method, path),
    );
    assert.deepEqual(missing, [], `missing operations: ${JSON.stringify(missing)}`);
    const ops = operations();
    assert.ok(ops.length >= 100, `expected at least 100 operations, got ${ops.length}`);
    const v1 = ops.filter(({ path }) => path.startsWith("/api/v1/"));
    assert.ok(v1.length >= 100, `expected at least 100 v1 operations, got ${v1.length}`);
  });

  it("every operation has tags, a summary and responses", () => {
    for (const { method, path, op } of operations()) {
      assert.ok(Array.isArray(op.tags) && op.tags.length > 0, `${method.toUpperCase()} ${path} has no tags`);
      assert.equal(typeof op.summary, "string", `${method.toUpperCase()} ${path} has no summary`);
      assert.ok(op.responses && Object.keys(op.responses).length > 0, `${method.toUpperCase()} ${path} has no responses`);
    }
  });

  it("every v1 operation documents at least one error response", () => {
    const withoutError = operations().filter(
      ({ path, op }) =>
        path.startsWith("/api/v1/") &&
        !Object.keys(op.responses).some((code) => /^[45]/.test(code)),
    );
    assert.deepEqual(
      withoutError.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
      [],
    );
  });

  it("every path-template parameter is declared on the operation", () => {
    for (const { method, path, op } of operations()) {
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const declared = new Set<string>();
      const params = [...(op.parameters ?? [])];
      for (const p of params) {
        if (typeof p === "object" && p !== null && "$ref" in p) {
          // $ref parameters are shared (page/limit/idempotency-key): none of
          // them is a path parameter, so they cannot satisfy a template slot.
          continue;
        }
        if (p.in === "path") declared.add(p.name);
      }
      for (const name of inPath) {
        assert.ok(declared.has(name), `${method.toUpperCase()} ${path} does not declare path parameter {${name}}`);
      }
    }
  });

  it("declares the auth schemes the backend actually uses", () => {
    const spec = openApiSpec as unknown as any;
    assert.equal(spec.components.securitySchemes.bearerAuth.type, "http");
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
    assert.equal(spec.components.securitySchemes.serviceKey.name, "X-Service-Key");
    assert.equal(spec.components.securitySchemes.serviceKey.in, "header");
    // The internal webhook signing headers are documented (X-Fantasy-*) …
    assert.equal(spec.components.securitySchemes.internalWebhook.name, "X-Fantasy-Signature");
    // … but no public v1 operation claims to enforce them.
    const usesInternal = operations().filter(({ op }) =>
      JSON.stringify(op.security ?? []).includes("internalWebhook"),
    );
    assert.equal(usesInternal.length, 0);
  });

  it("protected operations require auth; public reads do not", () => {
    const spec = openApiSpec as unknown as { paths: OperationMap };
    const createSquad = (spec.paths["/api/v1/squads"] as any).post;
    assert.ok(
      JSON.stringify(createSquad.security).includes("bearerAuth"),
      "POST /api/v1/squads must require auth",
    );
    const listPlayers = (spec.paths["/api/v1/players"] as any).get;
    assert.equal(listPlayers.security, undefined, "GET /api/v1/players is public");
  });

  it("mutations that honour Idempotency-Key declare the header", () => {
    const spec = openApiSpec as unknown as { paths: OperationMap };
    const withKey = (op: any): boolean =>
      (op.parameters ?? []).some(
        (p: any) => p.$ref === "#/components/parameters/IdempotencyKey",
      );
    assert.ok(withKey((spec.paths["/api/v1/squads"] as any).post), "POST /squads");
    assert.ok(withKey((spec.paths["/api/v1/squads/{id}"] as any).put), "PUT /squads/{id}");
    assert.ok(withKey((spec.paths["/api/v1/financial/submit"] as any).post), "POST /financial/submit");
    assert.ok(withKey((spec.paths["/api/v1/financial/verify"] as any).post), "POST /financial/verify");
  });

  it("declares request/response schemas for the main write operations", () => {
    const spec = openApiSpec as unknown as { paths: OperationMap };
    const bodyOf = (path: string, method: string): any =>
      (spec.paths[path] as any)[method].requestBody?.content?.["application/json"]?.schema;
    assert.equal(bodyOf("/api/v1/auth/register", "post").$ref, "#/components/schemas/RegisterRequest");
    assert.equal(bodyOf("/api/v1/squads", "post").$ref, "#/components/schemas/CreateSquadRequest");
    assert.equal(bodyOf("/api/v1/leagues", "post").$ref, "#/components/schemas/CreateLeagueRequest");
    assert.equal(bodyOf("/api/v1/financial/submit", "post").$ref, "#/components/schemas/SubmitPaymentRequest");
    assert.equal(bodyOf("/api/v1/webhooks/endpoints", "post").$ref, "#/components/schemas/CreateWebhookEndpointRequest");
  });
});

describe("API docs router (/api/docs)", () => {
  function buildApp() {
    const app = express();
    app.use("/api/docs", createDocsRouter());
    return app;
  }

  it("serves Swagger UI HTML and the raw spec in development", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      assert.equal(isDocsEnabled(), true);
      const app = buildApp();
      const ui = await request(app).get("/api/docs/");
      assert.equal(ui.status, 200);
      assert.match(ui.headers["content-type"], /text\/html/);
      assert.match(ui.text, /swagger-ui/i);

      const spec = await request(app).get("/api/docs/docs.json");
      assert.equal(spec.status, 200);
      assert.equal(spec.body.openapi, "3.0.3");
      assert.equal(spec.body.info.title, "FantasyXI API");
      assert.ok("/api/v1/squads" in spec.body.paths);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("returns 404 in production (docs never served)", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.equal(isDocsEnabled(), false);
      const app = buildApp();
      const ui = await request(app).get("/api/docs/");
      assert.equal(ui.status, 404);
      const spec = await request(app).get("/api/docs/docs.json");
      assert.equal(spec.status, 404);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
