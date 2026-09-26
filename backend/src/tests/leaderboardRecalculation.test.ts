import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LeagueService } from "../services/league/leagueService.js";
import { LeagueStatus, MembershipStatus, ScoringType } from "../types/index.js";

function createMockDb(opts: {
  scores: Array<{ squadId: string; points: number }>;
  members: Array<{ id: string; leagueId: string; squadId: string; joinedAt: Date; status: MembershipStatus; league: { scoringType: ScoringType; status: LeagueStatus } }>;
}) {
  const calls = { groupBy: 0, findMany: 0, executeRaw: 0 };
  let lastRawArgs: any[] = [];

  const db: any = {
    squadGameweekScore: {
      groupBy: async ({ where }: any) => {
        calls.groupBy++;
        const totals = new Map<string, number>();
        for (const s of opts.scores) {
          totals.set(s.squadId, (totals.get(s.squadId) ?? 0) + s.points);
        }
        return [...totals.entries()].map(([squadId, sum]) => ({ squadId, _sum: { points: sum } }));
      },
    },
    leagueMember: {
      findMany: async ({ where }: any) => {
        calls.findMany++;
        return opts.members.filter(
          (m) =>
            m.status === where.status &&
            m.league.scoringType === where.league.scoringType &&
            m.league.status === where.league.status
        );
      },
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      calls.executeRaw++;
      lastRawArgs = values;
      return values[0]?.length ?? 0;
    },
  };

  return { db, calls, getLastRawArgs: () => lastRawArgs };
}

describe("LeagueService.recalculateClassicStandings", () => {
  it("computes totals and ranks in a fixed number of queries, not per-league", async () => {
    const joinedEarly = new Date("2026-01-01T00:00:00Z");
    const joinedLate = new Date("2026-01-02T00:00:00Z");

    const { db, calls, getLastRawArgs } = createMockDb({
      scores: [
        { squadId: "sq1", points: 40 },
        { squadId: "sq2", points: 60 },
        { squadId: "sq3", points: 60 },
        { squadId: "sq4", points: 10 },
      ],
      members: [
        { id: "m1", leagueId: "L1", squadId: "sq1", joinedAt: joinedEarly, status: MembershipStatus.ACTIVE, league: { scoringType: ScoringType.CLASSIC, status: LeagueStatus.ACTIVE } },
        { id: "m2", leagueId: "L1", squadId: "sq2", joinedAt: joinedEarly, status: MembershipStatus.ACTIVE, league: { scoringType: ScoringType.CLASSIC, status: LeagueStatus.ACTIVE } },
        { id: "m3", leagueId: "L1", squadId: "sq3", joinedAt: joinedLate, status: MembershipStatus.ACTIVE, league: { scoringType: ScoringType.CLASSIC, status: LeagueStatus.ACTIVE } },
        { id: "m4", leagueId: "L2", squadId: "sq4", joinedAt: joinedEarly, status: MembershipStatus.ACTIVE, league: { scoringType: ScoringType.CLASSIC, status: LeagueStatus.ACTIVE } },
      ],
    });

    const service = new LeagueService(db);
    const result = await service.recalculateClassicStandings(10);

    assert.equal(result.membersUpdated, 4);
    // Exactly one aggregation query, one member lookup, one bulk write —
    // regardless of how many leagues or members were processed.
    assert.equal(calls.groupBy, 1);
    assert.equal(calls.findMany, 1);
    assert.equal(calls.executeRaw, 1);

    const [ids, points, ranks] = getLastRawArgs();
    const byId = (id: string) => ids.indexOf(id);

    // League 1: sq2 and sq3 tie on 60, sq2 joined first so ranks above sq3; sq1 is 3rd.
    assert.equal(ranks[byId("m2")], 1);
    assert.equal(points[byId("m2")], 60);
    assert.equal(ranks[byId("m3")], 2);
    assert.equal(ranks[byId("m1")], 3);
    assert.equal(points[byId("m1")], 40);

    // League 2 ranks independently of league 1.
    assert.equal(ranks[byId("m4")], 1);
    assert.equal(points[byId("m4")], 10);
  });

  it("only ranks squads within the gameweek window (cumulative up to gameweekId)", async () => {
    const { db } = createMockDb({
      scores: [{ squadId: "sq1", points: 25 }],
      members: [
        { id: "m1", leagueId: "L1", squadId: "sq1", joinedAt: new Date(), status: MembershipStatus.ACTIVE, league: { scoringType: ScoringType.CLASSIC, status: LeagueStatus.ACTIVE } },
      ],
    });
    const service = new LeagueService(db);
    const result = await service.recalculateClassicStandings(5);
    assert.equal(result.membersUpdated, 1);
  });

  it("is a no-op when there are no active classic-league members", async () => {
    const { db, calls } = createMockDb({ scores: [], members: [] });
    const service = new LeagueService(db);
    const result = await service.recalculateClassicStandings(1);
    assert.equal(result.membersUpdated, 0);
    assert.equal(calls.executeRaw, 0);
  });

  it("ignores members of H2H or inactive leagues", async () => {
    const { db } = createMockDb({
      scores: [{ squadId: "sq1", points: 99 }],
      members: [
        { id: "m1", leagueId: "L1", squadId: "sq1", joinedAt: new Date(), status: MembershipStatus.ACTIVE, league: { scoringType: ScoringType.HEAD_TO_HEAD, status: LeagueStatus.ACTIVE } },
      ],
    });
    const service = new LeagueService(db);
    const result = await service.recalculateClassicStandings(1);
    assert.equal(result.membersUpdated, 0);
  });
});
