import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { prisma } from "../../config/db.js";
import { leagueService } from "../../services/league/leagueService.js";
import { swissTournamentService } from "../../services/league/swissTournamentService.js";
import {
  SeasonRolloverConflictError,
  seasonRolloverService,
} from "../../services/league/seasonRolloverService.js";
import { pairKey } from "../../services/league/swissPairingEngine.js";
import { LeagueStatus } from "../../types/index.js";

/**
 * Swiss tournament (issue #270) and season rollover (issue #271) against a real
 * PostgreSQL database with the Prisma schema pushed:
 *   DATABASE_URL=postgresql://... npm run test:integration
 * Creates its own users, gameweeks and leagues and removes them afterwards.
 * Skipped when no database is reachable.
 */

const DAY = 24 * 60 * 60 * 1000;
const run = crypto.randomBytes(3).toString("hex");
const db = prisma as any;

let skip: string | false = false;
const userIds: string[] = [];
const leagueIds: string[] = [];
let gameweekIds: number[] = [];

async function createUsers(count: number, prefix: string) {
  const users = [];
  for (let i = 1; i <= count; i++) {
    const user = await db.user.create({
      data: {
        email: `${prefix}${i}-${run}@it.test`,
        username: `${prefix}${i}_${run}`,
        squads: { create: { name: `${prefix} Squad ${i}` } },
      },
      include: { squads: true },
    });
    userIds.push(user.id);
    users.push(user);
  }
  return users;
}

async function createLeague(creatorId: string, data: Record<string, unknown>) {
  const league = await db.league.create({
    data: {
      name: `IT League ${run}`,
      creatorId,
      inviteCode: crypto.randomBytes(4).toString("hex").toUpperCase(),
      isPrivate: true,
      startGameweekId: gameweekIds[0],
      endGameweekId: gameweekIds[4],
      ...data,
    },
  });
  leagueIds.push(league.id);
  return league;
}

describe("Swiss season and rollover (PostgreSQL integration, issues #270 and #271)", () => {
  before(async () => {
    try {
      await db.$queryRawUnsafe("SELECT 1 FROM swiss_tournaments LIMIT 1");
    } catch (error) {
      skip = `database unreachable or schema not pushed (${(error as Error).message.split("\n")[0]})`;
      return;
    }
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const gameweek = await db.gameweek.create({
        data: {
          fplId: 700_000 + Math.floor(Math.random() * 100_000) * 10 + i,
          name: `IT Gameweek ${i + 1}`,
          season: `IT-${run}`,
          // Five finished gameweeks, then the next season's five in the future
          deadline: new Date(i < 5 ? now - (10 - i) * 7 * DAY : now + (i - 4) * 7 * DAY),
          isFinished: i < 5,
        },
      });
      gameweekIds.push(gameweek.id);
    }
  });

  after(async () => {
    if (skip) return;
    await db.league.deleteMany({ where: { id: { in: leagueIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.gameweek.deleteMany({ where: { id: { in: gameweekIds } } });
    await db.$disconnect();
  });

  it("plays a 20-team private Swiss league for 5 gameweeks and rolls it into a new season", async (t) => {
    if (skip) return t.skip(skip);

    const users = await createUsers(20, "swiss");
    const league = await createLeague(users[0].id, { scoringType: "SWISS", maxMembers: 20, currentMembers: 20 });
    const members = [];
    for (const [i, user] of users.entries()) {
      members.push(
        await db.leagueMember.create({
          data: {
            leagueId: league.id,
            userId: user.id,
            squadId: user.squads[0].id,
            status: "ACTIVE",
            hasPaid: true,
            joinedAt: new Date(Date.UTC(2026, 6, 1, 0, i)),
          },
        })
      );
    }

    // Activation pairs round 1 inside the activation transaction
    await leagueService.transitionStatus(league.id, LeagueStatus.ACTIVE);
    const round1 = await db.swissPairing.findMany({ where: { round: 1, tournament: { leagueId: league.id } } });
    assert.equal(round1.length, 10);

    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const gameweekId of gameweekIds.slice(0, 5)) {
      await db.squadGameweekScore.createMany({
        data: users.map((u) => ({ squadId: u.squads[0].id, gameweekId, points: 30 + Math.floor(random() * 60) })),
      });
      await swissTournamentService.processGameweek(league.id, gameweekId);
      // A retried settlement job changes nothing
      await swissTournamentService.processGameweek(league.id, gameweekId);
    }
    await leagueService.transitionStatus(league.id, LeagueStatus.COMPLETED);

    const tournament = await db.swissTournament.findFirst({ where: { leagueId: league.id } });
    assert.equal(tournament.status, "COMPLETED");
    assert.equal(tournament.currentRound, 5);
    const pairings = await db.swissPairing.findMany({ where: { tournamentId: tournament.id } });
    assert.equal(pairings.length, 50);
    assert.ok(pairings.every((p: any) => p.result !== "PENDING"));
    const pairs = pairings.map((p: any) => pairKey(p.playerAId, p.playerBId));
    assert.equal(new Set(pairs).size, 50, "no rematches over 5 rounds");
    assert.equal(await db.swissRoundStanding.count({ where: { tournamentId: tournament.id } }), 100);

    const { standings } = await swissTournamentService.getStandings(league.id);
    assert.equal(standings.length, 20);

    // Season end -> archive and new campaign
    const result = await seasonRolloverService.rolloverLeague(
      league.id,
      { id: users[0].id, role: "USER" },
      { startGameweekId: gameweekIds[5], endGameweekId: gameweekIds[9] }
    );
    assert.equal(result.archive.standingsCount, 20);
    assert.equal(result.archive.matchesCount, 50);
    assert.equal(result.trophiesAwarded, 23);

    const archived = await seasonRolloverService.getSeason(league.id, 1);
    assert.deepEqual(archived.standings.map((s: any) => s.userId), standings.map((s) => s.userId), "archive matches the final Swiss table");
    assert.equal(archived.championUserId, standings[0].userId);

    const renewed = await db.league.findUnique({ where: { id: league.id }, include: { members: true } });
    assert.equal(renewed.seasonNumber, 2);
    assert.equal(renewed.status, "UPCOMING");
    assert.equal(renewed.startGameweekId, gameweekIds[5]);
    assert.equal(renewed.members.length, 20, "roster preserved");
    assert.ok(renewed.members.every((m: any) => m.h2hPoints === 0 && m.rank === null && m.status === "ACTIVE"));
    assert.equal(await db.leagueSeason.count({ where: { leagueId: league.id } }), 2);
    assert.equal(await db.swissPairing.count({ where: { tournamentId: tournament.id } }), 50, "history kept");

    const trophies = await seasonRolloverService.getUserTrophies(standings[0].userId);
    assert.deepEqual(trophies.map((x: any) => x.type).sort(), ["CHAMPION", "PARTICIPANT"]);
  });

  it("rolls the whole pipeline back when the final step violates a constraint", async (t) => {
    if (skip) return t.skip(skip);

    const users = await createUsers(3, "atomic");
    const league = await createLeague(users[0].id, { status: "COMPLETED", currentMembers: 3 });
    for (const user of users) {
      await db.leagueMember.create({
        data: { leagueId: league.id, userId: user.id, squadId: user.squads[0].id, status: "ACTIVE", h2hPoints: 9, rank: 1 },
      });
    }
    // The new season name already exists: the LeagueSeason insert (last step) fails
    await db.leagueSeason.create({ data: { leagueId: league.id, season: `IT-${run}` } });
    await db.leagueSeason.create({ data: { leagueId: league.id, season: "Taken" } });

    await assert.rejects(
      seasonRolloverService.rolloverLeague(
        league.id,
        { id: users[0].id },
        { startGameweekId: gameweekIds[5], endGameweekId: gameweekIds[9], season: "Taken" }
      ),
      SeasonRolloverConflictError
    );

    assert.equal(await db.leagueSeasonArchive.count({ where: { leagueId: league.id } }), 0);
    assert.equal(await db.userTrophy.count({ where: { leagueId: league.id } }), 0);
    const unchanged = await db.league.findUnique({ where: { id: league.id }, include: { members: true } });
    assert.equal(unchanged.seasonNumber, 1);
    assert.equal(unchanged.status, "COMPLETED");
    assert.ok(unchanged.members.every((m: any) => m.h2hPoints === 9 && m.rank === 1), "member stats untouched");
  });
});
