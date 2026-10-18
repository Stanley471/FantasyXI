import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SeasonRolloverConflictError,
  SeasonRolloverError,
  SeasonRolloverForbiddenError,
  SeasonRolloverService,
} from "../services/league/seasonRolloverService.js";
import { createInMemoryPrisma } from "./helpers/inMemoryPrisma.js";

const DAY = 24 * 60 * 60 * 1000;
const CREATOR = "u01";

function memberId(i: number) {
  return `mem${String(i).padStart(2, "0")}`;
}
function userId(i: number) {
  return `u${String(i).padStart(2, "0")}`;
}

/**
 * A finished 20-team private league over gameweeks 1-5 with the next window
 * (gameweeks 6-10) still in the future. Member N scores 50 + N points every
 * gameweek, so member 20 wins, then 19, 18...
 */
function seasonDb(options: { teams?: number; scoringType?: string; entryFee?: number } = {}) {
  const teams = options.teams ?? 20;
  const db = createInMemoryPrisma({
    uniques: {
      leagueSeasonArchive: [["leagueId", "seasonNumber"]],
      leagueSeasonArchiveStanding: [["archiveId", "userId"]],
      leagueSeason: [["leagueId", "season"]],
      userTrophy: [["archiveId", "userId", "type"]],
      swissTournament: [["leagueId", "seasonNumber"]],
    },
    relations: {
      league: { endGameweek: { model: "gameweek", foreignKey: "endGameweekId" } },
      leagueMember: {
        user: { model: "user", foreignKey: "userId" },
        squad: { model: "squad", foreignKey: "squadId" },
      },
      leagueSeasonArchive: {
        standings: { model: "leagueSeasonArchiveStanding", foreignKey: "archiveId", many: true },
        matches: { model: "leagueSeasonArchiveMatch", foreignKey: "archiveId", many: true },
      },
      userTrophy: { league: { model: "league", foreignKey: "leagueId" } },
    },
    defaults: {
      leagueSeason: () => ({ createdAt: new Date(), tierGroupId: null, tierId: null, previousSeasonId: null }),
      leagueSeasonArchive: () => ({ archivedAt: new Date() }),
      userTrophy: () => ({ awardedAt: new Date() }),
    },
  });

  const now = Date.now();
  db.$seed(
    "gameweek",
    Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      season: "2026/27",
      deadline: new Date(i < 5 ? now - (10 - i) * 7 * DAY : now + (i - 4) * 7 * DAY),
    }))
  );
  db.$seed("league", [
    {
      id: "L1",
      name: "Office League",
      creatorId: CREATOR,
      isPrivate: true,
      status: "COMPLETED",
      scoringType: options.scoringType ?? "CLASSIC",
      entryFee: options.entryFee ?? 0,
      prizePool: options.entryFee ? options.entryFee * teams * 0.9 : 0,
      currentMembers: teams,
      startGameweekId: 1,
      endGameweekId: 5,
      seasonNumber: 1,
    },
  ]);
  for (let i = 1; i <= teams; i++) {
    db.$seed("user", [{ id: userId(i), username: `manager${i}` }]);
    db.$seed("squad", [{ id: `sq${i}`, userId: userId(i), name: `Squad ${i}` }]);
    db.$seed("leagueMember", [
      {
        id: memberId(i),
        leagueId: "L1",
        userId: userId(i),
        squadId: `sq${i}`,
        status: "ACTIVE",
        paymentStatus: options.entryFee ? "PAYMENT_CONFIRMED" : "PENDING",
        hasPaid: true,
        joinedAt: new Date(2026, 6, 1, 0, i),
        rank: teams - i + 1,
        totalPoints: 5 * (50 + i),
        matchesWon: i,
        matchesDrawn: 0,
        matchesLost: 5 - Math.min(i, 5),
        pointsFor: 5 * (50 + i),
        pointsAgainst: 250,
        h2hPoints: 3 * i,
      },
    ]);
    for (let gw = 1; gw <= 5; gw++) {
      db.$seed("squadGameweekScore", [{ squadId: `sq${i}`, gameweekId: gw, points: 50 + i }]);
    }
  }
  return db;
}

const nextWindow = { startGameweekId: 6, endGameweekId: 10 };
const creator = { id: CREATOR, role: "USER" };

describe("SeasonRolloverService: 20-team private league season end", () => {
  it("archives the season, awards trophies and opens a new campaign", async () => {
    const db = seasonDb();
    const service = new SeasonRolloverService(db);
    const result = await service.rolloverLeague("L1", creator, nextWindow);

    // Archive with a frozen, ranked leaderboard
    const t = db.$tables();
    assert.equal(t.leagueSeasonArchive.length, 1);
    const archive = t.leagueSeasonArchive[0];
    assert.equal(archive.seasonNumber, 1);
    assert.equal(archive.season, "2026/27");
    assert.equal(archive.memberCount, 20);
    assert.equal(archive.championUserId, userId(20));
    assert.equal(archive.totalPoints, Array.from({ length: 20 }, (_, i) => 5 * (51 + i)).reduce((a, b) => a + b, 0));

    const standings = [...t.leagueSeasonArchiveStanding].sort((a: any, b: any) => a.rank - b.rank);
    assert.equal(standings.length, 20);
    assert.deepEqual(standings.slice(0, 3).map((s: any) => s.userId), [userId(20), userId(19), userId(18)]);
    assert.equal(standings[0].totalPoints, 350);
    assert.equal(standings[0].bestGameweekPoints, 70);
    assert.equal(standings[0].username, "manager20");

    // Trophies: podium + a participation badge for everyone
    assert.equal(result.trophiesAwarded, 23);
    const champion = t.userTrophy.filter((x: any) => x.userId === userId(20)).map((x: any) => x.type).sort();
    assert.deepEqual(champion, ["CHAMPION", "PARTICIPANT"]);
    assert.ok(t.userTrophy.some((x: any) => x.type === "RUNNER_UP" && x.userId === userId(19)));
    assert.ok(t.userTrophy.some((x: any) => x.type === "THIRD_PLACE" && x.userId === userId(18)));

    // League reset for the new campaign, roster preserved
    const league = t.league[0];
    assert.equal(league.seasonNumber, 2);
    assert.equal(league.startGameweekId, 6);
    assert.equal(league.endGameweekId, 10);
    assert.equal(league.status, "UPCOMING");
    assert.equal(league.currentMembers, 20);
    assert.equal(t.leagueMember.length, 20);
    for (const member of t.leagueMember) {
      assert.equal(member.status, "ACTIVE", "free league members stay active");
      assert.equal(member.rank, null);
      assert.equal(member.totalPoints, 0);
      assert.equal(member.h2hPoints, 0);
      assert.equal(member.squadId, `sq${Number(member.id.slice(3))}`, "squad link kept");
    }

    // New campaign entry linked to the archived one
    assert.equal(t.leagueSeason.length, 2);
    assert.equal(result.season.season, "2026/27 (campaign 2)");
    const previous = t.leagueSeason.find((s: any) => s.season === "2026/27");
    assert.equal(result.season.previousSeasonId, previous.id);
  });

  it("leaves no orphan rows: every archived row points at existing records", async () => {
    const db = seasonDb();
    await new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow);
    const t = db.$tables();
    const archiveIds = new Set(t.leagueSeasonArchive.map((a: any) => a.id));
    const userIds = new Set(t.user.map((u: any) => u.id));
    for (const row of t.leagueSeasonArchiveStanding) {
      assert.ok(archiveIds.has(row.archiveId));
      assert.ok(userIds.has(row.userId));
    }
    for (const trophy of t.userTrophy) {
      assert.ok(archiveIds.has(trophy.archiveId));
      assert.ok(userIds.has(trophy.userId));
      assert.equal(trophy.leagueId, "L1");
    }
    const memberIds = new Set(t.leagueMember.map((m: any) => m.id));
    const squadIds = new Set(t.squad.map((s: any) => s.id));
    for (const member of t.leagueMember) assert.ok(squadIds.has(member.squadId));
    assert.equal(t.squadGameweekScore.length, 100, "historical squad scores are not deleted");
    assert.ok(memberIds.size === 20);
  });

  it("refuses paid leagues, whose escrow cannot be reused for a second season", async () => {
    const db = seasonDb({ entryFee: 10 });
    const before = structuredClone(db.$tables());
    await assert.rejects(
      new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow),
      /Paid leagues cannot be rolled over yet/
    );
    assert.deepEqual(db.$tables().league, before.league);
    assert.deepEqual(db.$tables().leagueMember, before.leagueMember);
    assert.equal((db.$tables().leagueSeasonArchive ?? []).length, 0);
  });

  it("archives head-to-head standings and match history without deleting fixtures", async () => {
    const db = seasonDb({ teams: 4, scoringType: "HEAD_TO_HEAD" });
    db.$seed("leagueFixture", [
      { id: "f1", leagueId: "L1", gameweekId: 1, homeMemberId: memberId(1), awayMemberId: memberId(2), homeScore: 51, awayScore: 52, isPlayoff: false, playoffRound: null },
      { id: "f2", leagueId: "L1", gameweekId: 1, homeMemberId: memberId(3), awayMemberId: memberId(4), homeScore: 53, awayScore: 54, isPlayoff: false, playoffRound: null },
      { id: "f3", leagueId: "L1", gameweekId: 5, homeMemberId: memberId(4), awayMemberId: null, homeScore: 54, awayScore: 52, isPlayoff: true, playoffRound: 1 },
    ]);
    await new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow);
    const t = db.$tables();

    const ranked = [...t.leagueSeasonArchiveStanding].sort((a: any, b: any) => a.rank - b.rank);
    assert.deepEqual(ranked.map((s: any) => s.userId), [userId(4), userId(3), userId(2), userId(1)], "ordered by H2H points");
    assert.equal(ranked[0].h2hPoints, 12);

    assert.equal(t.leagueSeasonArchiveMatch.length, 3);
    const first = t.leagueSeasonArchiveMatch.find((m: any) => m.gameweekId === 1 && m.homeUserId === userId(1));
    assert.equal(first.awayUserId, userId(2));
    assert.equal(first.format, "H2H");
    assert.ok(t.leagueSeasonArchiveMatch.some((m: any) => m.isPlayoff && m.awayUserId === null));
    assert.equal(t.leagueFixture.length, 3, "season fixtures stay as history");
  });

  it("archives Swiss results from the season's tournament", async () => {
    const db = seasonDb({ teams: 3, scoringType: "SWISS" });
    db.$seed("swissTournament", [{ id: "T1", leagueId: "L1", seasonNumber: 1, totalRounds: 1, currentRound: 1, status: "COMPLETED" }]);
    db.$seed("swissPairing", [
      { id: "p1", tournamentId: "T1", round: 1, gameweekId: 1, tableNumber: 1, playerAId: memberId(1), playerBId: memberId(2), scoreA: 80, scoreB: 20, result: "A_WIN" },
      { id: "p2", tournamentId: "T1", round: 1, gameweekId: 1, tableNumber: 2, playerAId: memberId(3), playerBId: null, scoreA: 40, scoreB: null, result: "BYE" },
    ]);
    await new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow);
    const t = db.$tables();
    const ranked = [...t.leagueSeasonArchiveStanding].sort((a: any, b: any) => a.rank - b.rank);
    // m1 and m3 both have 3 match points; m1 has Buchholz 0 vs m3 0, SB 0 vs 0, differential +60 vs 0
    assert.deepEqual(ranked.map((s: any) => s.userId), [userId(1), userId(3), userId(2)]);
    assert.equal(t.leagueSeasonArchiveMatch.length, 2);
    assert.ok(t.leagueSeasonArchiveMatch.every((m: any) => m.format === "SWISS"));
  });
});

describe("SeasonRolloverService: atomicity and guards", () => {
  it("rolls back every step when archiving fails part-way", async () => {
    const db = seasonDb();
    const before = structuredClone(db.$tables());
    const original = db.userTrophy.createMany;
    db.userTrophy.createMany = async () => {
      throw new Error("disk full");
    };

    await assert.rejects(new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow), /disk full/);
    db.userTrophy.createMany = original;

    const after = db.$tables();
    assert.deepEqual(after.league, before.league, "league untouched");
    assert.deepEqual(after.leagueMember, before.leagueMember, "members untouched");
    assert.equal((after.leagueSeasonArchive ?? []).length, 0);
    assert.equal((after.leagueSeasonArchiveStanding ?? []).length, 0);
    assert.equal((after.userTrophy ?? []).length, 0);
    assert.equal((after.leagueSeason ?? []).length, 0);

    // ...and the rollover succeeds once the fault is gone
    await new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow);
    assert.equal(db.$tables().leagueSeasonArchive.length, 1);
  });

  it("rolls back when the member reset fails after the archive was written", async () => {
    const db = seasonDb();
    const original = db.leagueMember.updateMany;
    db.leagueMember.updateMany = async () => {
      throw new Error("deadlock detected");
    };
    await assert.rejects(new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow), /deadlock/);
    db.leagueMember.updateMany = original;
    assert.equal((db.$tables().leagueSeasonArchive ?? []).length, 0);
    assert.equal(db.$tables().league[0].seasonNumber, 1);
  });

  it("only lets the creator or an admin roll the league over", async () => {
    const db = seasonDb();
    const service = new SeasonRolloverService(db);
    await assert.rejects(service.rolloverLeague("L1", { id: userId(5), role: "USER" }, nextWindow), SeasonRolloverForbiddenError);
    await service.rolloverLeague("L1", { id: "admin", role: "ADMIN" }, nextWindow);
    assert.equal(db.$tables().leagueSeasonArchive[0].archivedById, "admin");
  });

  it("rejects unfinished leagues, invalid windows and a second rollover", async () => {
    const db = seasonDb();
    const service = new SeasonRolloverService(db);
    await assert.rejects(service.rolloverLeague("L1", creator, { startGameweekId: 5, endGameweekId: 10 }), /must start after/);
    await assert.rejects(service.rolloverLeague("L1", creator, { startGameweekId: 8, endGameweekId: 6 }), SeasonRolloverError);
    await assert.rejects(service.rolloverLeague("L1", creator, { startGameweekId: 6, endGameweekId: 99 }), /must exist/);

    db.$tables().gameweek[5].deadline = new Date(Date.now() - DAY);
    await assert.rejects(service.rolloverLeague("L1", creator, nextWindow), /deadline has already passed/);
    db.$tables().gameweek[5].deadline = new Date(Date.now() + 7 * DAY);

    db.$tables().league[0].status = "ACTIVE";
    await assert.rejects(service.rolloverLeague("L1", creator, nextWindow), /Only a COMPLETED league/);
    db.$tables().league[0].status = "COMPLETED";

    await service.rolloverLeague("L1", creator, nextWindow);
    await assert.rejects(service.rolloverLeague("L1", creator, nextWindow), /Only a COMPLETED league/);
  });

  it("reports a concurrent duplicate archive as a conflict", async () => {
    const db = seasonDb();
    db.$seed("leagueSeasonArchive", [{ id: "existing", leagueId: "L1", seasonNumber: 1 }]);
    await assert.rejects(
      new SeasonRolloverService(db).rolloverLeague("L1", creator, nextWindow),
      SeasonRolloverConflictError
    );
  });
});

describe("SeasonRolloverService: historical access", () => {
  it("keeps archived leaderboards and match history readable for members", async () => {
    const db = seasonDb({ teams: 4, scoringType: "HEAD_TO_HEAD" });
    db.$seed("leagueFixture", [
      { id: "f1", leagueId: "L1", gameweekId: 1, homeMemberId: memberId(1), awayMemberId: memberId(2), homeScore: 51, awayScore: 52, isPlayoff: false, playoffRound: null },
    ]);
    const service = new SeasonRolloverService(db);
    await service.rolloverLeague("L1", creator, nextWindow);

    const seasons = await service.listSeasons("L1");
    assert.equal(seasons.length, 1);
    assert.equal(seasons[0].championUsername, "manager4");

    const season = await service.getSeason("L1", 1);
    assert.deepEqual(season.standings.map((s: any) => s.rank), [1, 2, 3, 4]);
    assert.equal(season.matches.length, 1);
    await assert.rejects(service.getSeason("L1", 2), /has not been archived/);

    const trophies = await service.getUserTrophies(userId(4));
    assert.deepEqual(trophies.map((t: any) => t.type).sort(), ["CHAMPION", "PARTICIPANT"]);
    assert.equal(trophies[0].league.name, "Office League");
  });

  it("limits a private league's history to current and past members", async () => {
    const db = seasonDb({ teams: 4 });
    const service = new SeasonRolloverService(db);
    await service.rolloverLeague("L1", creator, nextWindow);

    assert.equal(await service.canViewHistory("L1", { id: userId(3) }), true, "current member");
    assert.equal(await service.canViewHistory("L1", { id: "stranger" }), false);
    assert.equal(await service.canViewHistory("L1", null), false);
    assert.equal(await service.canViewHistory("L1", { id: "boss", role: "ADMIN" }), true);

    // A member who left after the season keeps access through the archive
    db.$tables().leagueMember = db.$tables().leagueMember.filter((m: any) => m.userId !== userId(2));
    assert.equal(await service.canViewHistory("L1", { id: userId(2) }), true);

    db.$tables().league[0].isPrivate = false;
    assert.equal(await service.canViewHistory("L1", null), true, "public leagues are open");
  });
});
