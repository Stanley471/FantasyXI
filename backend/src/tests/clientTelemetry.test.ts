import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { ClientTelemetryService } from "../services/telemetry/clientTelemetryService.js";
import telemetryRoutes from "../routes/telemetry.routes.js";

describe("Client telemetry ingestion", () => {
  it("redacts credentials and PII while preserving diagnostic grouping", () => {
    const calls: any[] = [];
    const service = new ClientTelemetryService({ info: (...args: any[]) => calls.push(args) } as any);
    const accepted = service.ingest({
      events: [{
        type: "error",
        name: "TypeError",
        timestamp: Date.now(),
        count: 4,
        metadata: {
          authorization: "Bearer top-secret-token",
          message: "Failed for manager@example.test with Bearer abc.def.ghi",
          stack: "at Widget (/team/page.tsx:4)",
        },
      }],
    }, { ip: "203.0.113.10" });
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].count, 4);
    assert.equal(accepted[0].metadata?.authorization, "[REDACTED]");
    assert.doesNotMatch(String(accepted[0].metadata?.message), /manager@|abc\.def/);
    assert.match(accepted[0].fingerprint, /^[0-9a-f]{24}$/);
    assert.equal(calls.length, 1);
  });

  it("rejects malformed events and caps a batch", () => {
    const service = new ClientTelemetryService({ info: () => {} } as any);
    assert.deepEqual(service.ingest({ events: [null, {}, { type: 1, name: "bad" }] }, { ip: "test" }), []);
    const accepted = service.ingest({
      events: Array.from({ length: 80 }, (_, index) => ({ type: "custom", name: `event-${index}`, timestamp: 1 })),
    }, { ip: "test" });
    assert.equal(accepted.length, 50);
  });

  it("accepts text/plain beacon payloads through the HTTP route", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/telemetry", telemetryRoutes);
    const server = app.listen(0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ events: [{ type: "network", name: "offline", timestamp: 1 }] }),
      });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).accepted, 1);
    } finally {
      server.close();
    }
  });
});
