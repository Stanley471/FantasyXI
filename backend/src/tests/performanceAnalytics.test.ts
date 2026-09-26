import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import {
  AnalyticsService,
  analyticsService,
  buildPerformanceAnalytics,
  GameweekScoreInput,
} from "../services/analytics/performanceAnalytics.js";
import analyticsRoutes from "../routes/analytics.routes.js";
import { signAccessToken } from "../config/jwt.js";
import { ChipType } from "../types/index.js";

function score(fplId: number, points: number, extra: Partial<GameweekScoreInput> = {}): GameweekScoreInput {
  return {
    gameweekId: fplId + 100,
    gameweekFplId: fplId,
    gameweekName: `Gameweek ${fplId}`,
    deadline: new Date(Date.UTC(2026, 7, fplId)),
    points,
    benchPoints: 0,
    captainPoints: 0,
    transferCost: 0,
    ...extra,
  };
}

describe("Performance analytics aggregation", () => {
  it("returns an empty, zeroed dashboard when no gameweeks have been scored", () => {
    const result = buildPerformanceAnalytics([]);
    assert.deepEqual(result.history, []);
    assert.equal(result.summary.gameweeksPlayed, 0);
    assert.equal(result.summary.totalPoints, 0);
    assert.equal(result.summary.averagePoints, 0);
    assert.equal(result.summary.bestGameweek, null);
    assert.equal(result.summary.worstGameweek, null);
    assert.equal(result.summary.captainShare, 0);
  });

  it("orders gameweeks by FPL round and accumulates points over time", () => {
    const result = buildPerformanceAnalytics([score(3, 70), score(1, 50), score(2, 40)]);
    assert.deepEqual(result.history.map((h) => h.gameweekFplId), [1, 2, 3]);
    assert.deepEqual(result.history.map((h) => h.cumulativePoints), [50, 90, 160]);
    assert.equal(result.summary.totalPoints, 160);
  });

  it("computes a 3-gameweek rolling average", () => {
    const result = buildPerformanceAnalytics([score(1, 30), score(2, 60), score(3, 90), score(4, 10)]);
    assert.deepEqual(result.history.map((h) => h.rollingAverage), [30, 45, 60, 53.3]);
  });

  it("summarises average, median, spread, best/worst and recent form", () => {
    const pts = [40, 80, 55, 62, 71, 38, 90];
    const result = buildPerformanceAnalytics(pts.map((p, i) => score(i + 1, p)));
    const { summary } = result;
    assert.equal(summary.gameweeksPlayed, 7);
    assert.equal(summary.averagePoints, 62.3);
    assert.equal(summary.medianPoints, 62);
    assert.equal(summary.standardDeviation, 18.1);
    assert.deepEqual(summary.bestGameweek, { gameweekId: 107, gameweekName: "Gameweek 7", points: 90 });
    assert.deepEqual(summary.worstGameweek, { gameweekId: 106, gameweekName: "Gameweek 6", points: 38 });
    // Last 5: 55, 62, 71, 38, 90
    assert.equal(summary.recentForm, 63.2);
  });

  it("takes the median of an even number of gameweeks as the midpoint", () => {
    const result = buildPerformanceAnalytics([score(1, 10), score(2, 20), score(3, 40), score(4, 100)]);
    assert.equal(result.summary.medianPoints, 30);
  });

  it("benchmarks each gameweek against the platform average and highest score", () => {
    const result = buildPerformanceAnalytics(
      [score(1, 60), score(2, 40)],
      [
        { gameweekId: 101, averagePoints: 52.456, highestPoints: 98 },
        { gameweekId: 102, averagePoints: 45, highestPoints: 77 },
      ]
    );
    const [gw1, gw2] = result.history;
    assert.equal(gw1.averagePoints, 52.5);
    assert.equal(gw1.highestPoints, 98);
    assert.equal(gw1.differenceVsAverage, 7.5);
    assert.equal(gw2.differenceVsAverage, -5);
    assert.deepEqual(result.history.map((h) => h.cumulativeAveragePoints), [52.5, 97.5]);
    assert.equal(result.summary.gameweeksAboveAverage, 1);
  });

  it("reports missing benchmarks as null and stops the cumulative comparison there", () => {
    const result = buildPerformanceAnalytics(
      [score(1, 60), score(2, 40), score(3, 50)],
      [
        { gameweekId: 101, averagePoints: 50, highestPoints: 90 },
        { gameweekId: 103, averagePoints: 50, highestPoints: 90 },
      ]
    );
    assert.deepEqual(result.history.map((h) => h.averagePoints), [50, null, 50]);
    assert.deepEqual(result.history.map((h) => h.cumulativeAveragePoints), [50, null, null]);
    assert.equal(result.history[1].differenceVsAverage, null);
  });

  it("totals bench points, captaincy bonus and transfer hits", () => {
    const result = buildPerformanceAnalytics([
      score(1, 60, { benchPoints: 8, captainPoints: 12, transferCost: 4 }),
      score(2, 40, { benchPoints: 3, captainPoints: 8, transferCost: 0 }),
    ]);
    assert.equal(result.summary.totalBenchPoints, 11);
    assert.equal(result.summary.totalCaptainPoints, 20);
    assert.equal(result.summary.totalTransferCost, 4);
    assert.equal(result.summary.captainShare, 20);
  });

  it("does not report a captain share for a zero or negative season total", () => {
    const result = buildPerformanceAnalytics([score(1, -4, { captainPoints: 0, transferCost: 4 })]);
    assert.equal(result.summary.captainShare, 0);
    assert.equal(result.summary.totalPoints, -4);
  });

  it("tags the gameweeks in which chips were played, in season order", () => {
    const result = buildPerformanceAnalytics(
      [score(1, 50), score(2, 90), score(3, 40)],
      [],
      [
        { chipType: ChipType.WILDCARD, gameweekId: 103, gameweekName: "Gameweek 3" },
        { chipType: ChipType.TRIPLE_CAPTAIN, gameweekId: 102, gameweekName: "Gameweek 2" },
      ]
    );
    assert.deepEqual(result.history.map((h) => h.chip), [null, ChipType.TRIPLE_CAPTAIN, ChipType.WILDCARD]);
    assert.deepEqual(result.chips.map((c) => c.chipType), [ChipType.TRIPLE_CAPTAIN, ChipType.WILDCARD]);
  });

  it("serialises deadlines as ISO strings", () => {
    const [gw] = buildPerformanceAnalytics([score(1, 50)]).history;
    assert.equal(gw.deadline, "2026-08-01T00:00:00.000Z");
  });
});

// ------------------------------------------------------------
// Service: loads a user's own squad and platform benchmarks
// ------------------------------------------------------------

function createAnalyticsDb() {
  const gameweeks = new Map([
    [1, { fplId: 1, name: "Gameweek 1", deadline: new Date("2026-08-15T10:00:00Z") }],
    [2, { fplId: 2, name: "Gameweek 2", deadline: new Date("2026-08-22T10:00:00Z") }],
  ]);
  const squads = [
    { id: "squad-old", userId: "user-1", name: "Original XI", createdAt: new Date("2026-08-01") },
    { id: "squad-new", userId: "user-1", name: "Second XI", createdAt: new Date("2026-08-10") },
    { id: "squad-other", userId: "user-2", name: "Rival XI", createdAt: new Date("2026-08-02") },
  ];
  const scores = [
    { squadId: "squad-old", gameweekId: 1, points: 60, benchPoints: 5, captainPoints: 10, transferCost: 0 },
    { squadId: "squad-old", gameweekId: 2, points: 45, benchPoints: 2, captainPoints: 6, transferCost: 4 },
    { squadId: "squad-new", gameweekId: 2, points: 71, benchPoints: 0, captainPoints: 14, transferCost: 0 },
    { squadId: "squad-other", gameweekId: 1, points: 40, benchPoints: 1, captainPoints: 4, transferCost: 0 },
    { squadId: "squad-other", gameweekId: 2, points: 55, benchPoints: 3, captainPoints: 12, transferCost: 0 },
  ];
  const chips = [{ squadId: "squad-old", gameweekId: 2, chipType: ChipType.BENCH_BOOST }];
  const calls = { groupBy: 0 };

  const db = {
    squad: {
      findMany: async ({ where }: any) =>
        squads
          .filter((s) => s.userId === where.userId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(({ id, name }) => ({ id, name })),
    },
    squadGameweekScore: {
      findMany: async ({ where }: any) =>
        scores
          .filter((s) => s.squadId === where.squadId)
          .map((s) => ({ ...s, gameweek: gameweeks.get(s.gameweekId) })),
      groupBy: async ({ where }: any) => {
        calls.groupBy++;
        return where.gameweekId.in.map((gameweekId: number) => {
          const rows = scores.filter((s) => s.gameweekId === gameweekId).map((s) => s.points);
          return {
            gameweekId,
            _avg: { points: rows.reduce((a, b) => a + b, 0) / rows.length },
            _max: { points: Math.max(...rows) },
          };
        });
      },
    },
    squadChipUsage: {
      findMany: async ({ where }: any) =>
        chips
          .filter((c) => c.squadId === where.squadId)
          .map((c) => ({ ...c, gameweek: { name: gameweeks.get(c.gameweekId)!.name } })),
    },
  };
  return { db: db as unknown as PrismaClient, calls };
}

describe("AnalyticsService", () => {
  it("defaults to the user's oldest squad and benchmarks against every squad", async () => {
    const { db } = createAnalyticsDb();
    const result = await new AnalyticsService(db).getUserPerformance("user-1");

    assert.equal(result.squadId, "squad-old");
    assert.deepEqual(result.squads.map((s) => s.id), ["squad-old", "squad-new"]);
    assert.deepEqual(result.history.map((h) => h.points), [60, 45]);
    // GW1 average of 60 and 40; GW2 average of 45, 71 and 55
    assert.deepEqual(result.history.map((h) => h.averagePoints), [50, 57]);
    assert.deepEqual(result.history.map((h) => h.highestPoints), [60, 71]);
    assert.equal(result.history[1].chip, ChipType.BENCH_BOOST);
    assert.equal(result.summary.totalTransferCost, 4);
  });

  it("returns the requested squad when the user owns it", async () => {
    const { db } = createAnalyticsDb();
    const result = await new AnalyticsService(db).getUserPerformance("user-1", "squad-new");
    assert.equal(result.squadId, "squad-new");
    assert.equal(result.summary.totalPoints, 71);
  });

  it("refuses to expose another user's squad", async () => {
    const { db } = createAnalyticsDb();
    await assert.rejects(
      new AnalyticsService(db).getUserPerformance("user-1", "squad-other"),
      { name: "AnalyticsNotFoundError" }
    );
  });

  it("returns an empty dashboard without querying benchmarks for a user with no squad", async () => {
    const { db, calls } = createAnalyticsDb();
    const result = await new AnalyticsService(db).getUserPerformance("user-without-squad");
    assert.equal(result.squadId, null);
    assert.deepEqual(result.squads, []);
    assert.deepEqual(result.history, []);
    assert.equal(calls.groupBy, 0);
  });
});

// ------------------------------------------------------------
// HTTP endpoint
// ------------------------------------------------------------

describe("GET /api/v1/analytics/me/performance", () => {
  let server: Server;
  let baseUrl: string;
  const token = signAccessToken({ userId: "user-1", email: "a@b.c", username: "manager" });

  before(async () => {
    const app = express();
    app.use("/api/v1/analytics", analyticsRoutes);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/analytics`;
  });

  after(() => {
    mock.restoreAll();
    server.close();
  });

  const get = (path: string, auth = true) =>
    fetch(`${baseUrl}${path}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });

  it("requires authentication", async () => {
    const res = await get("/me/performance", false);
    assert.equal(res.status, 401);
  });

  it("returns the authenticated user's analytics", async () => {
    const spy = mock.method(analyticsService, "getUserPerformance", async (userId: string, squadId?: string) => ({
      squads: [],
      squadId: squadId ?? null,
      userId,
      ...buildPerformanceAnalytics([]),
    }));

    const res = await get("/me/performance?squadId=squad-new");
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(spy.mock.calls[0].arguments, ["user-1", "squad-new"]);
    spy.mock.restore();
  });

  it("rejects a malformed squadId", async () => {
    const res = await get("/me/performance?squadId=a&squadId=b");
    assert.equal(res.status, 400);
  });

  it("maps a squad the user does not own to 404", async () => {
    const { db } = createAnalyticsDb();
    const scoped = new AnalyticsService(db);
    const spy = mock.method(analyticsService, "getUserPerformance", (userId: string, squadId?: string) =>
      scoped.getUserPerformance(userId, squadId)
    );

    const res = await get("/me/performance?squadId=squad-other");

    assert.equal(res.status, 404);
    spy.mock.restore();
  });
});
