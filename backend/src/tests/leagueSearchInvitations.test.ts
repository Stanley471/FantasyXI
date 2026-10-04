import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import {
  LeagueService,
  LeagueForbiddenError,
  LeagueInvitationError,
  LeagueValidationError,
  LeagueNotFoundError,
  INVITATION_MAX_TTL_HOURS,
} from "../services/league/leagueService.js";
import {
  FinancialService,
  FinancialForbiddenError,
} from "../services/financial/financialService.js";
import leagueRoutes from "../routes/league.routes.js";
import { LeagueStatus, MembershipStatus, ScoringType } from "../types/index.js";

const CREATOR = "creator-1";
const FIELD_REF = Symbol("fieldRef");

// ------------------------------------------------------------
// Tiny evaluator for the subset of Prisma `where` used by league search,
// so search tests run the real generated query against seeded rows.
// ------------------------------------------------------------
function evaluate(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, cond]: [string, any]) => {
    if (key === "AND") return cond.every((c: any) => evaluate(row, c));
    if (key === "OR") return cond.some((c: any) => evaluate(row, c));
    if (key === "members") return row.members.some((m: any) => evaluate(m, cond.some));

    const value = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;

    const resolve = (v: any) => (v && v[FIELD_REF] ? row[v[FIELD_REF]] : v);
    if ("contains" in cond) {
      return cond.mode === "insensitive"
        ? String(value).toLowerCase().includes(cond.contains.toLowerCase())
        : String(value).includes(cond.contains);
    }
    if ("gte" in cond && !(value >= resolve(cond.gte))) return false;
    if ("lte" in cond && !(value <= resolve(cond.lte))) return false;
    if ("lt" in cond && !(value < resolve(cond.lt))) return false;
    if ("gt" in cond && !(value > resolve(cond.gt))) return false;
    return true;
  });
}

function createMockDb() {
  const future = new Date(Date.now() + 7 * 24 * 3_600_000);
  const state = {
    leagues: [] as any[],
    members: [] as any[],
    invitations: [] as any[],
    squads: [
      { id: "squad-a", userId: "user-a" },
      { id: "squad-b", userId: "user-b" },
      { id: "squad-c", userId: "user-c" },
    ],
  };

  let seq = 0;
  const addLeague = (overrides: any = {}) => {
    const league = {
      id: randomUUID(),
      name: `League ${++seq}`,
      creatorId: CREATOR,
      inviteCode: `CODE${seq}`,
      entryFee: 0,
      prizePool: 0,
      maxMembers: 20,
      currentMembers: 1,
      status: LeagueStatus.UPCOMING,
      scoringType: ScoringType.CLASSIC,
      isPrivate: false,
      createdAt: new Date(Date.UTC(2026, 0, seq)),
      startGameweek: { id: 1, deadline: future },
      ...overrides,
    };
    state.leagues.push(league);
    return league;
  };

  const withMembers = (league: any) => ({
    ...league,
    members: state.members.filter((m) => m.leagueId === league.id),
  });

  const db: any = {
    state,
    addLeague,
    league: {
      fields: { maxMembers: { [FIELD_REF]: "maxMembers" } },
      findUnique: async ({ where }: any) => {
        const league = state.leagues.find((l) => l.id === where.id);
        return league ? { ...league } : null;
      },
      findMany: async ({ where, orderBy, skip = 0, take }: any) => {
        const rows = state.leagues.map(withMembers).filter((l) => evaluate(l, where));
        const [[field, dir]] = Object.entries(orderBy[0]) as [[string, string]];
        rows.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === "desc" ? -1 : 1));
        return rows.slice(skip, take ? skip + take : undefined).map(({ members, ...l }) => l);
      },
      count: async ({ where }: any) => state.leagues.map(withMembers).filter((l) => evaluate(l, where)).length,
      update: async ({ where, data }: any) =>
        Object.assign(state.leagues.find((l) => l.id === where.id), data),
    },
    leagueMember: {
      findUnique: async ({ where }: any) =>
        state.members.find(
          (m) => m.leagueId === where.leagueId_userId.leagueId && m.userId === where.leagueId_userId.userId
        ) ?? null,
      create: async ({ data }: any) => {
        const member = { id: randomUUID(), ...data };
        state.members.push(member);
        return member;
      },
    },
    squad: {
      findFirst: async ({ where }: any) =>
        state.squads.find((s) => s.id === where.id && s.userId === where.userId) ?? null,
    },
    leagueInvitation: {
      create: async ({ data }: any) => {
        const invitation = { id: randomUUID(), usedAt: null, usedById: null, revokedAt: null, createdAt: new Date(), ...data };
        state.invitations.push(invitation);
        return { ...invitation };
      },
      findUnique: async ({ where }: any) => {
        const inv = state.invitations.find((i) => i.tokenHash === where.tokenHash);
        return inv ? { ...inv } : null;
      },
      findMany: async ({ where }: any) =>
        state.invitations.filter((i) => i.leagueId === where.leagueId).map((i) => ({ ...i, usedBy: null })),
      updateMany: async ({ where, data }: any) => {
        const matched = state.invitations.filter(
          (i) =>
            i.id === where.id &&
            (where.leagueId === undefined || i.leagueId === where.leagueId) &&
            (where.usedAt !== null || i.usedAt === null) &&
            (where.revokedAt !== null || i.revokedAt === null) &&
            (!where.expiresAt || i.expiresAt > where.expiresAt.gt)
        );
        matched.forEach((i) => Object.assign(i, data));
        return { count: matched.length };
      },
    },
    $transaction: async (fn: any) => fn(db),
  };
  return db;
}

describe("League search & filtering", () => {
  describe("parseSearchFilters", () => {
    it("parses a full query string", () => {
      const filters = LeagueService.parseSearchFilters({
        q: "  Premier ",
        code: "ab12cd",
        status: "UPCOMING",
        minEntryFee: "5",
        maxEntryFee: "25.5",
        minSize: "4",
        maxSize: "10",
        hasOpenSlots: "true",
        sortBy: "entryFee",
        sortOrder: "asc",
        page: "2",
        pageSize: "10",
      });

      assert.deepEqual(
        { ...filters },
        {
          q: "Premier",
          code: "AB12CD",
          status: LeagueStatus.UPCOMING,
          scoringType: undefined,
          creatorId: undefined,
          minEntryFee: 5,
          maxEntryFee: 25.5,
          minSize: 4,
          maxSize: 10,
          hasOpenSlots: true,
          sortBy: "entryFee",
          sortOrder: "asc",
          page: 2,
          pageSize: 10,
        }
      );
    });

    it("rejects malformed or contradictory filters", () => {
      for (const query of [
        { minEntryFee: "-1" },
        { minEntryFee: "abc" },
        { minEntryFee: "10", maxEntryFee: "5" },
        { minSize: "1" },
        { minSize: "2.5" },
        { minSize: "10", maxSize: "4" },
        { pageSize: "500" },
        { page: "0" },
        { sortBy: "password" },
        { sortOrder: "sideways" },
        { status: "DELETED" },
        { hasOpenSlots: "yes" },
        { q: "x".repeat(61) },
        { q: ["a", "b"] },
        { code: "AB-12" },
      ]) {
        assert.throws(() => LeagueService.parseSearchFilters(query), LeagueValidationError, JSON.stringify(query));
      }
    });
  });

  describe("getLeagues", () => {
    function seed() {
      const db = createMockDb();
      const premier = db.addLeague({ name: "Premier Stars", entryFee: 10, maxMembers: 10, currentMembers: 10 });
      const sunday = db.addLeague({ name: "Sunday League", entryFee: 0, maxMembers: 50 });
      const highRollers = db.addLeague({ name: "High Rollers PREMIER", entryFee: 100, maxMembers: 4 });
      const secret = db.addLeague({ name: "Premier Secret", entryFee: 10, maxMembers: 10, isPrivate: true });
      db.state.members.push({ leagueId: secret.id, userId: "member-x" });
      return { db, service: new LeagueService(db), premier, sunday, highRollers, secret };
    }

    it("searches by name case-insensitively and hides private leagues from the public", async () => {
      const { service, premier, highRollers } = seed();
      const result = await service.getLeagues({ q: "premier" });

      assert.deepEqual(
        result.items.map((l: any) => l.id).sort(),
        [premier.id, highRollers.id].sort()
      );
      assert.equal(result.total, 2);
    });

    it("shows private leagues to their creator and members, redacting the code for members", async () => {
      const { service, secret } = seed();

      const forCreator = await service.getLeagues({ q: "secret" }, CREATOR);
      assert.equal(forCreator.items[0].id, secret.id);
      assert.equal(forCreator.items[0].inviteCode, secret.inviteCode);

      const forMember = await service.getLeagues({ q: "secret" }, "member-x");
      assert.equal(forMember.items[0].id, secret.id);
      assert.equal(forMember.items[0].inviteCode, null);

      const forStranger = await service.getLeagues({ q: "secret" }, "someone-else");
      assert.equal(forStranger.total, 0);
    });

    it("resolves an exact invite code, but never a private league's code for strangers", async () => {
      const { service, sunday, secret } = seed();
      assert.deepEqual((await service.getLeagues({ code: sunday.inviteCode })).items.map((l: any) => l.id), [sunday.id]);
      assert.equal((await service.getLeagues({ code: secret.inviteCode }, "someone")).total, 0);
    });

    it("filters by entry fee range", async () => {
      const { service, premier } = seed();
      const result = await service.getLeagues({ minEntryFee: 5, maxEntryFee: 50 });
      assert.deepEqual(result.items.map((l: any) => l.id), [premier.id]);
    });

    it("filters by league size and open slots", async () => {
      const { service, premier, highRollers } = seed();

      const small = await service.getLeagues({ maxSize: 10 });
      assert.deepEqual(result(small).sort(), [premier.id, highRollers.id].sort());

      const open = await service.getLeagues({ maxSize: 10, hasOpenSlots: true });
      assert.deepEqual(result(open), [highRollers.id]);

      function result(r: any) {
        return r.items.map((l: any) => l.id);
      }
    });

    it("sorts and paginates deterministically", async () => {
      const { service, sunday, premier, highRollers } = seed();

      const page1 = await service.getLeagues({ sortBy: "entryFee", sortOrder: "asc", pageSize: 2, page: 1 });
      const page2 = await service.getLeagues({ sortBy: "entryFee", sortOrder: "asc", pageSize: 2, page: 2 });

      assert.deepEqual(page1.items.map((l: any) => l.id), [sunday.id, premier.id]);
      assert.deepEqual(page2.items.map((l: any) => l.id), [highRollers.id]);
      assert.equal(page1.total, 3);
    });

    it("never reveals a private league's invite code via getLeagueById", async () => {
      const { service, secret } = seed();
      assert.equal((await service.getLeagueById(secret.id, "someone")).inviteCode, null);
      assert.equal((await service.getLeagueById(secret.id)).inviteCode, null);
      assert.equal((await service.getLeagueById(secret.id, CREATOR)).inviteCode, secret.inviteCode);
    });
  });
});

describe("Private league invitations", () => {
  function setup() {
    const db = createMockDb();
    const league = db.addLeague({ name: "Office League", isPrivate: true });
    return { db, league, service: new LeagueService(db) };
  }

  it("creates a single-use token that is stored only as a hash", async () => {
    const { db, league, service } = setup();
    const invitation = await service.createInvitation(league.id, CREATOR, 24);

    assert.ok(invitation.token.length >= 43);
    const stored = db.state.invitations[0];
    assert.equal(stored.tokenHash, LeagueService.hashInvitationToken(invitation.token));
    assert.ok(!JSON.stringify(stored).includes(invitation.token));

    const ttlHours = (stored.expiresAt.getTime() - Date.now()) / 3_600_000;
    assert.ok(ttlHours > 23.9 && ttlHours <= 24);
  });

  it("only lets the creator manage invitations, and only for private leagues", async () => {
    const { db, league, service } = setup();
    const publicLeague = db.addLeague({ isPrivate: false });

    await assert.rejects(() => service.createInvitation(league.id, "intruder"), LeagueForbiddenError);
    await assert.rejects(() => service.listInvitations(league.id, "intruder"), LeagueForbiddenError);
    await assert.rejects(() => service.createInvitation(publicLeague.id, CREATOR), LeagueValidationError);
    await assert.rejects(() => service.createInvitation("missing", CREATOR), LeagueNotFoundError);
    await assert.rejects(() => service.createInvitation(league.id, CREATOR, 0), LeagueValidationError);
    await assert.rejects(
      () => service.createInvitation(league.id, CREATOR, INVITATION_MAX_TTL_HOURS + 1),
      LeagueValidationError
    );
  });

  it("previews and redeems an invitation, consuming it", async () => {
    const { db, league, service } = setup();
    const { token } = await service.createInvitation(league.id, CREATOR);

    const preview = await service.previewInvitation(token);
    assert.equal(preview.league.id, league.id);

    const member = await service.acceptInvitation(token, "user-a", "squad-a");
    assert.equal(member.leagueId, league.id);
    assert.equal(member.status, MembershipStatus.ACTIVE);
    assert.equal(db.state.invitations[0].usedById, "user-a");
    assert.equal(db.state.leagues[0].currentMembers, 2);

    await assert.rejects(() => service.acceptInvitation(token, "user-b", "squad-b"), /already been used/);
    await assert.rejects(() => service.previewInvitation(token), LeagueInvitationError);
  });

  it("admits exactly one user when the same link is redeemed concurrently", async () => {
    const { db, league, service } = setup();
    const { token } = await service.createInvitation(league.id, CREATOR);

    const results = await Promise.allSettled([
      service.acceptInvitation(token, "user-a", "squad-a"),
      service.acceptInvitation(token, "user-b", "squad-b"),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof LeagueInvitationError);
    assert.equal(db.state.members.length, 1);
  });

  it("rejects expired, revoked and unknown links", async () => {
    const { db, league, service } = setup();

    const expired = await service.createInvitation(league.id, CREATOR, 1);
    db.state.invitations[0].expiresAt = new Date(Date.now() - 1_000);
    await assert.rejects(() => service.acceptInvitation(expired.token, "user-a", "squad-a"), /expired/);

    const revoked = await service.createInvitation(league.id, CREATOR);
    await service.revokeInvitation(league.id, revoked.id, CREATOR);
    await assert.rejects(() => service.acceptInvitation(revoked.token, "user-a", "squad-a"), /revoked/);
    await assert.rejects(() => service.revokeInvitation(league.id, revoked.id, CREATOR), LeagueInvitationError);

    await assert.rejects(
      () => service.acceptInvitation(LeagueService.generateInvitationToken(), "user-a", "squad-a"),
      /invalid/
    );

    const states = (await service.listInvitations(league.id, CREATOR)).map((i: any) => i.state).sort();
    assert.deepEqual(states, ["EXPIRED", "REVOKED"]);
    assert.equal(db.state.members.length, 0);
  });

  it("requires an invitation to join a private league directly", async () => {
    const { league, service } = setup();
    await assert.rejects(() => service.joinLeague(league.id, "user-a", "squad-a"), LeagueForbiddenError);
  });

  it("does not accept an invitation for a different league", async () => {
    const { db, league, service } = setup();
    const other = db.addLeague({ isPrivate: true });
    const { token } = await service.createInvitation(other.id, CREATOR);

    await assert.rejects(
      () => service.joinLeague(league.id, "user-a", "squad-a", { invitationToken: token }),
      LeagueInvitationError
    );
    assert.equal(db.state.invitations[0].usedAt, null);
  });

  it("blocks the payment flow from creating a private league membership", async () => {
    const { db, league } = setup();
    const financialDb: any = {
      league: { findUnique: async () => ({ ...league, entryFee: 10 }) },
      squad: { findUnique: async () => ({ id: "squad-a", userId: "user-a" }) },
      leagueMember: { findUnique: async () => null, create: async () => assert.fail("must not create") },
    };
    await assert.rejects(
      () => new FinancialService(financialDb, {} as any).createPaymentRequirement("user-a", league.id, "squad-a"),
      FinancialForbiddenError
    );
    assert.equal(db.state.members.length, 0);
  });
});

describe("League routes input validation", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/leagues", leagueRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("returns 400 for invalid search filters", async () => {
    const res = await fetch(`${baseUrl}/api/v1/leagues?minEntryFee=10&maxEntryFee=1`);
    assert.equal(res.status, 400);
  });

  it("returns 410 for a malformed invitation token", async () => {
    const res = await fetch(`${baseUrl}/api/v1/leagues/invitations/short`);
    assert.equal(res.status, 410);
  });

  it("requires authentication to accept or create invitations", async () => {
    const accept = await fetch(`${baseUrl}/api/v1/leagues/invitations/${"a".repeat(43)}/accept`, { method: "POST" });
    assert.equal(accept.status, 401);
    const create = await fetch(`${baseUrl}/api/v1/leagues/some-id/invitations`, { method: "POST" });
    assert.equal(create.status, 401);
  });
});
