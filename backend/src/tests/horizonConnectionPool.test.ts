import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Horizon } from "@stellar/stellar-sdk";
import { HorizonConnectionPool } from "../config/stellar.js";

function createPool(options: {
  urls: string[];
  latencies: Record<string, number>;
  warnings?: string[];
}) {
  return new HorizonConnectionPool({
    urls: options.urls,
    healthCheckIntervalMs: 60_000,
    createServer: (url) =>
      ({ url, httpClient: { defaults: {} } }) as unknown as Horizon.Server,
    probe: async (url) => options.latencies[url],
    warn: (message) => options.warnings?.push(message),
  });
}

describe("HorizonConnectionPool", () => {
  it("routes requests to the fastest healthy endpoint", async () => {
    const urls = ["https://primary.test", "https://backup.test", "https://quick.test"];
    const pool = createPool({
      urls,
      latencies: {
        [urls[0]]: 80,
        [urls[1]]: 25,
        [urls[2]]: 10,
      },
    });

    try {
      const selected = await pool.run(async (server) =>
        (server as unknown as { url: string }).url
      );
      assert.equal(selected, urls[2]);
      assert.ok(pool.getHealthSnapshot().every(({ healthy }) => healthy));
    } finally {
      pool.stop();
    }
  });

  it("fails over after a server error and logs the node URL and latency", async () => {
    const urls = ["https://primary.test", "https://backup.test"];
    const warnings: string[] = [];
    const pool = createPool({
      urls,
      latencies: { [urls[0]]: 5, [urls[1]]: 20 },
      warnings,
    });

    try {
      const selected = await pool.run(async (server) => {
        const url = (server as unknown as { url: string }).url;
        if (url === urls[0]) {
          throw Object.assign(new Error("Horizon unavailable"), {
            response: { status: 500 },
          });
        }
        return url;
      });

      assert.equal(selected, urls[1]);
      assert.equal(pool.getHealthSnapshot()[0].healthy, false);
      assert.equal(pool.getHealthSnapshot()[0].errorRate, 0.5);
      assert.match(warnings[0], /primary\.test.*after \d+ms \(HTTP 500\)/);
    } finally {
      pool.stop();
    }
  });

  it("does not retry non-transient client errors", async () => {
    const urls = ["https://primary.test", "https://backup.test"];
    const pool = createPool({
      urls,
      latencies: { [urls[0]]: 5, [urls[1]]: 20 },
    });
    let attempts = 0;

    try {
      await assert.rejects(
        pool.run(async () => {
          attempts += 1;
          throw Object.assign(new Error("Not found"), { response: { status: 404 } });
        }),
        /Not found/
      );
      assert.equal(attempts, 1);
    } finally {
      pool.stop();
    }
  });
});
