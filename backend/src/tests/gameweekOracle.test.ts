import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGameweekResultProof,
  GameweekOracleService,
} from "../services/financial/gameweekOracleService.js";

describe("GameweekOracleService", () => {
  it("creates a stable proof independent of score row ordering", () => {
    const first = createGameweekResultProof(12, [
      { squadId: "s2", points: 44 },
      { squadId: "s1", points: 61 },
    ]);
    const second = createGameweekResultProof(12, [
      { squadId: "s1", points: 61 },
      { squadId: "s2", points: 44 },
    ]);
    assert.equal(first, second);
    assert.equal(first.length, 64);
    assert.notEqual(first, createGameweekResultProof(12, [{ squadId: "s1", points: 62 }]));
  });

  it("rejects publication before all fixtures have finished", async () => {
    const service = new GameweekOracleService({
      gameweek: { findUnique: async () => ({ fplId: 12, settledAt: null, fixtures: [{ finished: false }] }) },
    } as any, () => { throw new Error("contract client must not be constructed"); });

    await assert.rejects(
      service.publishFinalGameweek(4, "key"),
      /all fixtures finished/
    );
  });

  it("publishes only a finalized score commitment", async () => {
    let published: any;
    const service = new GameweekOracleService({
      gameweek: { findUnique: async () => ({ fplId: 12, settledAt: null, fixtures: [{ finished: true }] }) },
      squadGameweekScore: {
        findMany: async () => [
          { squadId: "s2", points: 44 },
          { squadId: "s1", points: 61 },
        ],
      },
    } as any, () => ({
      publishGameweekResult: async (...args: any[]) => { published = args; return { success: true }; },
    } as any));

    const result = await service.publishFinalGameweek(4, "key");

    assert.deepEqual(result, { success: true });
    assert.equal(published[0], "key");
    assert.equal(published[1], 12);
    assert.equal(published[2], createGameweekResultProof(12, [
      { squadId: "s1", points: 61 },
      { squadId: "s2", points: 44 },
    ]));
  });
});