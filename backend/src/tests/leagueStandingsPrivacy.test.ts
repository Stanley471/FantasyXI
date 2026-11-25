import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LeagueService } from "../services/league/leagueService.js";
import { managerAliasForUserId } from "../services/privacy/displayName.js";

const ALICE_ALIAS = managerAliasForUserId("user-alice");
const CAROL_ALIAS = managerAliasForUserId("user-carol");

function member(
  userId: string,
  username: string,
  isAnonymous: boolean,
  squadId: string,
  squadName: string,
  extra: Record<string, unknown> = {}
) {
  return {
    id: `member-${userId}`,
    userId,
    squadId,
    user: { id: userId, username, isAnonymous },
    squad: { id: squadId, name: squadName },
    status: "ACTIVE",
    joinedAt: new Date(Date.UTC(2026, 7, userId === "user-alice" ? 1 : 2)),
    matchesWon: 2,
    matchesDrawn: 0,
    matchesLost: 0,
    pointsFor: 10,
    pointsAgainst: 5,
    h2hPoints: 6,
    ...extra,
  };
}

function createLeagueDb(scoringType: string) {
  const members = [
    member("user-alice", "alice", true, "s-alice", "Alice Athletic"),
    member("user-bob", "bob", false, "s-bob", "Bob's Ballers"),
    member("user-carol", "carol", true, "s-carol", "Carol City"),
  ];
  const league = {
    id: "league-1",
    name: "Test League",
    status: "ACTIVE",
    scoringType,
    entryFee: 0,
    prizePool: 0,
    currentMembers: 3,
    startGameweekId: 1,
    endGameweekId: 2,
    scoringConfig: null,
    startGameweek: { id: 1, name: "Gameweek 1" },
    endGameweek: { id: 2, name: "Gameweek 2" },
    members,
  };
  const db: any = {
    league: { findUnique: async () => league },
    gameweek: {
      findMany: async () => [
        { id: 1, name: "Gameweek 1" },
        { id: 2, name: "Gameweek 2" },
      ],
    },
    squadGameweekScore: {
      findMany: async () => [
        { squadId: "s-alice", gameweekId: 1, points: 50, gameweek: { id: 1, name: "Gameweek 1" } },
        { squadId: "s-bob", gameweekId: 1, points: 40, gameweek: { id: 1, name: "Gameweek 1" } },
        { squadId: "s-carol", gameweekId: 1, points: 30, gameweek: { id: 1, name: "Gameweek 1" } },
      ],
    },
    leagueMember: {
      findMany: async () => members,
      count: async () => members.length,
    },
  };
  return { service: new LeagueService(db), members };
}

describe("league standings anonymization (issue #511)", () => {
  it("shows aliases for anonymous managers to a signed-out viewer (classic standings)", async () => {
    const { service } = createLeagueDb("CLASSIC");
    const result = await service.getLeagueStandings("league-1");
    const byUser = new Map(result.standings.map((e) => [e.userId, e.username]));
    assert.equal(byUser.get("user-alice"), ALICE_ALIAS);
    assert.equal(byUser.get("user-carol"), CAROL_ALIAS);
    assert.equal(byUser.get("user-bob"), "bob");
    // Points and ranks are unaffected by masking.
    assert.equal(result.standings[0].userId, "user-alice");
    assert.equal(result.standings[0].totalPoints, 50);
  });

  it("shows the real name to the anonymous manager themselves", async () => {
    const { service } = createLeagueDb("CLASSIC");
    const result = await service.getLeagueStandings("league-1", undefined, {
      id: "user-alice",
      role: "USER",
    });
    const byUser = new Map(result.standings.map((e) => [e.userId, e.username]));
    assert.equal(byUser.get("user-alice"), "alice");
    assert.equal(byUser.get("user-carol"), CAROL_ALIAS);
  });

  it("shows real names to a platform admin", async () => {
    const { service } = createLeagueDb("CLASSIC");
    const result = await service.getLeagueStandings("league-1", undefined, {
      id: "user-admin",
      role: "ADMIN",
    });
    const byUser = new Map(result.standings.map((e) => [e.userId, e.username]));
    assert.equal(byUser.get("user-alice"), "alice");
    assert.equal(byUser.get("user-carol"), "carol");
  });

  it("masks head-to-head standings the same way", async () => {
    const { service } = createLeagueDb("HEAD_TO_HEAD");
    const pub = await service.getH2HStandings("league-1");
    const byUser = new Map(pub.map((e) => [e.userId, e.username]));
    assert.equal(byUser.get("user-alice"), ALICE_ALIAS);
    assert.equal(byUser.get("user-bob"), "bob");

    const self = await service.getH2HStandings("league-1", { id: "user-carol", role: "USER" });
    assert.equal(self.find((e) => e.userId === "user-carol")!.username, "carol");
    assert.equal(self.find((e) => e.userId === "user-alice")!.username, ALICE_ALIAS);
  });

  it("masks the public member list the same way", async () => {
    const { service } = createLeagueDb("CLASSIC");
    const pub = await service.getLeagueMembers("league-1", 1, 50);
    const byId = new Map(pub.members.map((m: any) => [m.user.id, m.user.username]));
    assert.equal(byId.get("user-alice"), ALICE_ALIAS);
    assert.equal(byId.get("user-bob"), "bob");

    const admin = await service.getLeagueMembers("league-1", 1, 50, { id: "user-admin", role: "ADMIN" });
    assert.equal(admin.members.find((m: any) => m.user.id === "user-alice")!.user.username, "alice");
  });
});
