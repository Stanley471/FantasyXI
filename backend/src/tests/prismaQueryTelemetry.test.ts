import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getSlowQueryMetrics,
  redactSensitiveQueryParams,
  registerPrismaQueryTelemetry,
} from "../config/db.js";

describe("Prisma slow-query telemetry", () => {
  const originalWarn = console.warn;
  let warnings: unknown[] = [];

  beforeEach(() => {
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args[0]);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    getSlowQueryMetrics().reset();
  });

  it("redacts password material and records slow query metrics", () => {
    const redacted = redactSensitiveQueryParams({
      email: "user@example.com",
      password: "super-secret",
      passwordHash: "$2a$10$abcdefghijklmnopqrstuv",
      token: "abc.def.ghi",
    });

    assert.deepEqual(redacted, {
      email: "user@example.com",
      password: "[REDACTED]",
      passwordHash: "[REDACTED]",
      token: "[REDACTED]",
    });

    const listeners = new Map<string, (event: any) => void>();
    const fakeClient = {
      $on: (event: string, handler: (event: any) => void) => {
        listeners.set(event, handler);
      },
    };

    registerPrismaQueryTelemetry(fakeClient as any);

    listeners.get("query")?.({
      duration: 421,
      query: "SELECT * FROM users WHERE email = $1 AND password_hash = $2",
      params: JSON.stringify(["user@example.com", "$2a$10$abcdefghijklmnopqrstuv"]),
      target: "query_engine",
    });

    const metrics = getSlowQueryMetrics();
    assert.equal(metrics.rollingSlowQueryCount, 1);
    assert.equal(metrics.lastSlowQuery?.durationMs, 421);
    assert.equal(metrics.lastSlowQuery?.operation, "query_engine");
    assert.ok(Array.isArray(warnings) && warnings.length > 0);

    const payload = JSON.parse(String(warnings[0]));
    assert.equal(payload.durationMs, 421);
    assert.equal(payload.operation, "query_engine");
    assert.ok(payload.queryFingerprint.includes("SELECT * FROM users WHERE email"));
    assert.equal(payload.params[1], "[REDACTED]");
  });
});
