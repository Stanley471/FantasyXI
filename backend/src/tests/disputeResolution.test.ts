import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  FinancialService,
  FinancialValidationError,
  FinancialForbiddenError,
  FinancialConflictError,
} from "../services/financial/financialService.js";
import {
  DisputeResolutionService,
  DisputeStatus,
} from "../services/financial/disputeResolutionService.js";
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  UserRole,
} from "../types/index.js";

const wallet1 = Keypair.random().publicKey();
const wallet2 = Keypair.random().publicKey();
const wallet3 = Keypair.random().publicKey();

const LEAGUE_ID = "11111111-2222-3333-4444-555555555555";
const FREEZE_TX_HASH =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNFREEZE_TX_HASH =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SETTLE_TX_HASH =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REFUND_TX_HASH =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function createDisputeTestEnv(stellarOverrides?: Record<string, unknown>) {
  const state = {
    leagues: new Map<string, any>(),
    users: new Map<string, any>(),
    members: new Map<string, any>(),
    transactions: new Map<string, any>(),
    disputes: new Map<string, any>(),
    rulingLogs: new Map<string, any>(),
    auditEvents: [] as any[],
    freezeCalls: [] as Array<{ contractLeagueId: bigint; reason: string }>,
    unfreezeCalls: [] as Array<{ contractLeagueId: bigint }>,
  };

  // Seed default users
  state.users.set("admin_1", {
    id: "admin_1",
    email: "admin@fantasyxi.io",
    username: "admin1",
    role: UserRole.ADMIN,
  });
  state.users.set("mod_1", {
    id: "mod_1",
    email: "mod@fantasyxi.io",
    username: "mod1",
    role: UserRole.MODERATOR,
  });
  state.users.set("user_1", {
    id: "user_1",
    email: "u1@fantasyxi.io",
    username: "user1",
    role: UserRole.USER,
    stellarAddress: wallet1,
  });
  state.users.set("user_2", {
    id: "user_2",
    email: "u2@fantasyxi.io",
    username: "user2",
    role: UserRole.USER,
    stellarAddress: wallet2,
  });
  state.users.set("user_3", {
    id: "user_3",
    email: "u3@fantasyxi.io",
    username: "user3",
    role: UserRole.USER,
    stellarAddress: wallet3,
  });
  state.users.set("outsider_1", {
    id: "outsider_1",
    email: "outsider@fantasyxi.io",
    username: "outsider",
    role: UserRole.USER,
  });

  // Seed default active league ready for settlement (3 active paid members, 100 USDC entry fee => 300 USDC pool)
  const members = [
    {
      id: "m_1",
      leagueId: LEAGUE_ID,
      userId: "user_1",
      squadId: "sq_1",
      stellarAddress: wallet1,
      status: MembershipStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
      rank: 1,
      totalPoints: 240,
      joinedAt: new Date("2026-01-01T00:00:00Z"),
      user: state.users.get("user_1"),
      squad: { id: "sq_1", name: "Squad 1", totalPoints: 240 },
    },
    {
      id: "m_2",
      leagueId: LEAGUE_ID,
      userId: "user_2",
      squadId: "sq_2",
      stellarAddress: wallet2,
      status: MembershipStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
      rank: 2,
      totalPoints: 200,
      joinedAt: new Date("2026-01-02T00:00:00Z"),
      user: state.users.get("user_2"),
      squad: { id: "sq_2", name: "Squad 2", totalPoints: 200 },
    },
    {
      id: "m_3",
      leagueId: LEAGUE_ID,
      userId: "user_3",
      squadId: "sq_3",
      stellarAddress: wallet3,
      status: MembershipStatus.ACTIVE,
      paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
      rank: 3,
      totalPoints: 175,
      joinedAt: new Date("2026-01-03T00:00:00Z"),
      user: state.users.get("user_3"),
      squad: { id: "sq_3", name: "Squad 3", totalPoints: 175 },
    },
  ];
  for (const m of members) {
    state.members.set(m.id, m);
  }

  state.leagues.set(LEAGUE_ID, {
    id: LEAGUE_ID,
    name: "Premier Escrow League",
    creatorId: "user_1",
    entryFee: 100,
    prizePool: 300,
    platformFeePercent: 5,
    status: LeagueStatus.ACTIVE,
    escrowFrozen: false,
    endGameweekId: 38,
    endGameweek: { id: 38, isFinished: true },
  });

  const mockDb: any = {
    state,
    user: {
      findUnique: async ({ where }: any) => state.users.get(where.id) || null,
    },
    league: {
      findUnique: async ({ where }: any) => {
        const league = state.leagues.get(where.id);
        if (!league) return null;
        const leagueMembers = Array.from(state.members.values()).filter(
          (m) => m.leagueId === where.id
        );
        const leagueDisputes = Array.from(state.disputes.values()).filter(
          (d) =>
            d.leagueId === where.id &&
            (d.status === DisputeStatus.OPEN ||
              d.status === DisputeStatus.UNDER_REVIEW)
        );
        const leagueTransactions = Array.from(state.transactions.values()).filter(
          (t) => t.leagueId === where.id
        );
        return {
          ...league,
          members: leagueMembers,
          disputes: leagueDisputes,
          transactions: leagueTransactions,
        };
      },
      update: async ({ where, data }: any) => {
        const current = state.leagues.get(where.id);
        const updated = { ...current, ...data };
        state.leagues.set(where.id, updated);
        return updated;
      },
    },
    leagueMember: {
      update: async ({ where, data }: any) => {
        const current = state.members.get(where.id);
        const updated = { ...current, ...data };
        state.members.set(where.id, updated);
        return updated;
      },
    },
    transaction: {
      create: async ({ data }: any) => {
        const id = `tx_${state.transactions.size + 1}`;
        const record = { id, ...data };
        state.transactions.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const current = state.transactions.get(where.id);
        const updated = { ...current, ...data };
        state.transactions.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const [id, tx] of state.transactions.entries()) {
          if (where.stellarTxHash && tx.stellarTxHash === where.stellarTxHash) {
            state.transactions.set(id, { ...tx, ...data });
            count++;
          }
        }
        return { count };
      },
    },
    paymentDispute: {
      create: async ({ data }: any) => {
        const id = `dispute_${state.disputes.size + 1}`;
        const now = new Date();
        const record = {
          id,
          reviewedById: null,
          reviewedAt: null,
          resolvedById: null,
          resolvedAt: null,
          rulingJustification: null,
          resolutionTxHash: null,
          resolutionMetadata: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        state.disputes.set(id, record);
        return record;
      },
      findUnique: async ({ where, include }: any) => {
        const dispute = state.disputes.get(where.id);
        if (!dispute) return null;
        if (include?.rulingLogs) {
          const logs = Array.from(state.rulingLogs.values())
            .filter((l) => l.disputeId === dispute.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return { ...dispute, rulingLogs: logs };
        }
        return dispute;
      },
      findMany: async ({ where, include }: any = {}) => {
        let items = Array.from(state.disputes.values());
        if (where?.leagueId) {
          items = items.filter((d) => d.leagueId === where.leagueId);
        }
        if (where?.status) {
          if (typeof where.status === "string") {
            items = items.filter((d) => d.status === where.status);
          } else if (Array.isArray(where.status.in)) {
            items = items.filter((d) => where.status.in.includes(d.status));
          }
        }
        if (include?.rulingLogs) {
          items = items.map((d) => ({
            ...d,
            rulingLogs: Array.from(state.rulingLogs.values())
              .filter((l) => l.disputeId === d.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
          }));
        }
        return items;
      },
      update: async ({ where, data }: any) => {
        const current = state.disputes.get(where.id);
        const updated = { ...current, ...data, updatedAt: new Date() };
        state.disputes.set(where.id, updated);
        return updated;
      },
    },
    disputeRulingLog: {
      findMany: async ({ where }: any) => {
        return Array.from(state.rulingLogs.values())
          .filter((l) => !where?.disputeId || l.disputeId === where.disputeId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      create: async ({ data }: any) => {
        const id = `ruling_log_${state.rulingLogs.size + 1}`;
        const record = { id, ...data };
        state.rulingLogs.set(id, record);
        return record;
      },
    },
    $transaction: async (ops: any) => {
      if (typeof ops === "function") {
        return ops(mockDb);
      }
      return Promise.all(ops);
    },
  };

  const mockStellar: any = {
    isValidStellarAddress: (addr: string) =>
      typeof addr === "string" && addr.startsWith("G") && addr.length === 56,
    isValidTransactionHash: (hash: string) => /^[0-9a-fA-F]{64}$/.test(hash),
    freezeLeagueEscrow: async (contractLeagueId: bigint, reason: string) => {
      state.freezeCalls.push({ contractLeagueId, reason });
      return {
        success: true,
        txHash: FREEZE_TX_HASH,
        ledgerSeq: 901001,
        confirmedAt: new Date(),
      };
    },
    unfreezeLeagueEscrow: async (contractLeagueId: bigint) => {
      state.unfreezeCalls.push({ contractLeagueId });
      return {
        success: true,
        txHash: UNFREEZE_TX_HASH,
        ledgerSeq: 901002,
        confirmedAt: new Date(),
      };
    },
    settleLeague: async () => ({
      success: true,
      txHash: SETTLE_TX_HASH,
      ledgerSeq: 901003,
      confirmedAt: new Date(),
    }),
    refundParticipants: async () => ({
      success: true,
      txHash: REFUND_TX_HASH,
      ledgerSeq: 901004,
      confirmedAt: new Date(),
    }),
    ...stellarOverrides,
  };

  const mockDeadLetters: any = {
    getAutoRetryable: async () => [],
    getIsolatedMemberIds: async () => new Set<string>(),
    deadLetter: async (entry: any) => ({ id: "dl_1", ...entry }),
  };

  const mockAudit = {
    record: (entry: any) => {
      state.auditEvents.push(entry);
    },
  };

  const financialService = new FinancialService(
    mockDb,
    mockStellar,
    mockDeadLetters,
    mockAudit
  );
  const disputeService = new DisputeResolutionService(
    mockDb,
    mockStellar,
    financialService,
    mockAudit
  );

  return {
    state,
    mockDb,
    mockStellar,
    financialService,
    disputeService,
  };
}

describe("Payment Dispute Resolution & Automated Escrow Freeze (Issue #364)", () => {
  describe("Automated Escrow Freeze & Settlement Blocking", () => {
    it("freezes the Soroban escrow contract when a participant files a dispute and blocks settlement", async () => {
      const { state, financialService, disputeService } = createDisputeTestEnv();

      // Before dispute: league is eligible for settlement
      const planBefore = await financialService.prepareSettlement(
        LEAGUE_ID,
        "user_1"
      );
      assert.equal(planBefore.canSettle, true);

      // Participant files a dispute
      const { dispute, rulingLog } = await disputeService.fileDispute({
        leagueId: LEAGUE_ID,
        reporterId: "user_2",
        category: "SCORING_ANOMALY",
        reason: "Gameweek 38 stat correction missing for captain assist points",
        evidence: { matchId: "m_991", playerId: "p_10" },
      });

      assert.equal(dispute.status, DisputeStatus.OPEN);
      assert.equal(dispute.escrowFrozen, true);
      assert.equal(dispute.freezeTxHash, FREEZE_TX_HASH);
      assert.equal(state.freezeCalls.length, 1);
      assert.equal(state.leagues.get(LEAGUE_ID).escrowFrozen, true);
      assert.equal(rulingLog.fromStatus, null);
      assert.equal(rulingLog.toStatus, DisputeStatus.OPEN);
      assert.equal(rulingLog.executionTxHash, FREEZE_TX_HASH);

      // While frozen: prepareSettlement reports canSettle=false and executeSettlement throws FinancialConflictError
      const planDuring = await financialService.prepareSettlement(
        LEAGUE_ID,
        "user_1"
      );
      assert.equal(planDuring.canSettle, false);
      assert.match(planDuring.unsettledReason || "", /frozen/i);

      await assert.rejects(
        () => financialService.executeSettlement(LEAGUE_ID, "admin_1"),
        (err: unknown) => {
          assert.ok(err instanceof FinancialConflictError);
          assert.match(err.message, /frozen/i);
          return true;
        }
      );
    });

    it("rejects dispute filing from non-participants or when reason is too short", async () => {
      const { disputeService } = createDisputeTestEnv();

      await assert.rejects(
        () =>
          disputeService.fileDispute({
            leagueId: LEAGUE_ID,
            reporterId: "outsider_1",
            reason: "I am not in this league but want to freeze it",
          }),
        FinancialForbiddenError
      );

      await assert.rejects(
        () =>
          disputeService.fileDispute({
            leagueId: LEAGUE_ID,
            reporterId: "user_1",
            reason: "too short",
          }),
        FinancialValidationError
      );
    });
  });

  describe("Dispute State Machine & Administrative Resolution", () => {
    it("transitions OPEN -> UNDER_REVIEW -> RESOLVED_PAYOUT, unfreezes escrow, and executes standard 60/30/10 prize payout", async () => {
      const { state, disputeService } = createDisputeTestEnv();

      const { dispute: opened } = await disputeService.fileDispute({
        leagueId: LEAGUE_ID,
        reporterId: "user_2",
        category: "PAYOUT_ANOMALY",
        reason: "Verifying final rank tie-breaker before prize distribution",
      });

      const { dispute: underReview, rulingLog: reviewLog } =
        await disputeService.markUnderReview(opened.id, {
          adminUserId: "mod_1",
          justification: "Inspecting gameweek 38 tie-breaker logs",
        });

      assert.equal(underReview.status, DisputeStatus.UNDER_REVIEW);
      assert.equal(underReview.reviewedById, "mod_1");
      assert.equal(reviewLog.fromStatus, DisputeStatus.OPEN);
      assert.equal(reviewLog.toStatus, DisputeStatus.UNDER_REVIEW);

      // Resolve with RESOLVED_PAYOUT
      const outcome = await disputeService.resolveDispute(opened.id, {
        adminUserId: "admin_1",
        ruling: DisputeStatus.RESOLVED_PAYOUT,
        justification:
          "Tie-breaker verified against official Opta feed; standings are accurate. Releasing standard payout.",
      });

      assert.equal(outcome.dispute.status, DisputeStatus.RESOLVED_PAYOUT);
      assert.equal(outcome.dispute.escrowFrozen, false);
      assert.equal(outcome.dispute.resolutionTxHash, SETTLE_TX_HASH);
      assert.ok(outcome.settlementReport);
      assert.equal(outcome.settlementReport?.stellarTxHash, SETTLE_TX_HASH);
      assert.equal(outcome.settlementReport?.winnerTransactionCount, 3);
      assert.equal(state.unfreezeCalls.length, 1);
      assert.equal(state.leagues.get(LEAGUE_ID).status, LeagueStatus.COMPLETED);
      assert.equal(state.leagues.get(LEAGUE_ID).escrowFrozen, false);

      // Terminal state cannot transition again
      await assert.rejects(
        () =>
          disputeService.markUnderReview(opened.id, {
            adminUserId: "admin_1",
            justification: "Attempting to reopen terminal dispute",
          }),
        FinancialConflictError
      );
    });

    it("blocks RESOLVED_PAYOUT when another dispute on the same league remains unresolved", async () => {
      const { disputeService } = createDisputeTestEnv();

      const { dispute: d1 } = await disputeService.fileDispute({
        leagueId: LEAGUE_ID,
        reporterId: "user_1",
        category: "SCORING_ANOMALY",
        reason: "First participant dispute on scoring feed",
      });

      const { dispute: d2 } = await disputeService.fileDispute({
        leagueId: LEAGUE_ID,
        reporterId: "user_2",
        category: "PAYOUT_ANOMALY",
        reason: "Second participant dispute on prize distribution",
      });

      await assert.rejects(
        () =>
          disputeService.resolveDispute(d1.id, {
            adminUserId: "admin_1",
            ruling: DisputeStatus.RESOLVED_PAYOUT,
            justification: "Attempting payout while second dispute is still open",
          }),
        (err: unknown) => {
          assert.ok(err instanceof FinancialConflictError);
          assert.match(err.message, /other dispute/i);
          return true;
        }
      );

      const openDisputes = await disputeService.listDisputes({
        leagueId: LEAGUE_ID,
        status: DisputeStatus.OPEN,
      });
      assert.equal(openDisputes.length, 2);
      assert.equal((await disputeService.getDisputeById(d2.id)).id, d2.id);
    });

    it("surfaces FinancialConflictError when on-chain escrow freeze call fails", async () => {
      const { disputeService } = createDisputeTestEnv({
        freezeLeagueEscrow: async () => ({
          success: false,
          error: "Soroban RPC timeout during freeze_league",
        }),
      });

      await assert.rejects(
        () =>
          disputeService.fileDispute({
            leagueId: LEAGUE_ID,
            reporterId: "user_1",
            reason: "Testing contract freeze failure handling",
          }),
        (err: unknown) => {
          assert.ok(err instanceof FinancialConflictError);
          assert.match(err.message, /freeze failed/i);
          return true;
        }
      );
    });

    it("transitions OPEN -> UNDER_REVIEW -> RESOLVED_REFUND and executes proportional/full participant refunds", async () => {
      const { state, disputeService } = createDisputeTestEnv();

      const { dispute: opened } = await disputeService.fileDispute({
        leagueId: LEAGUE_ID,
        reporterId: "user_3",
        category: "COLLUSION",
        reason: "Confirmed multi-account collusion between top squads",
      });

      await disputeService.markUnderReview(opened.id, {
        adminUserId: "admin_1",
        justification: "Investigating IP and transfer logs",
      });

      const outcome = await disputeService.resolveDispute(opened.id, {
        adminUserId: "admin_1",
        ruling: DisputeStatus.RESOLVED_REFUND,
        justification:
          "Collusion confirmed; voiding league results and issuing 50% proportional escrow refund to participants.",
        refundProportionBps: 5000, // 50% proportional refund (50 USDC per participant)
      });

      assert.equal(outcome.dispute.status, DisputeStatus.RESOLVED_REFUND);
      assert.equal(outcome.dispute.escrowFrozen, false);
      assert.ok(outcome.refundReport);
      assert.equal(outcome.refundReport?.refundedMemberIds.length, 3);
      assert.equal(state.unfreezeCalls.length, 1);
      assert.equal(state.leagues.get(LEAGUE_ID).status, LeagueStatus.CANCELLED);
      assert.equal(
        (outcome.dispute.resolutionMetadata as any)?.refundProportionBps,
        5000
      );
      assert.equal(
        (outcome.dispute.resolutionMetadata as any)?.refundedAmountPerMember,
        50
      );
    });
  });

  describe("Immutable Ruling Log & SHA-256 Hash Chain Verification", () => {
    it("maintains a valid SHA-256 hash chain across all dispute transitions and detects tampering", async () => {
      const { state, disputeService } = createDisputeTestEnv();

      const { dispute } = await disputeService.fileDispute({
        leagueId: LEAGUE_ID,
        reporterId: "user_1",
        category: "PAYOUT_ANOMALY",
        reason: "Disputing payout calculation before settlement runs",
      });

      await disputeService.markUnderReview(dispute.id, {
        adminUserId: "mod_1",
        justification: "Reviewing escrow pool balance and participant ranks",
      });

      await disputeService.resolveDispute(dispute.id, {
        adminUserId: "admin_1",
        ruling: DisputeStatus.RESOLVED_PAYOUT,
        justification: "Pool balance and winner shares verified; approving payout.",
      });

      const integrityBefore = await disputeService.verifyRulingLogIntegrity(
        dispute.id
      );
      assert.equal(integrityBefore.valid, true);
      assert.equal(integrityBefore.entryCount, 3);

      // Simulate tampering with an existing ruling log's justification
      const secondLog = state.rulingLogs.get("ruling_log_2");
      state.rulingLogs.set("ruling_log_2", {
        ...secondLog,
        justification: "Tampered justification after the fact",
      });

      const integrityAfter = await disputeService.verifyRulingLogIntegrity(
        dispute.id
      );
      assert.equal(integrityAfter.valid, false);
      assert.equal(integrityAfter.tamperedEntryId, "ruling_log_2");
    });
  });
});
