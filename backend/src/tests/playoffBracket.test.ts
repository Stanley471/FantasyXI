import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LeagueService, LeagueValidationError, LeagueNotFoundError } from "../services/league/leagueService.js";
import { ScoringType, MembershipStatus } from "../types/index.js";

describe("H2H Playoffs — bracket sizing and seeding", () => {
  it("picks the largest power-of-two bracket up to 8 that the member count allows", () => {
    assert.equal(LeagueService.computeBracketSize(1), 0);
    assert.equal(LeagueService.computeBracketSize(2), 2);
    assert.equal(LeagueService.computeBracketSize(3), 2);
    assert.equal(LeagueService.computeBracketSize(4), 4);
    assert.equal(LeagueService.computeBracketSize(7), 4);
    assert.equal(LeagueService.computeBracketSize(8), 8);
    assert.equal(LeagueService.computeBracketSize(20), 8);
  });

  it("seeds round 1 so the top seed meets the bottom seed", () => {
    const pairings = LeagueService.seedPlayoffPairings(["s1", "s2", "s3", "s4"]);
    assert.deepEqual(pairings, [
      { homeMemberId: "s1", awayMemberId: "s4" },
      { homeMemberId: "s2", awayMemberId: "s3" },
    ]);
  });

  it("reduces a single pair straight to a final", () => {
    assert.deepEqual(LeagueService.seedPlayoffPairings(["a", "b"]), [
      { homeMemberId: "a", awayMemberId: "b" },
    ]);
  });
});

function createMockDb(overrides: any = {}) {
  const state = {
    league: overrides.league,
    members: overrides.members || [],
    fixtures: overrides.fixtures || [],
  };
  const db: any = {
    league: {
      findUnique: async () => state.league,
    },
    leagueMember: {
      findMany: async () => state.members,
    },
    leagueFixture: {
      deleteMany: async ({ where }: any) => {
        const before = state.fixtures.length;
        state.fixtures = state.fixtures.filter(
          (f: any) => !(f.leagueId === where.leagueId && f.gameweekId === where.gameweekId && f.isFinished === where.isFinished)
        );
        return { count: before - state.fixtures.length };
      },
      createMany: async ({ data }: any) => {
        state.fixtures.push(
          ...data.map((d: any, idx: number) => ({ id: `fx_${state.fixtures.length + idx}`, isFinished: false, homeScore: null, awayScore: null, ...d }))
        );
        return { count: data.length };
      },
      findMany: async ({ where }: any) =>
        state.fixtures.filter(
          (f: any) =>
            f.leagueId === where.leagueId &&
            f.gameweekId === where.gameweekId &&
            (where.isPlayoff === undefined || f.isPlayoff === where.isPlayoff)
        ),
    },
    $transaction: async (fn: any) => fn(db),
    state,
  };
  return db;
}

function member(id: string, h2hPoints: number, pointsFor = 0) {
  return {
    id,
    userId: `u_${id}`,
    status: MembershipStatus.ACTIVE,
    matchesWon: 0,
    matchesDrawn: 0,
    matchesLost: 0,
    pointsFor,
    pointsAgainst: 0,
    h2hPoints,
    user: { username: id },
    squad: { name: `Squad ${id}` },
  };
}

describe("H2H Playoffs — generatePlayoffBracket", () => {
  it("qualifies the top 4 members and schedules the semi-final two gameweeks from the end", async () => {
    const league = { id: "L", scoringType: ScoringType.HEAD_TO_HEAD, endGameweekId: 38 };
    const members = [
      member("m1", 30), member("m2", 27), member("m3", 24), member("m4", 21),
      member("m5", 18), member("m6", 15),
    ];
    const db = createMockDb({ league: { ...league, members }, members });
    const service = new LeagueService(db);

    const result = await service.generatePlayoffBracket("L");

    assert.equal(result.bracketSize, 4);
    assert.equal(result.round, 1);
    assert.equal(result.gameweekId, 37); // 38 - log2(4) + 1
    assert.deepEqual(result.pairings, [
      { homeMemberId: "m1", awayMemberId: "m4" },
      { homeMemberId: "m2", awayMemberId: "m3" },
    ]);
    assert.equal(db.state.fixtures.length, 2);
    assert.ok(db.state.fixtures.every((f: any) => f.isPlayoff && f.playoffRound === 1));
  });

  it("replaces any unfinished regular-season fixture already on the playoff gameweek", async () => {
    const league = { id: "L", scoringType: ScoringType.HEAD_TO_HEAD, endGameweekId: 38 };
    const members = [member("m1", 10), member("m2", 8)];
    const staleFixture = { id: "stale", leagueId: "L", gameweekId: 38, homeMemberId: "m1", awayMemberId: "m2", isFinished: false, isPlayoff: false };
    const db = createMockDb({ league: { ...league, members }, members, fixtures: [staleFixture] });
    const service = new LeagueService(db);

    await service.generatePlayoffBracket("L");

    assert.equal(db.state.fixtures.length, 1);
    assert.equal(db.state.fixtures[0].isPlayoff, true);
  });

  it("rejects a bracket for fewer than 2 members", async () => {
    const league = { id: "L", scoringType: ScoringType.HEAD_TO_HEAD, endGameweekId: 38 };
    const members = [member("m1", 10)];
    const db = createMockDb({ league: { ...league, members }, members });
    const service = new LeagueService(db);

    await assert.rejects(() => service.generatePlayoffBracket("L"), LeagueValidationError);
  });

  it("rejects a classic (non-H2H) league", async () => {
    const db = createMockDb({ league: { id: "L", scoringType: ScoringType.CLASSIC, endGameweekId: 38, members: [] } });
    const service = new LeagueService(db);
    await assert.rejects(() => service.generatePlayoffBracket("L"), LeagueValidationError);
  });

  it("throws LeagueNotFoundError for an unknown league", async () => {
    const db = createMockDb({ league: null });
    const service = new LeagueService(db);
    await assert.rejects(() => service.generatePlayoffBracket("missing"), LeagueNotFoundError);
  });
});

describe("H2H Playoffs — advancePlayoffRound", () => {
  it("pairs semi-final winners into the final on the next gameweek", async () => {
    const fixtures = [
      { id: "f1", leagueId: "L", gameweekId: 37, homeMemberId: "m1", awayMemberId: "m4", homeScore: 60, awayScore: 40, isFinished: true, isPlayoff: true, playoffRound: 1, playoffSlot: 0 },
      { id: "f2", leagueId: "L", gameweekId: 37, homeMemberId: "m2", awayMemberId: "m3", homeScore: 50, awayScore: 55, isFinished: true, isPlayoff: true, playoffRound: 1, playoffSlot: 1 },
    ];
    const db = createMockDb({ fixtures });
    const service = new LeagueService(db);

    const result: any = await service.advancePlayoffRound("L", 37);

    assert.equal(result.gameweekId, 38);
    assert.equal(result.round, 2);
    assert.deepEqual(result.pairings, [{ homeMemberId: "m1", awayMemberId: "m3" }]);
  });

  it("crowns a champion once the final has been settled", async () => {
    const fixtures = [
      { id: "final", leagueId: "L", gameweekId: 38, homeMemberId: "m1", awayMemberId: "m3", homeScore: 45, awayScore: 60, isFinished: true, isPlayoff: true, playoffRound: 2, playoffSlot: 0 },
    ];
    const db = createMockDb({ fixtures });
    const service = new LeagueService(db);

    const result: any = await service.advancePlayoffRound("L", 38);

    assert.deepEqual(result, { champion: "m3" });
  });

  it("awards a drawn final to the home slot (the better original seed)", async () => {
    const fixtures = [
      { id: "final", leagueId: "L", gameweekId: 38, homeMemberId: "m1", awayMemberId: "m3", homeScore: 50, awayScore: 50, isFinished: true, isPlayoff: true, playoffRound: 2, playoffSlot: 0 },
    ];
    const db = createMockDb({ fixtures });
    const service = new LeagueService(db);

    const result: any = await service.advancePlayoffRound("L", 38);
    assert.deepEqual(result, { champion: "m1" });
  });

  it("refuses to advance while a fixture in the round is still unsettled", async () => {
    const fixtures = [
      { id: "f1", leagueId: "L", gameweekId: 37, homeMemberId: "m1", awayMemberId: "m4", homeScore: 60, awayScore: 40, isFinished: true, isPlayoff: true, playoffRound: 1, playoffSlot: 0 },
      { id: "f2", leagueId: "L", gameweekId: 37, homeMemberId: "m2", awayMemberId: "m3", homeScore: null, awayScore: null, isFinished: false, isPlayoff: true, playoffRound: 1, playoffSlot: 1 },
    ];
    const db = createMockDb({ fixtures });
    const service = new LeagueService(db);

    await assert.rejects(() => service.advancePlayoffRound("L", 37), LeagueValidationError);
  });

  it("throws when no playoff fixtures exist for the given gameweek", async () => {
    const db = createMockDb({ fixtures: [] });
    const service = new LeagueService(db);
    await assert.rejects(() => service.advancePlayoffRound("L", 37), LeagueValidationError);
  });
});
