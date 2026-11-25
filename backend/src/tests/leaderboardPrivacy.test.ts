import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { LeaderboardService } from "../services/leaderboard/leaderboardService.js";
import { managerAliasForUserId } from "../services/privacy/displayName.js";

/**
 * Compact in-memory Prisma fake for the where/orderBy subset the leaderboard
 * service issues (adapted from the helpers in leaderboard.test.ts).
 */
const OPERATORS = ["contains", "gt", "lt"];

function comparable(value: unknown): number | string {
  return value instanceof Date ? value.getTime() : (value as number | string);
}

function evaluate(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === "OR") return cond.some((c: any) => evaluate(row, c));
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if (!OPERATORS.some((op) => op in cond)) return evaluate(value, cond);
      if ("contains" in cond && !String(value).toLowerCase().includes(String(cond.contains).toLowerCase()))
        return false;
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
    findFirst: async ({ where, orderBy }: any) =>
      sortBy(rows().filter((r) => evaluate(r, where)), orderBy)[0] ?? null,
    count: async ({ where }: any) => rows().filter((r) => evaluate(r, where)).length,
  };
}

function createPrivacyLeaderboardDb() {
  const users = new Map([
    ["user-alice", { username: "alice", isAnonymous: true }],
    ["user-bob", { username: "bob", isAnonymous: false }],
    ["user-carol", { username: "carol", isAnonymous: true }],
  ]);
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
    squad("s-carol", "user-carol", "Carol City", 280, 3),
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
  ];

  const db = {
    squad: delegate(() => squads),
    squadGameweekScore: delegate(() => scores),
    gameweek: {
      findUnique: async ({ where }: any) =>
        where.id === 5 ? { id: 5, name: "Gameweek 5" } : null,
    },
  };
  return new LeaderboardService(db as unknown as PrismaClient);
}

const ALICE_ALIAS = managerAliasForUserId("user-alice");
const CAROL_ALIAS = managerAliasForUserId("user-carol");
const page = (overrides: Record<string, unknown> = {}) => ({ page: 1, pageSize: 25, ...overrides });

describe("global leaderboard anonymization (issue #511)", () => {
  it("shows the alias for anonymous managers to a signed-out viewer (overall)", async () => {
    const service = createPrivacyLeaderboardDb();
    const result = await service.getLeaderboard(page());
    const bySquad = new Map(result.entries.map((e) => [e.squadId, e.username]));
    assert.equal(bySquad.get("s-alice"), ALICE_ALIAS);
    assert.equal(bySquad.get("s-carol"), CAROL_ALIAS);
    assert.equal(bySquad.get("s-bob"), "bob");
  });

  it("shows the alias for anonymous managers to another regular user", async () => {
    const service = createPrivacyLeaderboardDb();
    const result = await service.getLeaderboard(page(), { id: "user-bob", role: "USER" });
    assert.equal(result.entries.find((e) => e.squadId === "s-alice")!.username, ALICE_ALIAS);
  });

  it("shows the real name to the anonymous manager themselves", async () => {
    const service = createPrivacyLeaderboardDb();
    const result = await service.getLeaderboard(page(), { id: "user-alice", role: "USER" });
    const bySquad = new Map(result.entries.map((e) => [e.squadId, e.username]));
    assert.equal(bySquad.get("s-alice"), "alice");
    // Other anonymous managers stay aliased for this viewer.
    assert.equal(bySquad.get("s-carol"), CAROL_ALIAS);
    assert.equal(result.entries.find((e) => e.squadId === "s-alice")!.isCurrentUser, true);
  });

  it("shows real names to a platform admin", async () => {
    const service = createPrivacyLeaderboardDb();
    const result = await service.getLeaderboard(page(), { id: "user-admin", role: "ADMIN" });
    const bySquad = new Map(result.entries.map((e) => [e.squadId, e.username]));
    assert.equal(bySquad.get("s-alice"), "alice");
    assert.equal(bySquad.get("s-carol"), "carol");
    assert.equal(bySquad.get("s-bob"), "bob");
  });

  it("still aliases for a moderator (moderators are not platform admins)", async () => {
    const service = createPrivacyLeaderboardDb();
    const result = await service.getLeaderboard(page(), { id: "user-mod", role: "MODERATOR" });
    assert.equal(result.entries.find((e) => e.squadId === "s-alice")!.username, ALICE_ALIAS);
  });

  it("accepts a bare user id and still proves 'self'", async () => {
    const service = createPrivacyLeaderboardDb();
    const result = await service.getLeaderboard(page(), "user-carol");
    const bySquad = new Map(result.entries.map((e) => [e.squadId, e.username]));
    assert.equal(bySquad.get("s-carol"), "carol");
    assert.equal(bySquad.get("s-alice"), ALICE_ALIAS);
  });

  it("masks the same way in gameweek mode, with the same deterministic alias", async () => {
    const service = createPrivacyLeaderboardDb();
    const pub = await service.getLeaderboard(page({ gameweekId: 5 }));
    const bySquad = new Map(pub.entries.map((e) => [e.squadId, e.username]));
    assert.equal(bySquad.get("s-alice"), ALICE_ALIAS);
    assert.equal(bySquad.get("s-bob"), "bob");

    const self = await service.getLeaderboard(page({ gameweekId: 5 }), { id: "user-alice", role: "USER" });
    assert.equal(self.entries.find((e) => e.squadId === "s-alice")!.username, "alice");
  });
});
