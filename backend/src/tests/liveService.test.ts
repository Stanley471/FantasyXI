import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LiveService, rankLiveStandings } from "../services/live/liveService.js";
import { MembershipStatus, Position } from "../types/index.js";
import leagueRoutes from "../routes/league.routes.js";

function squadPlayers(prefix: number) {
  const positions = [Position.GKP, Position.DEF, Position.DEF, Position.DEF, Position.MID, Position.MID, Position.MID, Position.MID, Position.FWD, Position.FWD, Position.FWD];
  return positions.map((position, i) => ({
    playerId: prefix + i,
    isStarter: true,
    isCaptain: i === 9,
    isViceCaptain: i === 4,
    positionOrder: i + 1,
    player: { position, displayName: `P${prefix + i}`, team: { shortName: "ARS" } },
  }));
}

describe("Live Matchday Feed", () => {
  it("registers the league live SSE endpoint", () => {
    const routes = (leagueRoutes as any).stack
      .map((layer: any) => layer.route?.path)
      .filter(Boolean);

    assert.ok(routes.includes("/:id/live"));
  });

  it("ranks by total points, then live points, then join time", () => {
    const base = { username: "", squadId: "", squadName: "", membershipStatus: MembershipStatus.ACTIVE, lineup: [] };
    const ranked = rankLiveStandings([
      { ...base, userId: "late", totalPoints: 100, livePoints: 20, joinedAt: new Date(3) },
      { ...base, userId: "top", totalPoints: 120, livePoints: 10, joinedAt: new Date(2) },
      { ...base, userId: "early", totalPoints: 100, livePoints: 20, joinedAt: new Date(1) },
      { ...base, userId: "less-live", totalPoints: 100, livePoints: 5, joinedAt: new Date(0) },
    ]);
    assert.deepEqual(ranked.map((r) => [r.rank, r.userId]), [[1, "top"], [2, "early"], [3, "late"], [4, "less-live"]]);
  });

  it("builds live standings with captain multipliers and completed gameweeks", async () => {
    const stats = [...squadPlayers(100), ...squadPlayers(200)].map((sp) => ({
      playerId: sp.playerId,
      minutes: 90,
      totalPoints: sp.playerId === 109 ? 10 : 2,
      goals: sp.playerId === 109 ? 1 : 0,
      assists: 0, yellowCards: 0, redCards: 0, saves: 0, bonus: 0,
      player: { displayName: `P${sp.playerId}`, team: { shortName: "ARS" } },
    }));
    const db: any = {
      league: {
        findUnique: async () => ({
          id: "L", startGameweekId: 1, endGameweekId: 5,
          members: [
            { userId: "u1", squadId: "s1", status: MembershipStatus.ACTIVE, joinedAt: new Date(1), user: { username: "alice" }, squad: { name: "A", players: squadPlayers(100) } },
            { userId: "u2", squadId: "s2", status: MembershipStatus.ACTIVE, joinedAt: new Date(2), user: { username: "bob" }, squad: { name: "B", players: squadPlayers(200) } },
          ],
        }),
      },
      gameweek: { findFirst: async () => ({ id: 3, name: "Gameweek 3" }) },
      fixture: {
        findMany: async () => [
          { id: 1, homeTeam: { shortName: "ARS" }, awayTeam: { shortName: "CHE" }, homeScore: 1, awayScore: 0, minutes: 63, started: true, finished: false, kickoffTime: null },
        ],
      },
      playerGameweekStats: { findMany: async () => stats },
      squadGameweekScore: { findMany: async () => [{ squadId: "s2", points: 40 }] },
      squadTransfer: { groupBy: async () => [{ squadId: "s1", _sum: { pointsCost: 4 } }] },
    };

    const snapshot = (await new LiveService(db).getLeagueSnapshot("L"))!;

    // alice: 10 starters * 2 + captain 10 * 2 - 4 hit = 36 live
    const alice = snapshot.standings.find((s) => s.username === "alice")!;
    assert.equal(alice.livePoints, 36);
    assert.equal(alice.totalPoints, 36);
    assert.equal(alice.lineup.find((p) => p.playerId === 109)!.multiplier, 2);

    // bob: 40 completed + (10 starters * 2 + captain 2 * 2) live
    const bob = snapshot.standings[0];
    assert.equal(bob.username, "bob");
    assert.equal(bob.livePoints, 24);
    assert.equal(bob.totalPoints, 64);

    assert.equal(snapshot.fixtures[0].minutes, 63);
    assert.deepEqual(snapshot.events.map((e) => [e.playerName, e.goals]), [["P109", 1]]);
  });

  it("returns null for an unknown league", async () => {
    const db: any = { league: { findUnique: async () => null } };
    assert.equal(await new LiveService(db).getLeagueSnapshot("missing"), null);
  });
});
