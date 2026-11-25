import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  LEAGUE_CANCELLED_EVENT,
  LeagueForbiddenError,
  LeagueNotFoundError,
  LeagueService,
  LeagueValidationError,
} from "../services/league/leagueService.js";
import {
  FinancialService,
  FinancialValidationError,
} from "../services/financial/financialService.js";
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  TransactionType,
} from "../types/index.js";
import { createInMemoryFailedPayouts } from "./helpers/inMemoryFailedPayouts.js";

/**
 * Dead-league cancellation and stake refund worker (issue #509).
 *
 * Covers the scheduled worker end to end against an in-memory stand-in for
 * Prisma: an under-subscribed league reaching its start gameweek deadline is
 * cancelled, every joined manager is notified, and every paid member's full
 * entry fee is queued for refund with no fee deducted. No live database,
 * Redis, or Stellar network is touched.
 */

const LEAGUE_ID = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";

const DEADLINE = new Date("2026-09-01T10:00:00Z");
const FIRST_KICKOFF = new Date("2026-09-01T11:30:00Z");

interface MockMember {
  id: string;
  userId: string;
  hasPaid: boolean;
  paymentStatus: PaymentStatus;
  status: MembershipStatus;
  stellarAddress: string | null;
}

interface MockLeague {
  id: string;
  name: string;
  status: LeagueStatus;
  minMembers: number;
  currentMembers: number;
  entryFee: number;
  isPrivate: boolean;
  creatorId: string;
  startGameweek: { id: number; deadline: Date };
  endGameweek: { id: number; deadline: Date };
  members: MockMember[];
}

function mockMember(
  id: string,
  userId: string,
  overrides: Partial<MockMember> = {}
): MockMember {
  return {
    id,
    userId,
    hasPaid: true,
    paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
    status: MembershipStatus.ACTIVE,
    stellarAddress: Keypair.random().publicKey(),
    ...overrides,
  };
}

function mockLeague(overrides: Partial<MockLeague> & { members: MockMember[] }): MockLeague {
  const league: MockLeague = {
    id: LEAGUE_ID,
    name: "Dead League",
    status: LeagueStatus.UPCOMING,
    minMembers: 4,
    currentMembers: 2,
    entryFee: 5,
    isPrivate: true,
    creatorId: "creator-1",
    startGameweek: { id: 1, deadline: DEADLINE },
    endGameweek: { id: 2, deadline: new Date("2026-12-01T10:00:00Z") },
    ...overrides,
  };
  return league;
}

/** In-memory Prisma stand-in shared by LeagueService and FinancialService. */
function createMockDb(leagues: MockLeague[]) {
  const transactions: any[] = [];
  const allMembers = () => leagues.flatMap((l) => l.members);
  const findLeague = (id: string) => leagues.find((l) => l.id === id);

  const db: any = {
    leagues,
    transactions,
    league: {
      findMany: async ({ where }: any) =>
        leagues.filter((l) => (where?.status ? l.status === where.status : true)),
      findUnique: async ({ where }: any) => findLeague(where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(findLeague(where.id)!, data),
    },
    leagueMember: {
      findMany: async ({ where }: any) =>
        allMembers().filter((m) =>
          where?.leagueId
            ? leagues.find((l) => l.id === where.leagueId)?.members.includes(m)
            : true
        ),
      update: async ({ where, data }: any) =>
        Object.assign(allMembers().find((m) => m.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const league of leagues) {
          if (where?.leagueId && league.id !== where.leagueId) continue;
          for (const member of league.members) {
            if (where?.paymentStatus && member.paymentStatus !== where.paymentStatus) continue;
            Object.assign(member, data);
            count++;
          }
        }
        return { count };
      },
    },
    transaction: {
      create: async ({ data }: any) => {
        transactions.push(data);
        return data;
      },
    },
    gameweek: { findMany: async () => [] },
    leagueFixture: {
      createMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    failedPayout: createInMemoryFailedPayouts(),
    $transaction: async (opsOrFn: any) =>
      typeof opsOrFn === "function" ? opsOrFn(db) : Promise.all(opsOrFn),
  };
  return db;
}

function createFakeHub() {
  const published: Array<{ userId: string; type: string; data: any }> = [];
  const hub: any = {
    published,
    publish(userId: string, type: string, data: any) {
      published.push({ userId, type, data });
      return 1;
    },
  };
  return hub;
}

describe("Dead-league worker: deadline trigger (issue #509)", () => {
  it("fires at the deadline, not at the first kickoff that follows it", () => {
    const underfilled = { currentMembers: 2, minMembers: 4 };
    // Deadline 10:00 has passed but the 11:30 kickoff has not: the old
    // kickoff gate would wait, the deadline trigger fires now.
    assert.equal(
      LeagueService.isUnderfilledAtDeadline(underfilled, { deadline: DEADLINE }, new Date("2026-09-01T10:30:00Z")),
      true
    );
    assert.equal(
      LeagueService.isUnderfilledAfterKickoff(
        underfilled,
        { deadline: DEADLINE, firstKickoff: FIRST_KICKOFF },
        new Date("2026-09-01T10:30:00Z")
      ),
      false
    );
  });

  it("fires exactly when the deadline is reached, and not one millisecond before", () => {
    const underfilled = { currentMembers: 3, minMembers: 4 };
    assert.equal(
      LeagueService.isUnderfilledAtDeadline(underfilled, { deadline: DEADLINE }, new Date(DEADLINE.getTime())),
      true
    );
    assert.equal(
      LeagueService.isUnderfilledAtDeadline(underfilled, { deadline: DEADLINE }, new Date(DEADLINE.getTime() - 1)),
      false
    );
  });

  it("does not fire at exactly minMembers, and fires one member below", () => {
    assert.equal(
      LeagueService.isUnderfilledAtDeadline({ currentMembers: 4, minMembers: 4 }, { deadline: DEADLINE }, new Date("2026-09-02T00:00:00Z")),
      false
    );
    assert.equal(
      LeagueService.isUnderfilledAtDeadline({ currentMembers: 3, minMembers: 4 }, { deadline: DEADLINE }, new Date("2026-09-02T00:00:00Z")),
      true
    );
  });
});

describe("Dead-league worker: cancellation and manager notification", () => {
  it("cancels an under-subscribed private league at the deadline and notifies every joined manager", async () => {
    const league = mockLeague({
      members: [
        mockMember("m1", "u1"),
        mockMember("m2", "u2", { hasPaid: false, paymentStatus: PaymentStatus.PENDING, stellarAddress: null }),
      ],
    });
    const db = createMockDb([league]);
    const hub = createFakeHub();
    const service = new LeagueService(db, hub);

    const cancelled = await service.cancelUnderfilledLeagues(new Date("2026-09-01T10:00:00Z"));

    assert.deepEqual(cancelled, [LEAGUE_ID]);
    assert.equal(league.status, LeagueStatus.CANCELLED);
    // Paid members are queued for refund; every member is marked refunded.
    assert.equal(league.members[0].paymentStatus, PaymentStatus.REFUND_PENDING);
    assert.equal(league.members[1].paymentStatus, PaymentStatus.PENDING);
    assert.ok(league.members.every((m) => m.status === MembershipStatus.REFUNDED));

    assert.equal(hub.published.length, 2);
    const paidNotice = hub.published.find((p: any) => p.userId === "u1");
    assert.equal(paidNotice.type, LEAGUE_CANCELLED_EVENT);
    assert.equal(paidNotice.data.leagueId, LEAGUE_ID);
    assert.equal(paidNotice.data.leagueName, "Dead League");
    assert.equal(paidNotice.data.minMembers, 4);
    assert.equal(paidNotice.data.currentMembers, 2);
    // Full entry fee owed back, no fee deducted.
    assert.equal(paidNotice.data.entryFee, 5);
    assert.equal(paidNotice.data.refundAmount, 5);
    assert.match(paidNotice.data.reason, /cancelled/i);
    assert.match(paidNotice.data.reason, /full entry fee of 5/);
    assert.match(paidNotice.data.reason, /no fee deducted/);

    const unpaidNotice = hub.published.find((p: any) => p.userId === "u2");
    assert.equal(unpaidNotice.data.refundAmount, 0);
    assert.match(unpaidNotice.data.reason, /No entry fee was taken/);
  });

  it("leaves a league alone before its deadline", async () => {
    const league = mockLeague({ members: [mockMember("m1", "u1")] });
    const db = createMockDb([league]);
    const hub = createFakeHub();
    const service = new LeagueService(db, hub);

    const cancelled = await service.cancelUnderfilledLeagues(new Date(DEADLINE.getTime() - 1000));

    assert.deepEqual(cancelled, []);
    assert.equal(league.status, LeagueStatus.UPCOMING);
    assert.equal(hub.published.length, 0);
  });

  it("leaves a league that exactly meets minMembers alone after its deadline", async () => {
    const league = mockLeague({
      currentMembers: 4,
      members: [
        mockMember("m1", "u1"),
        mockMember("m2", "u2"),
        mockMember("m3", "u3"),
        mockMember("m4", "u4"),
      ],
    });
    const db = createMockDb([league]);
    const hub = createFakeHub();
    const service = new LeagueService(db, hub);

    const cancelled = await service.cancelUnderfilledLeagues(new Date("2026-09-02T00:00:00Z"));

    assert.deepEqual(cancelled, []);
    assert.equal(league.status, LeagueStatus.UPCOMING);
    assert.equal(hub.published.length, 0);
  });

  it("is idempotent: a league reaching its deadline twice is cancelled and notified once", async () => {
    const league = mockLeague({ members: [mockMember("m1", "u1"), mockMember("m2", "u2")] });
    const db = createMockDb([league]);
    const hub = createFakeHub();
    const service = new LeagueService(db, hub);
    const now = new Date("2026-09-01T10:00:00Z");

    assert.deepEqual(await service.cancelUnderfilledLeagues(now), [LEAGUE_ID]);
    assert.deepEqual(await service.cancelUnderfilledLeagues(now), []);
    assert.deepEqual(await service.cancelUnderfilledLeagues(new Date("2026-09-03T00:00:00Z")), []);

    assert.equal(hub.published.length, 2);
    assert.equal(league.members[0].paymentStatus, PaymentStatus.REFUND_PENDING);
  });

  it("skips leagues that are already cancelled and never re-notifies their managers", async () => {
    const league = mockLeague({
      status: LeagueStatus.CANCELLED,
      members: [mockMember("m1", "u1")],
    });
    const db = createMockDb([league]);
    const hub = createFakeHub();
    const service = new LeagueService(db, hub);

    assert.deepEqual(await service.cancelUnderfilledLeagues(new Date("2026-09-02T00:00:00Z")), []);
    assert.equal(hub.published.length, 0);
  });
});

describe("Dead-league worker: authorization", () => {
  it("still refuses manual cancellation by anyone but the creator", async () => {
    const league = mockLeague({ members: [mockMember("m1", "u1")] });
    const db = createMockDb([league]);
    const service = new LeagueService(db, createFakeHub());

    await assert.rejects(() => service.cancelLeague(LEAGUE_ID, "intruder-9"), LeagueForbiddenError);
    assert.equal(league.status, LeagueStatus.UPCOMING);
  });

  it("lets the creator cancel manually, and refuses a second cancel from a terminal state", async () => {
    const league = mockLeague({ members: [mockMember("m1", "u1")] });
    const db = createMockDb([league]);
    const service = new LeagueService(db, createFakeHub());

    const cancelled = await service.cancelLeague(LEAGUE_ID, "creator-1");
    assert.equal(cancelled.status, LeagueStatus.CANCELLED);
    await assert.rejects(() => service.cancelLeague(LEAGUE_ID, "creator-1"), LeagueValidationError);
  });

  it("rejects manual cancellation of an unknown league", async () => {
    const db = createMockDb([]);
    const service = new LeagueService(db, createFakeHub());

    await assert.rejects(() => service.cancelLeague("missing-league", "creator-1"), LeagueNotFoundError);
  });
});

describe("Dead-league worker: full-fee refunds", () => {
  function cancelledLeagueDb() {
    const league = mockLeague({
      status: LeagueStatus.CANCELLED,
      members: [
        mockMember("m1", "u1", { paymentStatus: PaymentStatus.REFUND_PENDING }),
        mockMember("m2", "u2", { paymentStatus: PaymentStatus.REFUND_PENDING }),
        mockMember("m3", "u3", { paymentStatus: PaymentStatus.REFUND_PENDING }),
        mockMember("m4", "u4", { hasPaid: false, paymentStatus: PaymentStatus.PENDING, stellarAddress: null }),
      ],
    });
    // transitionStatus marks every member REFUNDED; the refundable ones stay
    // REFUND_PENDING until the refund worker pays them.
    league.members.forEach((m) => {
      m.status = MembershipStatus.REFUNDED;
    });
    return { league, db: createMockDb([league]) };
  }

  it("queues 100% of each deposited entry fee for refund with no fee deducted", async () => {
    const { league, db } = cancelledLeagueDb();
    const dispatchCalls: Array<{ recipients: string[] }> = [];
    const stellar: any = {
      refundParticipants: async (_leagueId: bigint, recipients: string[]) => {
        dispatchCalls.push({ recipients });
        return { success: true, txHash: "c".repeat(64) };
      },
    };

    const report = await new FinancialService(db, stellar).processLeagueRefunds(LEAGUE_ID);

    assert.equal(report.refundedMemberIds.length, 3);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].recipients.length, 3);
    assert.equal(db.transactions.length, 3);
    assert.ok(db.transactions.every((t: any) => t.type === TransactionType.REFUND));
    assert.ok(db.transactions.every((t: any) => t.amount === league.entryFee));
    const total = db.transactions.reduce((sum: number, t: any) => sum + t.amount, 0);
    assert.equal(total, 3 * league.entryFee);
    assert.ok(db.transactions.every((t: any) => t.leagueId === LEAGUE_ID));
    assert.ok(league.members.slice(0, 3).every((m) => m.paymentStatus === PaymentStatus.REFUNDED));
  });

  it("does not re-dispatch refunds on a second run once members are refunded", async () => {
    const { league, db } = cancelledLeagueDb();
    let dispatchCount = 0;
    const stellar: any = {
      refundParticipants: async () => {
        dispatchCount++;
        return { success: true, txHash: "d".repeat(64) };
      },
    };
    const service = new FinancialService(db, stellar);

    await service.processLeagueRefunds(LEAGUE_ID);
    const second = await service.processLeagueRefunds(LEAGUE_ID);

    assert.equal(dispatchCount, 1);
    assert.equal(second.refundedMemberIds.length, 0);
    assert.equal(second.batches, 0);
    assert.equal(db.transactions.length, 3);
  });

  it("refuses to refund a league that is not cancelled", async () => {
    const league = mockLeague({ members: [mockMember("m1", "u1")] });
    const db = createMockDb([league]);
    await assert.rejects(
      () => new FinancialService(db, {} as any).processLeagueRefunds(LEAGUE_ID),
      FinancialValidationError
    );
  });
});

describe("Dead-league worker: integration (deadline arrival)", () => {
  it("simulates an under-subscribed league hitting its deadline: cancel, notify, refund in full", async () => {
    const league = mockLeague({
      currentMembers: 3,
      members: [
        mockMember("m1", "u1"),
        mockMember("m2", "u2"),
        mockMember("m3", "u3", { hasPaid: false, paymentStatus: PaymentStatus.PENDING, stellarAddress: null }),
      ],
    });
    const db = createMockDb([league]);
    const hub = createFakeHub();
    const leagueService = new LeagueService(db, hub);
    const dispatchCalls: string[][] = [];
    const stellar: any = {
      refundParticipants: async (_leagueId: bigint, recipients: string[]) => {
        dispatchCalls.push(recipients);
        return { success: true, txHash: "e".repeat(64) };
      },
    };
    const financialService = new FinancialService(db, stellar);

    // 1. Before the deadline nothing happens.
    assert.deepEqual(await leagueService.cancelUnderfilledLeagues(new Date(DEADLINE.getTime() - 60_000)), []);
    assert.equal(league.status, LeagueStatus.UPCOMING);

    // 2. The deadline arrives: the worker cancels the league and notifies
    //    every joined manager.
    const cancelled = await leagueService.cancelUnderfilledLeagues(new Date(DEADLINE));
    assert.deepEqual(cancelled, [LEAGUE_ID]);
    assert.equal(league.status, LeagueStatus.CANCELLED);
    assert.equal(hub.published.length, 3);
    assert.ok(
      hub.published.every((p: any) => p.type === LEAGUE_CANCELLED_EVENT && p.data.leagueId === LEAGUE_ID)
    );
    assert.deepEqual(
      hub.published.map((p: any) => p.data.refundAmount).sort(),
      [0, 5, 5]
    );

    // 3. The refund leg pays every paid manager their full entry fee.
    const report = await financialService.processLeagueRefunds(LEAGUE_ID);
    assert.equal(report.refundedMemberIds.length, 2);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].length, 2);
    assert.equal(db.transactions.length, 2);
    assert.ok(db.transactions.every((t: any) => t.amount === 5 && t.type === TransactionType.REFUND));
    assert.ok(league.members.slice(0, 2).every((m) => m.paymentStatus === PaymentStatus.REFUNDED));

    // 4. A repeat run of the whole worker is a no-op: no second
    //    cancellation, notification, or refund.
    assert.deepEqual(await leagueService.cancelUnderfilledLeagues(new Date(DEADLINE)), []);
    const repeat = await financialService.processLeagueRefunds(LEAGUE_ID);
    assert.equal(repeat.refundedMemberIds.length, 0);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(db.transactions.length, 2);
    assert.equal(hub.published.length, 3);
  });
});
