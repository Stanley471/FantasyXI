import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlowQueryTelemetry } from "../config/slowQueryTelemetry.js";

describe("SlowQueryTelemetry", () => {
  it("logs slow queries with a safe fingerprint and rolling count", () => {
    let now = 10_000;
    const messages: string[] = [];
    const telemetry = new SlowQueryTelemetry({
      now: () => now,
      logger: { warn: (message) => messages.push(String(message)) },
    });

    telemetry.observe({
      query: "SELECT * FROM users WHERE email = 'private@example.com' AND id = 42",
      duration: 201,
    });

    assert.equal(telemetry.getRollingCount(), 1);
    assert.equal(messages.length, 1);
    const log = JSON.parse(messages[0]);
    assert.equal(log.operation, "SELECT");
    assert.equal(log.durationMs, 201);
    assert.equal(log.slowQueriesLastMinute, 1);
    assert.match(log.queryFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(messages[0].includes("private@example.com"), false);
    assert.equal(messages[0].includes("42"), false);
  });

  it("ignores fast queries and expires old entries", () => {
    let now = 1_000;
    const messages: string[] = [];
    const telemetry = new SlowQueryTelemetry({
      now: () => now,
      logger: { warn: (message) => messages.push(String(message)) },
    });

    telemetry.observe({ query: "SELECT 1", duration: 200 });
    assert.equal(telemetry.getRollingCount(), 0);
    assert.equal(messages.length, 0);

    telemetry.observe({ query: "UPDATE users SET active = true", duration: 201 });
    assert.equal(telemetry.getRollingCount(), 1);

    now += 60_000;
    assert.equal(telemetry.getRollingCount(), 0);
  });
});
