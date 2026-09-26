import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { PrismaClient } from "@prisma/client";
import {
  assignCompetitionRanks,
  LeaderboardService,
  leaderboardService,
} from "../services/leaderboard/leaderboardService.js";
import leaderboardRoutes from "../routes/leaderboard.routes.js";
import { signAccessToken } from "../config/jwt.js";

// ------------------------------------------------------------
// In-memory Prisma fake for the where/orderBy subset the leaderboard uses
// ------------------------------------------------------------

const OPERATORS = ["contains", "gt", "lt"];

function comparable(value: unknown): any {
  return value instanceof Date ? value.getTime() : value;
}

function evaluate(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === "OR") return cond.some((c: any) => evaluate(row, c));
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if (!OPERATORS.some((op) => op in cond)) return evaluate(value, cond); // relation filter
      if ("contains" in cond && !String(value).toLowerCase().includes(cond.contains.toLowerCase())) return false;
      if ("gt" in cond && !(comparable(value) > comparable(cond.gt))) return false;
      if ("lt" in cond && !(comparable(value) < comparable(cond.lt))) return false;
      return true;
    }
    return comparable(value) === comparable(cond);
  });
}

function sortBy(rows: any[], orderBy: any[]) {
  const path = (row: any, spec: any): [unknown, string] => {
    const [key, dir] = Object.entries(spec)[0] as [string, any];
    return typeof dir === "object" ? path(row[key], dir) : [comparable(row[key]), dir];
  };
  return [...rows].sort((a, b) => {
    for (const spec of orderBy) {
      const [av, dir] = path(a, spec);
      const [bv] = path(b, spec);
      if (av !== bv) return ((av as any) < (bv as any) ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

function delegate(rows: () => any[]) {
  return {
    findMany: async ({ where, orderBy, skip = 0, take }: any) =>
      sortBy(rows().filter((r) => evaluate(r, where)), orderBy).slice(skip, take ? skip + take : undefined),
    findFirst: async ({ where, orderBy }: any) => sortBy(rows().filter((r) => evaluate(r, where)), orderBy)[0] ?? null,
    count: async ({ where }: any) => rows().filter((r) => evaluate(r, where)).length,
  };
}

function createLeaderboardDb() {
  const users = new Map(
    ["alice", "bob", "carol", "dave", "erin", "frank"].map((name) => [`user-${name}`, { username: name }])
  );
  const squad = (id: string, userId: string, name: string, totalPoints: number, day: number) => ({
    id,
    userId,
    name,
    totalPoints,
    createdAt: new Date(Date.UTC(2026, 7, day)),
    user: users.get(userId)!,
  });
  const squads = [
    squad("s-alice", "user-alice", "Alice Athletic", 310, 1),
    squad("s-bob", "user-bob", "Bob's Ballers", 295, 2),
    squad("s-carol", "user-carol", "Carol City", 295, 3),
    squad("s-dave", "user-dave", "Dave Dynamo", 280, 4),
    squad("s-erin", "user-erin", "Erin Rovers", 280, 5),
    squad("s-frank", "user-frank", "Frank FC", 150, 6),
    squad("s-alice-2", "user-alice", "Alice Reserves", 120, 7),
  ];
  const byId = new Map(squads.map((s) => [s.id, s]));
  const score = (id: number, gameweekId: number, squadId: string, points: number) => ({
    id,
    gameweekId,
    points,
    squad: byId.get(squadId)!,
  });
  const scores = [
    score(1, 5, "s-alice", 48),
    score(2, 5, "s-bob", 91),
    score(3, 5, "s-carol", 67),
    score(4, 5, "s-dave", 67),
    score(5, 5, "s-frank", 30),
    score(6, 6, "s-alice", 70),
  ];

  const db = {
    squad: delegate(() => squads),
    squadGameweekScore: delegate(() => scores),
    gameweek: {
      findUnique: async ({ where }: any) =>
        [5, 6].includes(where.id) ? { id: where.id, name: `Gameweek ${where.id}` } : null,
    },
  };
  return new LeaderboardService(db as unknown as PrismaClient);
}

const page = (overrides: Partial<{ page: number; pageSize: number; search: string; gameweekId: number }> = {}) => ({
  page: 1,
  pageSize: 25,
  ...overrides,
});

describe("Leaderboard query parsing", () => {
  it("applies defaults", () => {
    assert.deepEqual(LeaderboardService.parseQuery({}), {
      page: 1,
      pageSize: 25,
      search: undefined,
      gameweekId: undefined,
    });
  });

  it("parses and trims valid values", () => {
    assert.deepEqual(LeaderboardService.parseQuery({ page: "3", pageSize: "50", q: "  alice ", gameweekId: "5" }), {
      page: 3,
      pageSize: 50,
      search: "alice",
      gameweekId: 5,
    });
    assert.equal(LeaderboardService.parseQuery({ q: "   " }).search, undefined);
  });

  it("rejects invalid values", () => {
    for (const raw of [
      { page: "0" },
      { page: "-1" },
      { page: "1.5" },
      { page: "abc" },
      { pageSize: "101" },
      { gameweekId: "x" },
      { q: ["a", "b"] },
      { q: "x".repeat(51) },
    ]) {
      assert.throws(() => LeaderboardService.parseQuery(raw), { name: "LeaderboardValidationError" }, JSON.stringify(raw));
    }
  });
});

describe("Competition ranking", () => {
  const noCount = async () => assert.fail("no count query expected");

  it("shares ranks on equal points and skips the following rank", async () => {
    assert.deepEqual(await assignCompetitionRanks([90, 80, 80, 70, 70, 70, 10], 0, true, noCount), [1, 2, 2, 4, 4, 4, 7]);
  });

  it("carries a tie across a page boundary", async () => {
    // Page 2 (offset 3) starts with 80 points; 1 squad above it overall
    const ranks = await assignCompetitionRanks([80, 80, 60], 3, true, async (p) => (p === 80 ? 1 : 0));
    assert.deepEqual(ranks, [2, 2, 6]);
  });

  it("ranks filtered rows against the whole leaderboard, once per distinct score", async () => {
    const queried: number[] = [];
    const ranks = await assignCompetitionRanks([70, 70, 20], 0, false, async (p) => {
      queried.push(p);
      return p === 70 ? 12 : 40;
    });
    assert.deepEqual(ranks, [13, 13, 41]);
    assert.deepEqual(queried, [70, 20]);
  });

  it("returns no ranks for an empty page", async () => {
    assert.deepEqual(await assignCompetitionRanks([], 0, true, noCount), []);
  });
});

describe("LeaderboardService — season standings", () => {
  it("orders by points, then earliest squad, with shared competition ranks", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page());
    assert.equal(result.mode, "overall");
    assert.deepEqual(
      result.entries.map((e) => [e.rank, e.squadId, e.points]),
      [
        [1, "s-alice", 310],
        [2, "s-bob", 295],
        [2, "s-carol", 295],
        [4, "s-dave", 280],
        [4, "s-erin", 280],
        [6, "s-frank", 150],
        [7, "s-alice-2", 120],
      ]
    );
    assert.equal(result.total, 7);
    assert.equal(result.totalPages, 1);
    assert.equal(result.viewer, null);
  });

  it("paginates and keeps ties across pages", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page({ page: 2, pageSize: 2 }));
    assert.deepEqual(result.entries.map((e) => [e.rank, e.squadId]), [
      [2, "s-carol"],
      [4, "s-dave"],
    ]);
    assert.equal(result.totalPages, 4);
  });

  it("returns an empty page beyond the last one", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page({ page: 9, pageSize: 5 }));
    assert.deepEqual(result.entries, []);
    assert.equal(result.total, 7);
  });

  it("searches squad and manager names case-insensitively while keeping global ranks", async () => {
    const service = createLeaderboardDb();
    const byManager = await service.getLeaderboard(page({ search: "ERIN" }));
    assert.deepEqual(byManager.entries.map((e) => [e.rank, e.username]), [[4, "erin"]]);

    const bySquad = await service.getLeaderboard(page({ search: "city" }));
    assert.deepEqual(bySquad.entries.map((e) => [e.rank, e.squadName]), [[2, "Carol City"]]);
    assert.equal(bySquad.total, 1);
  });

  it("flags the viewer's squads and reports their best position", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page({ pageSize: 2 }), "user-erin");
    assert.deepEqual(result.viewer, { rank: 4, page: 3, squadId: "s-erin", points: 280 });
    assert.ok(result.entries.every((e) => !e.isCurrentUser));

    const all = await createLeaderboardDb().getLeaderboard(page(), "user-alice");
    assert.deepEqual(all.entries.filter((e) => e.isCurrentUser).map((e) => e.squadId), ["s-alice", "s-alice-2"]);
    assert.deepEqual(all.viewer, { rank: 1, page: 1, squadId: "s-alice", points: 310 });
  });

  it("reports no viewer position for a signed-in user without a squad", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page(), "user-nobody");
    assert.equal(result.viewer, null);
  });
});

describe("LeaderboardService — gameweek standings", () => {
  it("ranks squads by points scored in the gameweek", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page({ gameweekId: 5 }), "user-dave");
    assert.equal(result.mode, "gameweek");
    assert.deepEqual(result.gameweek, { id: 5, name: "Gameweek 5" });
    assert.deepEqual(
      result.entries.map((e) => [e.rank, e.squadId, e.points]),
      [
        [1, "s-bob", 91],
        [2, "s-carol", 67],
        [2, "s-dave", 67],
        [4, "s-alice", 48],
        [5, "s-frank", 30],
      ]
    );
    assert.deepEqual(result.viewer, { rank: 2, page: 1, squadId: "s-dave", points: 67 });
    assert.equal(result.entries.find((e) => e.squadId === "s-dave")?.isCurrentUser, true);
  });

  it("only includes squads that were scored in that gameweek", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page({ gameweekId: 6 }), "user-erin");
    assert.deepEqual(result.entries.map((e) => e.squadId), ["s-alice"]);
    assert.equal(result.viewer, null);
  });

  it("searches within a gameweek with global gameweek ranks", async () => {
    const result = await createLeaderboardDb().getLeaderboard(page({ gameweekId: 5, search: "dave" }));
    assert.deepEqual(result.entries.map((e) => [e.rank, e.squadId]), [[2, "s-dave"]]);
  });

  it("rejects an unknown gameweek", async () => {
    await assert.rejects(createLeaderboardDb().getLeaderboard(page({ gameweekId: 99 })), {
      name: "LeaderboardNotFoundError",
    });
  });
});

describe("GET /api/v1/leaderboard", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use("/api/v1/leaderboard", leaderboardRoutes);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/leaderboard`;
  });

  after(() => {
    mock.restoreAll();
    server.close();
  });

  function stubWith(service: LeaderboardService) {
    return mock.method(leaderboardService, "getLeaderboard", (query: any, viewerId?: string) =>
      service.getLeaderboard(query, viewerId)
    );
  }

  it("serves the leaderboard publicly with pagination metadata", async () => {
    const spy = stubWith(createLeaderboardDb());
    const res = await fetch(`${baseUrl}?page=1&pageSize=3`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.mode, "overall");
    assert.equal(body.data.entries.length, 3);
    assert.equal(body.data.viewer, null);
    assert.deepEqual(body.meta, { total: 7, page: 1, pageSize: 3, totalPages: 3 });
    spy.mock.restore();
  });

  it("includes the signed-in viewer's position", async () => {
    const spy = stubWith(createLeaderboardDb());
    const token = signAccessToken({ userId: "user-frank", email: "f@x.io", username: "frank" });
    const res = await fetch(baseUrl, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();

    assert.equal(body.data.viewer.rank, 6);
    assert.equal(spy.mock.calls[0].arguments[1], "user-frank");
    spy.mock.restore();
  });

  it("rejects invalid query parameters", async () => {
    const res = await fetch(`${baseUrl}?pageSize=500`);
    assert.equal(res.status, 400);
  });

  it("returns 404 for an unknown gameweek", async () => {
    const spy = stubWith(createLeaderboardDb());
    const res = await fetch(`${baseUrl}?gameweekId=99`);
    assert.equal(res.status, 404);
    spy.mock.restore();
  });
});
