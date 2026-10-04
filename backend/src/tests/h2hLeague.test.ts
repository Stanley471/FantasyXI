import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LeagueService, H2HPairing } from "../services/league/leagueService.js";
import { ScoringService } from "../services/scoring/scoringService.js";
import { MembershipStatus } from "../types/index.js";

function pairKey(p: H2HPairing): string {
  return [p.homeMemberId, p.awayMemberId ?? "AVERAGE"].sort().join("|");
}

function assertEachPlaysOncePerGameweek(pairings: H2HPairing[], members: string[]) {
  const byGw = new Map<number, H2HPairing[]>();
  for (const p of pairings) {
    byGw.set(p.gameweekId, [...(byGw.get(p.gameweekId) || []), p]);
  }
  for (const [gw, games] of byGw) {
    const seen = games.flatMap((g) => [g.homeMemberId, g.awayMemberId]).filter(Boolean);
    assert.deepEqual([...seen].sort(), [...members].sort(), `gameweek ${gw}`);
  }
}

describe("H2H League Engine — Round-Robin Scheduler", () => {
  it("schedules every pair exactly once over n-1 gameweeks for an even member count", () => {
    const members = ["a", "b", "c", "d"];
    const pairings = LeagueService.generateRoundRobinSchedule(members, [1, 2, 3]);

    assert.equal(pairings.length, 6);
    assert.equal(new Set(pairings.map(pairKey)).size, 6);
    assert.ok(pairings.every((p) => p.awayMemberId !== null));
    assertEachPlaysOncePerGameweek(pairings, members);
  });

  it("adds an 'Average' opponent for an odd member count", () => {
    const members = ["a", "b", "c", "d", "e"];
    const gameweeks = [1, 2, 3, 4, 5];
    const pairings = LeagueService.generateRoundRobinSchedule(members, gameweeks);

    // 6 slots (5 + Average) -> 3 matches per gameweek
    assert.equal(pairings.length, 15);
    // Every pair (incl. vs Average) meets exactly once in the cycle
    assert.equal(new Set(pairings.map(pairKey)).size, 15);
    assertEachPlaysOncePerGameweek(pairings, members);

    // One member per gameweek faces the Average team, always as home side
    for (const gw of gameweeks) {
      const vsAverage = pairings.filter((p) => p.gameweekId === gw && p.awayMemberId === null);
      assert.equal(vsAverage.length, 1);
    }
    const averageOpponents = pairings.filter((p) => p.awayMemberId === null).map((p) => p.homeMemberId);
    assert.deepEqual([...averageOpponents].sort(), members);
  });

  it("repeats the cycle with home and away reversed when gameweeks exceed rounds", () => {
    const pairings = LeagueService.generateRoundRobinSchedule(["a", "b"], [1, 2]);
    assert.deepEqual(
      pairings.map((p) => [p.homeMemberId, p.awayMemberId]),
      [["a", "b"], ["b", "a"]]
    );
  });

  it("returns no fixtures for fewer than two members", () => {
    assert.deepEqual(LeagueService.generateRoundRobinSchedule(["a"], [1, 2]), []);
    assert.deepEqual(LeagueService.generateRoundRobinSchedule([], [1]), []);
  });
});

describe("H2H League Engine — Match Resolution & Standings", () => {
  it("awards 3 points for a win, 1 for a draw, 0 for a loss", () => {
    assert.deepEqual(ScoringService.resolveHeadToHead(60, 45), { homePoints: 3, awayPoints: 0 });
    assert.deepEqual(ScoringService.resolveHeadToHead(40, 52), { homePoints: 0, awayPoints: 3 });
    assert.deepEqual(ScoringService.resolveHeadToHead(50, 50), { homePoints: 1, awayPoints: 1 });
  });

  it("orders the table by h2hPoints, then pointsFor, then pointsDifference", () => {
    const base = { userId: "u", username: "", squadName: "", matchesWon: 0, matchesDrawn: 0, matchesLost: 0 };
    const table = LeagueService.sortH2HStandings([
      { ...base, memberId: "low", h2hPoints: 3, pointsFor: 200, pointsAgainst: 100 },
      { ...base, memberId: "diff-worse", h2hPoints: 6, pointsFor: 150, pointsAgainst: 140 },
      { ...base, memberId: "top", h2hPoints: 9, pointsFor: 100, pointsAgainst: 100 },
      { ...base, memberId: "diff-better", h2hPoints: 6, pointsFor: 150, pointsAgainst: 120 },
      { ...base, memberId: "more-for", h2hPoints: 6, pointsFor: 160, pointsAgainst: 200 },
    ]);

    assert.deepEqual(
      table.map((r) => [r.rank, r.memberId]),
      [[1, "top"], [2, "more-for"], [3, "diff-better"], [4, "diff-worse"], [5, "low"]]
    );
    assert.equal(table[2].pointsDifference, 30);
  });

  it("flags repeated losses far below a member's baseline against a near-baseline opponent", async () => {
    const fixtures = [
      { gameweekId: 3, homeMemberId: "a", awayMemberId: "b", homeScore: 25, awayScore: 70 },
      { gameweekId: 4, homeMemberId: "b", awayMemberId: "a", homeScore: 72, awayScore: 25 },
    ];
    const service = new LeagueService({
      leagueFixture: { findMany: async () => fixtures },
      leagueMember: {
        findMany: async () => [
          { id: "a", squadId: "sa" },
          { id: "b", squadId: "sb" },
        ],
      },
      squadGameweekScore: {
        findMany: async () => [
          { squadId: "sa", gameweekId: 1, points: 70 },
          { squadId: "sa", gameweekId: 2, points: 70 },
          { squadId: "sa", gameweekId: 3, points: 25 },
          { squadId: "sa", gameweekId: 4, points: 25 },
          { squadId: "sb", gameweekId: 1, points: 68 },
          { squadId: "sb", gameweekId: 2, points: 72 },
          { squadId: "sb", gameweekId: 3, points: 70 },
          { squadId: "sb", gameweekId: 4, points: 72 },
        ],
      },
    });

    const reports = await service.detectH2HAnomalies("league");

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].memberIds, ["a", "b"]);
    assert.deepEqual(
      reports[0].suspiciousGameweeks.map((match) => match.gameweekId),
      [3, 4]
    );
  });

  it("settles a gameweek: updates member stats, fixture scores and ranks", async () => {
    const members = new Map<string, any>(
      [
        { id: "m1", squadId: "s1", userId: "u1" },
        { id: "m2", squadId: "s2", userId: "u2" },
        { id: "m3", squadId: "s3", userId: "u3" },
      ].map((m) => [
        m.id,
        { ...m, status: MembershipStatus.ACTIVE, matchesWon: 0, matchesDrawn: 0, matchesLost: 0, pointsFor: 0, pointsAgainst: 0, h2hPoints: 0, rank: null },
      ])
    );
    const fixtures: any[] = [
      { id: "f1", leagueId: "L", gameweekId: 1, homeMemberId: "m1", awayMemberId: "m2", isFinished: false },
      { id: "f2", leagueId: "L", gameweekId: 1, homeMemberId: "m3", awayMemberId: null, isFinished: false },
    ];
    const scores = [
      { squadId: "s1", points: 70 },
      { squadId: "s2", points: 50 },
      { squadId: "s3", points: 60 },
    ];

    const db: any = {
      leagueFixture: {
        findMany: async ({ where }: any) => fixtures.filter((f) => f.isFinished === where.isFinished),
        update: async ({ where, data }: any) => Object.assign(fixtures.find((f) => f.id === where.id)!, data),
      },
      leagueMember: {
        findMany: async () => [...members.values()],
        update: async ({ where, data }: any) => {
          const m = members.get(where.id);
          for (const [key, value] of Object.entries<any>(data)) {
            m[key] = typeof value === "object" ? m[key] + value.increment : value;
          }
        },
      },
      squadGameweekScore: { findMany: async () => scores },
      $transaction: async (fn: any) => fn(db),
    };

    const service = new LeagueService(db);
    assert.deepEqual(await service.settleH2HGameweek("L", 1), { settled: 2 });

    // m1 beat m2 70-50; m3 drew with Average (mean of 70, 50, 60 = 60)
    const m1 = members.get("m1"), m2 = members.get("m2"), m3 = members.get("m3");
    assert.deepEqual([m1.h2hPoints, m1.matchesWon, m1.pointsFor, m1.pointsAgainst], [3, 1, 70, 50]);
    assert.deepEqual([m2.h2hPoints, m2.matchesLost, m2.pointsFor, m2.pointsAgainst], [0, 1, 50, 70]);
    assert.deepEqual([m3.h2hPoints, m3.matchesDrawn, m3.pointsFor, m3.pointsAgainst], [1, 1, 60, 60]);
    assert.deepEqual(fixtures.map((f) => [f.homeScore, f.awayScore, f.isFinished]), [[70, 50, true], [60, 60, true]]);
    assert.deepEqual([m1.rank, m3.rank, m2.rank], [1, 2, 3]);

    // Re-running does not double count
    assert.deepEqual(await service.settleH2HGameweek("L", 1), { settled: 0 });
    assert.equal(m1.h2hPoints, 3);
  });
});
