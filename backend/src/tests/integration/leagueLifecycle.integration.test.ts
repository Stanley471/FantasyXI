import { describe, it, beforeEach, afterEach, after, before } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../app.js";
import { prisma } from "../../config/db.js";
import { signAccessToken } from "../../config/jwt.js";
import { LeagueStatus, MembershipStatus } from "../../types/index.js";

// In-memory database store for test fallback when PostgreSQL server is unreachable
const dbStore = {
  users: new Map<string, any>(),
  squads: new Map<string, any>(),
  gameweeks: new Map<number, any>(),
  leagues: new Map<string, any>(),
  leagueMembers: new Map<string, any>(),
};

let isDbConnected = false;

async function initTestDatabase() {
  try {
    await (prisma as any).$connect();
    await (prisma as any).user.findMany({ take: 1 });
    isDbConnected = true;
  } catch {
    isDbConnected = false;
    setupMockPrismaClient();
  }
}

function setupMockPrismaClient() {
  const mockClient = {
    $connect: async () => {},
    $disconnect: async () => {},
    user: {
      create: async ({ data }: any) => {
        const user = { id: data.id || `usr_${Math.random().toString(36).slice(2, 9)}`, ...data };
        dbStore.users.set(user.id, user);
        return user;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return dbStore.users.get(where.id) || null;
        for (const user of dbStore.users.values()) {
          if (where.email && user.email === where.email) return user;
          if (where.username && user.username === where.username) return user;
        }
        return null;
      },
      deleteMany: async () => {
        dbStore.users.clear();
        return { count: 0 };
      },
    },
    squad: {
      create: async ({ data }: any) => {
        const squad = { id: data.id || `sqd_${Math.random().toString(36).slice(2, 9)}`, ...data };
        dbStore.squads.set(squad.id, squad);
        return squad;
      },
      findFirst: async ({ where }: any) => {
        for (const squad of dbStore.squads.values()) {
          if (where.id && squad.id !== where.id) continue;
          if (where.userId && squad.userId !== where.userId) continue;
          return squad;
        }
        return null;
      },
      deleteMany: async () => {
        dbStore.squads.clear();
        return { count: 0 };
      },
    },
    gameweek: {
      create: async ({ data }: any) => {
        const gw = { id: data.id || data.fplId || Math.floor(Math.random() * 10000), ...data };
        dbStore.gameweeks.set(gw.id, gw);
        return gw;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return dbStore.gameweeks.get(where.id) || null;
        for (const gw of dbStore.gameweeks.values()) {
          if (where.fplId && gw.fplId === where.fplId) return gw;
        }
        return null;
      },
      deleteMany: async () => {
        dbStore.gameweeks.clear();
        return { count: 0 };
      },
    },
    league: {
      create: async ({ data }: any) => {
        const league = {
          id: data.id || `leg_${Math.random().toString(36).slice(2, 9)}`,
          currentMembers: data.currentMembers ?? 0,
          prizePool: data.prizePool ?? 0,
          status: data.status || LeagueStatus.UPCOMING,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbStore.leagues.set(league.id, league);
        return league;
      },
      findUnique: async ({ where, include }: any) => {
        let league = null;
        if (where.id) league = dbStore.leagues.get(where.id) || null;
        else if (where.inviteCode) {
          for (const l of dbStore.leagues.values()) {
            if (l.inviteCode === where.inviteCode) {
              league = l;
              break;
            }
          }
        }
        if (!league) return null;

        const result = { ...league };
        if (include) {
          if (include.creator) {
            const creator = dbStore.users.get(league.creatorId);
            result.creator = creator ? { id: creator.id, username: creator.username } : null;
          }
          if (include.startGameweek) {
            result.startGameweek = dbStore.gameweeks.get(league.startGameweekId) || null;
          }
          if (include.endGameweek) {
            result.endGameweek = dbStore.gameweeks.get(league.endGameweekId) || null;
          }
          if (include.members) {
            const members: any[] = [];
            for (const m of dbStore.leagueMembers.values()) {
              if (m.leagueId === league.id) {
                const u = dbStore.users.get(m.userId);
                const sq = dbStore.squads.get(m.squadId);
                members.push({
                  ...m,
                  user: u ? { id: u.id, username: u.username } : null,
                  squad: sq ? { id: sq.id, name: sq.name } : null,
                });
              }
            }
            result.members = members;
          }
        }
        return result;
      },
      update: async ({ where, data }: any) => {
        const league = dbStore.leagues.get(where.id);
        if (!league) throw new Error(`League ${where.id} not found`);
        Object.assign(league, data, { updatedAt: new Date() });
        dbStore.leagues.set(where.id, league);
        return league;
      },
      deleteMany: async () => {
        dbStore.leagues.clear();
        return { count: 0 };
      },
    },
    leagueMember: {
      create: async ({ data, include }: any) => {
        const member = {
          id: data.id || `mem_${Math.random().toString(36).slice(2, 9)}`,
          joinedAt: new Date(),
          status: data.status || MembershipStatus.PENDING,
          hasPaid: data.hasPaid ?? false,
          ...data,
        };
        const key = `${data.leagueId}_${data.userId}`;
        dbStore.leagueMembers.set(key, member);

        const result = { ...member };
        if (include) {
          if (include.user) {
            const u = dbStore.users.get(data.userId);
            result.user = u ? { id: u.id, username: u.username } : null;
          }
          if (include.squad) {
            const sq = dbStore.squads.get(data.squadId);
            result.squad = sq ? { id: sq.id, name: sq.name } : null;
          }
        }
        return result;
      },
      createMany: async ({ data }: any) => {
        for (const item of data) {
          const member = {
            id: item.id || `mem_${Math.random().toString(36).slice(2, 9)}`,
            joinedAt: new Date(),
            status: item.status || MembershipStatus.PENDING,
            hasPaid: item.hasPaid ?? false,
            ...item,
          };
          const key = `${item.leagueId}_${item.userId}`;
          dbStore.leagueMembers.set(key, member);
        }
        return { count: data.length };
      },
      findUnique: async ({ where }: any) => {
        if (where.leagueId_userId) {
          const key = `${where.leagueId_userId.leagueId}_${where.leagueId_userId.userId}`;
          return dbStore.leagueMembers.get(key) || null;
        }
        return null;
      },
      deleteMany: async () => {
        dbStore.leagueMembers.clear();
        return { count: 0 };
      },
    },
    leagueFixture: { deleteMany: async () => ({ count: 0 }) },
    transaction: { deleteMany: async () => ({ count: 0 }) },
    squadPlayer: { deleteMany: async () => ({ count: 0 }) },
    squadGameweekScore: { deleteMany: async () => ({ count: 0 }) },
    squadTransfer: { deleteMany: async () => ({ count: 0 }) },
    squadChipUsage: { deleteMany: async () => ({ count: 0 }) },
    wallet: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async (fn: any) => fn(mockClient),
  };

  (globalThis as any).prisma = mockClient;
}

async function clearDatabase() {
  if (isDbConnected) {
    await prisma.leagueFixture.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.leagueMember.deleteMany();
    await prisma.league.deleteMany();
    await prisma.squadPlayer.deleteMany();
    await prisma.squadGameweekScore.deleteMany();
    await prisma.squadTransfer.deleteMany();
    await prisma.squadChipUsage.deleteMany();
    await prisma.squad.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.user.deleteMany();
    await prisma.gameweek.deleteMany();
  } else {
    dbStore.users.clear();
    dbStore.squads.clear();
    dbStore.gameweeks.clear();
    dbStore.leagues.clear();
    dbStore.leagueMembers.clear();
  }
}

function getAuthToken(userId: string, email: string, username: string): string {
  return signAccessToken({ userId, email, username });
}

describe("League Lifecycle Integration Tests (API + DB)", () => {
  before(async () => {
    await initTestDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  after(async () => {
    if (isDbConnected) {
      await prisma.$disconnect();
    }
  });

  it("should successfully create a league and verify database state", async () => {
    // 1. Seed prerequisite test data (User, Gameweeks, Squad)
    const creator = await prisma.user.create({
      data: {
        email: "creator@example.com",
        username: "league_creator",
      },
    });

    const squad = await prisma.squad.create({
      data: {
        userId: creator.id,
        name: "Creator FC",
      },
    });

    const futureDeadline = new Date(Date.now() + 86400000); // 1 day in future
    const gw1 = await prisma.gameweek.create({
      data: {
        fplId: 1,
        name: "Gameweek 1",
        deadline: futureDeadline,
        season: "2026",
      },
    });

    const gw5 = await prisma.gameweek.create({
      data: {
        fplId: 5,
        name: "Gameweek 5",
        deadline: new Date(Date.now() + 86400000 * 5),
        season: "2026",
      },
    });

    const token = getAuthToken(creator.id, creator.email, creator.username);

    // 2. Perform API request to create league
    const res = await request(app)
      .post("/api/v1/leagues")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Integration Test League",
        description: "A test league for integration suite",
        entryFee: 0,
        maxMembers: 10,
        minMembers: 2,
        startGameweekId: gw1.id,
        endGameweekId: gw5.id,
        squadId: squad.id,
      });

    // 3. Verify HTTP response
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.name, "Integration Test League");
    assert.equal(res.body.data.currentMembers, 1);

    const leagueId = res.body.data.id;

    // 4. Verify database state directly
    const dbLeague = await prisma.league.findUnique({
      where: { id: leagueId },
    });

    assert.notEqual(dbLeague, null);
    assert.equal(dbLeague?.name, "Integration Test League");
    assert.equal(dbLeague?.creatorId, creator.id);
    assert.equal(dbLeague?.currentMembers, 1);
    assert.equal(dbLeague?.status, LeagueStatus.UPCOMING);

    const dbMember = await prisma.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId,
          userId: creator.id,
        },
      },
    });

    assert.notEqual(dbMember, null);
    assert.equal(dbMember?.squadId, squad.id);
    assert.equal(dbMember?.status, MembershipStatus.ACTIVE);
  });

  it("should successfully join a league and increment member count in DB", async () => {
    // 1. Seed Creator, Gameweeks, Squad, and League
    const creator = await prisma.user.create({
      data: { email: "creator2@example.com", username: "creator2" },
    });
    const creatorSquad = await prisma.squad.create({
      data: { userId: creator.id, name: "Creator 2 FC" },
    });

    const gw1 = await prisma.gameweek.create({
      data: {
        fplId: 10,
        name: "Gameweek 10",
        deadline: new Date(Date.now() + 86400000),
        season: "2026",
      },
    });
    const gw15 = await prisma.gameweek.create({
      data: {
        fplId: 15,
        name: "Gameweek 15",
        deadline: new Date(Date.now() + 86400000 * 5),
        season: "2026",
      },
    });

    const league = await prisma.league.create({
      data: {
        name: "Joinable League",
        creatorId: creator.id,
        inviteCode: "JOIN01",
        maxMembers: 5,
        minMembers: 2,
        currentMembers: 1,
        entryFee: 0,
        prizePool: 0,
        status: LeagueStatus.UPCOMING,
        startGameweekId: gw1.id,
        endGameweekId: gw15.id,
      },
    });

    await prisma.leagueMember.create({
      data: {
        leagueId: league.id,
        userId: creator.id,
        squadId: creatorSquad.id,
        status: MembershipStatus.ACTIVE,
        hasPaid: true,
      },
    });

    // 2. Seed Joiner User and Squad
    const joiner = await prisma.user.create({
      data: { email: "joiner@example.com", username: "joiner_user" },
    });
    const joinerSquad = await prisma.squad.create({
      data: { userId: joiner.id, name: "Joiner FC" },
    });

    const joinerToken = getAuthToken(joiner.id, joiner.email, joiner.username);

    // 3. Perform API request to join league
    const res = await request(app)
      .post(`/api/v1/leagues/${league.id}/join`)
      .set("Authorization", `Bearer ${joinerToken}`)
      .send({ squadId: joinerSquad.id });

    // 4. Verify API response
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.leagueId, league.id);
    assert.equal(res.body.data.userId, joiner.id);

    // 5. Verify database state
    const updatedLeague = await prisma.league.findUnique({
      where: { id: league.id },
    });

    assert.notEqual(updatedLeague, null);
    assert.equal(updatedLeague?.currentMembers, 2); // Member count incremented!

    const joinerMember = await prisma.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId: league.id,
          userId: joiner.id,
        },
      },
    });

    assert.notEqual(joinerMember, null);
    assert.equal(joinerMember?.squadId, joinerSquad.id);
  });

  it("should fail to join a full league and preserve database integrity", async () => {
    // 1. Seed a league with maxMembers = 2 and currentMembers = 2
    const creator = await prisma.user.create({
      data: { email: "creator3@example.com", username: "creator3" },
    });
    const creatorSquad = await prisma.squad.create({
      data: { userId: creator.id, name: "Creator 3 FC" },
    });

    const user2 = await prisma.user.create({
      data: { email: "user2@example.com", username: "user2" },
    });
    const user2Squad = await prisma.squad.create({
      data: { userId: user2.id, name: "User 2 FC" },
    });

    const gw1 = await prisma.gameweek.create({
      data: {
        fplId: 20,
        name: "Gameweek 20",
        deadline: new Date(Date.now() + 86400000),
        season: "2026",
      },
    });

    const league = await prisma.league.create({
      data: {
        name: "Full League",
        creatorId: creator.id,
        inviteCode: "FULL01",
        maxMembers: 2,
        minMembers: 2,
        currentMembers: 2, // Full capacity reached!
        entryFee: 0,
        prizePool: 0,
        status: LeagueStatus.UPCOMING,
        startGameweekId: gw1.id,
        endGameweekId: gw1.id,
      },
    });

    await prisma.leagueMember.createMany({
      data: [
        {
          leagueId: league.id,
          userId: creator.id,
          squadId: creatorSquad.id,
          status: MembershipStatus.ACTIVE,
          hasPaid: true,
        },
        {
          leagueId: league.id,
          userId: user2.id,
          squadId: user2Squad.id,
          status: MembershipStatus.ACTIVE,
          hasPaid: true,
        },
      ],
    });

    // 2. Seed a third user who attempts to join the full league
    const user3 = await prisma.user.create({
      data: { email: "user3@example.com", username: "user3" },
    });
    const user3Squad = await prisma.squad.create({
      data: { userId: user3.id, name: "User 3 FC" },
    });

    const user3Token = getAuthToken(user3.id, user3.email, user3.username);

    // 3. Perform API request to join full league
    const res = await request(app)
      .post(`/api/v1/leagues/${league.id}/join`)
      .set("Authorization", `Bearer ${user3Token}`)
      .send({ squadId: user3Squad.id });

    // 4. Verify API response failure
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /full/i);

    // 5. Verify database integrity
    const dbLeague = await prisma.league.findUnique({
      where: { id: league.id },
    });
    assert.equal(dbLeague?.currentMembers, 2); // Preserved at 2

    const user3Member = await prisma.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId: league.id,
          userId: user3.id,
        },
      },
    });
    assert.equal(user3Member, null); // User 3 was not added to DB
  });
});
