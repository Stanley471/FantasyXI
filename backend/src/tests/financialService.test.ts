import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  FinancialService,
  FinancialValidationError,
  FinancialNotFoundError,
  FinancialForbiddenError,
  FinancialConflictError,
} from "../services/financial/financialService.js";
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  TransactionType,
  TransactionStatus,
} from "../types/index.js";

const testWallet1 = Keypair.random().publicKey();
const testWallet2 = Keypair.random().publicKey();
const testWallet3 = Keypair.random().publicKey();

const VALID_TX_HASH_1 =
  "1111111111111111111111111111111111111111111111111111111111111111";
const VALID_TX_HASH_2 =
  "2222222222222222222222222222222222222222222222222222222222222222";

function createMockDb(overrides?: any) {
  const state = {
    leagues: new Map<string, any>(),
    squads: new Map<string, any>(),
    members: new Map<string, any>(),
    transactions: new Map<string, any>(),
    users: new Map<string, any>(),
    ...overrides,
  };

  return {
    state,
    league: {
      findUnique: async ({ where }: any) => {
        const league = state.leagues.get(where.id);
        if (!league) return null;
        const membersFromState = Array.from(state.members.values()).filter(
          (m: any) => m.leagueId === where.id
        );
        const members =
          league.members && league.members.length > 0
            ? league.members
            : membersFromState;
        const txsFromState = Array.from(state.transactions.values()).filter(
          (tx: any) => tx.leagueId === where.id
        );
        const transactions =
          league.transactions && league.transactions.length > 0
            ? league.transactions
            : txsFromState;
        return {
          ...league,
          members,
          transactions,
        };
      },
      update: async ({ where, data }: any) => {
        const current = state.leagues.get(where.id);
        const updated = { ...current, ...data };
        state.leagues.set(where.id, updated);
        return updated;
      },
    },
    user: {
      findUnique: async ({ where }: any) => state.users?.get(where.id) || null,
    },
    squad: {
      findUnique: async ({ where }: any) => state.squads.get(where.id) || null,
    },
    leagueMember: {
      findUnique: async ({ where }: any) => {
        if (where.id) {
          return (
            state.members.get(where.id) ||
            Array.from(state.members.values()).find((m: any) => m.id === where.id) ||
            null
          );
        }
        if (where.leagueId_userId) {
          const key = `${where.leagueId_userId.leagueId}:${where.leagueId_userId.userId}`;
          const m =
            state.members.get(key) ||
            Array.from(state.members.values()).find(
              (x: any) =>
                x.leagueId === where.leagueId_userId.leagueId &&
                x.userId === where.leagueId_userId.userId
            );
          if (!m) return null;
          const league = state.leagues.get(m.leagueId);
          return { ...m, league };
        }
        return null;
      },
      create: async ({ data }: any) => {
        const id = `member_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const record = { id, ...data };
        state.members.set(id, record);
        state.members.set(`${data.leagueId}:${data.userId}`, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const current =
          state.members.get(where.id) ||
          Array.from(state.members.values()).find((m: any) => m.id === where.id);
        const updated = { ...current, ...data };
        state.members.set(where.id, updated);
        if (updated.leagueId && updated.userId) {
          state.members.set(`${updated.leagueId}:${updated.userId}`, updated);
        }
        return updated;
      },
    },
    transaction: {
      findFirst: async ({ where }: any) =>
        Array.from(state.transactions.values()).find(
          (tx: any) =>
            tx.stellarTxHash === where.stellarTxHash &&
            (!where.type || !tx.type || tx.type === where.type)
        ) || null,
      findUnique: async ({ where }: any) => {
        if (where.stellarTxHash) {
          return (
            Array.from(state.transactions.values()).find(
              (tx: any) => tx.stellarTxHash === where.stellarTxHash
            ) || null
          );
        }
        return state.transactions.get(where.id) || null;
      },
      create: async ({ data }: any) => {
        const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
}

function createMockStellar(overrides?: any) {
  return {
    isValidStellarAddress: (addr: string) => addr?.startsWith("G") && addr.length === 56,
    isValidTransactionHash: (hash: string) => /^[0-9a-fA-F]{64}$/.test(hash),
    verifyPaymentTransaction: async (params: any) => {
      if (overrides?.verificationResult) return overrides.verificationResult;
      return {
        success: true,
        txHash: params.txHash,
        ledgerSeq: 888888,
        amount: params.expectedAmount,
        assetCode: "USDC",
        senderAddress: params.expectedSender || testWallet1,
        destinationAddress: params.expectedDestination,
        confirmedAt: new Date(),
      };
    },
    getAccountUsdcBalance: async () => 100.0,
    ...overrides,
  } as any;
}

describe("FinancialService State Machine & Accounting", () => {
  describe("createPaymentRequirement", () => {
    it("should generate deterministic payment requirement for an UPCOMING paid league", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        name: "Test League",
        entryFee: 10,
        status: LeagueStatus.UPCOMING,
        creatorId: "user_creator",
      });
      mockDb.state.squads.set("squad_1", {
        id: "squad_1",
        userId: "user_1",
        name: "User 1 Squad",
      });

      const service = new FinancialService(mockDb, createMockStellar());
      const requirement = await service.createPaymentRequirement(
        "user_1",
        "league_1",
        "squad_1"
      );

      assert.equal(requirement.leagueId, "league_1");
      assert.equal(requirement.entryFee, 10);
      assert.equal(requirement.assetCode, "USDC");
      assert.equal(requirement.paymentStatus, PaymentStatus.PAYMENT_INITIATED);
      assert.match(requirement.memo, /^FXI:LEAGUE1:USER1/);
    });

    it("should automatically activate member with confirmed payment for free league (entryFee === 0)", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("free_league", {
        id: "free_league",
        name: "Free League",
        entryFee: 0,
        status: LeagueStatus.UPCOMING,
        creatorId: "user_creator",
      });
      mockDb.state.squads.set("squad_free", {
        id: "squad_free",
        userId: "user_1",
        name: "Free Squad",
      });

      const service = new FinancialService(mockDb, createMockStellar());
      const requirement = await service.createPaymentRequirement(
        "user_1",
        "free_league",
        "squad_free"
      );

      assert.equal(requirement.entryFee, 0);
      assert.equal(requirement.paymentStatus, PaymentStatus.PAYMENT_CONFIRMED);

      const member = mockDb.state.members.get("free_league:user_1");
      assert.equal(member.status, MembershipStatus.ACTIVE);
      assert.equal(member.paymentStatus, PaymentStatus.PAYMENT_CONFIRMED);
    });

    it("should reject payment initiation for non-UPCOMING league", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("active_league", {
        id: "active_league",
        name: "Active League",
        entryFee: 10,
        status: LeagueStatus.ACTIVE,
      });
      mockDb.state.squads.set("squad_1", { id: "squad_1", userId: "user_1" });

      const service = new FinancialService(mockDb, createMockStellar());
      await assert.rejects(
        async () => {
          await service.createPaymentRequirement(
            "user_1",
            "active_league",
            "squad_1"
          );
        },
        FinancialValidationError
      );
    });

    it("should reject squad that does not belong to user", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        entryFee: 10,
        status: LeagueStatus.UPCOMING,
      });
      mockDb.state.squads.set("squad_2", { id: "squad_2", userId: "user_other" });

      const service = new FinancialService(mockDb, createMockStellar());
      await assert.rejects(
        async () => {
          await service.createPaymentRequirement("user_1", "league_1", "squad_2");
        },
        FinancialValidationError
      );
    });
  });

  describe("submitPayment & State Transitions", () => {
    it("should record PAYMENT_SUBMITTED and register transaction", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        entryFee: 10,
        status: LeagueStatus.UPCOMING,
      });
      mockDb.state.members.set("league_1:user_1", {
        id: "member_1",
        leagueId: "league_1",
        userId: "user_1",
        status: MembershipStatus.PENDING,
        paymentStatus: PaymentStatus.PAYMENT_INITIATED,
      });

      const service = new FinancialService(mockDb, createMockStellar());
      const result = await service.submitPayment("user_1", "league_1", {
        stellarTxHash: VALID_TX_HASH_1,
        stellarAddress: testWallet1,
      });

      assert.equal(result.member.paymentStatus, PaymentStatus.PAYMENT_SUBMITTED);
      assert.equal(result.member.stellarAddress, testWallet1);
      assert.equal(result.transaction.status, TransactionStatus.SUBMITTED);
      assert.equal(result.transaction.stellarTxHash, VALID_TX_HASH_1);
    });

    it("should reject double submission of same txHash by different user", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        entryFee: 10,
        status: LeagueStatus.UPCOMING,
      });
      mockDb.state.members.set("league_1:user_1", {
        id: "member_1",
        leagueId: "league_1",
        userId: "user_1",
        paymentStatus: PaymentStatus.PAYMENT_SUBMITTED,
      });
      mockDb.state.members.set("league_1:user_2", {
        id: "member_2",
        leagueId: "league_1",
        userId: "user_2",
        paymentStatus: PaymentStatus.PAYMENT_INITIATED,
      });
      mockDb.state.transactions.set("tx_1", {
        id: "tx_1",
        stellarTxHash: VALID_TX_HASH_1,
        memberId: "member_1",
      });

      const service = new FinancialService(mockDb, createMockStellar());
      await assert.rejects(
        async () => {
          await service.submitPayment("user_2", "league_1", {
            stellarTxHash: VALID_TX_HASH_1,
            stellarAddress: testWallet2,
          });
        },
        FinancialConflictError
      );
    });

    it("should reject invalid transaction hash or wallet address", async () => {
      const mockDb = createMockDb();
      const service = new FinancialService(mockDb, createMockStellar());

      await assert.rejects(
        async () => {
          await service.submitPayment("user_1", "league_1", {
            stellarTxHash: "invalid_hash",
            stellarAddress: testWallet1,
          });
        },
        FinancialValidationError
      );

      await assert.rejects(
        async () => {
          await service.submitPayment("user_1", "league_1", {
            stellarTxHash: VALID_TX_HASH_1,
            stellarAddress: "invalid_wallet",
          });
        },
        FinancialValidationError
      );
    });
  });

  describe("verifyAndConfirmPayment", () => {
    it("should confirm payment and promote member to ACTIVE upon on-chain verification", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        entryFee: 10,
        status: LeagueStatus.UPCOMING,
      });
      mockDb.state.members.set("league_1:user_1", {
        id: "member_1",
        leagueId: "league_1",
        userId: "user_1",
        status: MembershipStatus.PENDING,
        paymentStatus: PaymentStatus.PAYMENT_SUBMITTED,
        stellarAddress: testWallet1,
      });
      mockDb.state.transactions.set("tx_1", {
        id: "tx_1",
        stellarTxHash: VALID_TX_HASH_1,
        memberId: "member_1",
        status: TransactionStatus.SUBMITTED,
      });

      const service = new FinancialService(mockDb, createMockStellar());
      const result = await service.verifyAndConfirmPayment(
        "user_1",
        "league_1",
        VALID_TX_HASH_1
      );

      assert.equal(result.success, true);

      const member = mockDb.state.members.get("member_1");
      assert.equal(member.status, MembershipStatus.ACTIVE);
      assert.equal(member.paymentStatus, PaymentStatus.PAYMENT_CONFIRMED);

      const tx = mockDb.state.transactions.get("tx_1");
      assert.equal(tx.status, TransactionStatus.CONFIRMED);
      assert.equal(tx.ledgerSeq, 888888);
    });

    it("should record PAYMENT_FAILED when Stellar verification fails", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        entryFee: 10,
        status: LeagueStatus.UPCOMING,
      });
      mockDb.state.members.set("league_1:user_1", {
        id: "member_1",
        leagueId: "league_1",
        userId: "user_1",
        status: MembershipStatus.PENDING,
        paymentStatus: PaymentStatus.PAYMENT_SUBMITTED,
        stellarAddress: testWallet1,
      });
      mockDb.state.transactions.set("tx_1", {
        id: "tx_1",
        stellarTxHash: VALID_TX_HASH_1,
        memberId: "member_1",
        status: TransactionStatus.SUBMITTED,
      });

      const mockStellar = createMockStellar({
        verificationResult: {
          success: false,
          txHash: VALID_TX_HASH_1,
          error: "Amount mismatch",
        },
      });

      const service = new FinancialService(mockDb, mockStellar);
      const result = await service.verifyAndConfirmPayment(
        "user_1",
        "league_1",
        VALID_TX_HASH_1
      );

      assert.equal(result.success, false);
      const member = mockDb.state.members.get("member_1");
      assert.equal(member.paymentStatus, PaymentStatus.PAYMENT_FAILED);
      assert.equal(member.status, MembershipStatus.PENDING); // Not promoted
    });

    it("should be idempotent when already confirmed", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        entryFee: 10,
      });
      mockDb.state.members.set("league_1:user_1", {
        id: "member_1",
        leagueId: "league_1",
        userId: "user_1",
        status: MembershipStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
      });

      let verifyCalled = false;
      const mockStellar = createMockStellar({
        verifyPaymentTransaction: async () => {
          verifyCalled = true;
          return { success: true };
        },
      });

      const service = new FinancialService(mockDb, mockStellar);
      const result = await service.verifyAndConfirmPayment(
        "user_1",
        "league_1",
        VALID_TX_HASH_1
      );

      assert.equal(result.success, true);
      assert.equal(verifyCalled, false); // No redundant network call!
    });
  });

  describe("prepareSettlement & Prize Allocation", () => {
    it("should calculate exact 5% fee and 60/30/10 prize plan for 10-player league x 5 USDC", async () => {
      const mockDb = createMockDb();
      const members: any[] = [];

      for (let i = 1; i <= 10; i++) {
        members.push({
          id: `m_${i}`,
          userId: `user_${i}`,
          leagueId: "league_10p",
          status: MembershipStatus.ACTIVE,
          paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
          stellarAddress: testWallet1,
          joinedAt: new Date(2026, 0, i),
          user: { username: `Manager ${i}` },
          squad: {
            name: `Squad ${i}`,
            totalPoints: 100 - i * 5, // Manager 1 = 95, Manager 2 = 90, Manager 3 = 85
          },
        });
      }

      mockDb.state.leagues.set("league_10p", {
        id: "league_10p",
        name: "10-Player Cash Cup",
        entryFee: 5,
        status: LeagueStatus.ACTIVE,
        creatorId: "creator_user",
        members,
      });

      const service = new FinancialService(mockDb, createMockStellar());
      const plan = await service.prepareSettlement("league_10p", "creator_user");

      assert.equal(plan.canSettle, true);
      assert.equal(plan.totalParticipants, 10);
      assert.equal(plan.grossPool, 50.0);
      assert.equal(plan.platformFee, 2.5);
      assert.equal(plan.netPrizePool, 47.5);

      assert.equal(plan.winners.length, 3);
      assert.equal(plan.winners[0].rank, 1);
      assert.equal(plan.winners[0].username, "Manager 1");
      assert.equal(plan.winners[0].prizeAmount, 28.5); // 60% of 47.50

      assert.equal(plan.winners[1].rank, 2);
      assert.equal(plan.winners[1].username, "Manager 2");
      assert.equal(plan.winners[1].prizeAmount, 14.25); // 30% of 47.50

      assert.equal(plan.winners[2].rank, 3);
      assert.equal(plan.winners[2].username, "Manager 3");
      assert.equal(plan.winners[2].prizeAmount, 4.75); // 10% of 47.50

      // Zero lost cents verification:
      const totalPrizes = plan.winners.reduce((sum, w) => sum + w.prizeAmount, 0);
      assert.equal(
        parseFloat((totalPrizes + plan.platformFee).toFixed(2)),
        plan.grossPool
      );
    });

    it("should reject settlement request from non-creator", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_1", {
        id: "league_1",
        creatorId: "creator_only",
        members: [],
      });

      const service = new FinancialService(mockDb, createMockStellar());
      await assert.rejects(
        async () => {
          await service.prepareSettlement("league_1", "intruder_user");
        },
        FinancialForbiddenError
      );
    });

    it("should split a first-place tie and dispatch confirmed transactions atomically", async () => {
      const mockDb = createMockDb();
      const members = [1, 2].map((i) => ({
        id: `tie_member_${i}`,
        userId: `tie_user_${i}`,
        leagueId: "6e5f9a4c-8b21-70d3-1234-567890abcdef",
        status: MembershipStatus.ACTIVE,
        paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
        stellarAddress: i === 1 ? testWallet1 : testWallet2,
        joinedAt: new Date(2026, 0, i),
        user: { username: `Tie Manager ${i}` },
        squad: { name: `Tie Squad ${i}`, totalPoints: 100 },
      }));
      mockDb.state.leagues.set("6e5f9a4c-8b21-70d3-1234-567890abcdef", {
        id: "6e5f9a4c-8b21-70d3-1234-567890abcdef",
        name: "Tie League",
        entryFee: 10,
        status: LeagueStatus.ACTIVE,
        creatorId: "creator_user",
        endGameweek: { isFinished: true },
        members,
      });
      mockDb.state.users.set("admin_user", { id: "admin_user", role: "ADMIN" });

      let dispatch: any;
      const service = new FinancialService(
        mockDb,
        createMockStellar({
          settleLeague: async (...args: any[]) => {
            dispatch = args;
            return { success: true, txHash: VALID_TX_HASH_2, ledgerSeq: 991122 };
          },
        })
      );

      const result = await service.executeSettlement(
        "6e5f9a4c-8b21-70d3-1234-567890abcdef",
        "admin_user"
      );

      assert.equal(dispatch[0], 0x6e5f9a4c8b2170d3n);
      assert.deepEqual(dispatch[1].map((winner: any) => winner.amount), ["95000000", "95000000"]);
      assert.equal(dispatch[2], 10000000n);
      assert.equal(result.stellarTxHash, VALID_TX_HASH_2);
      assert.equal(result.ledgerSeq, 991122);
      assert.equal(
        mockDb.state.leagues.get("6e5f9a4c-8b21-70d3-1234-567890abcdef").status,
        LeagueStatus.COMPLETED
      );
      assert.equal(mockDb.state.transactions.size, 3);
    });

    it("should reject settlement until the end gameweek is finished", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_unfinished", {
        id: "league_unfinished",
        creatorId: "creator_user",
        status: LeagueStatus.ACTIVE,
        endGameweek: { isFinished: false },
      });
      mockDb.state.users.set("admin_user", { id: "admin_user", role: "ADMIN" });

      const service = new FinancialService(mockDb, createMockStellar());
      await assert.rejects(
        async () => service.executeSettlement("league_unfinished", "admin_user"),
        FinancialValidationError
      );
    });
  });

  describe("reconcileLeague", () => {
    it("should return balanced report when confirmed deposits equal expected gross", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_rec", {
        id: "league_rec",
        name: "Reconciliation Test",
        entryFee: 10,
        status: LeagueStatus.ACTIVE,
        members: [
          { id: "m1", status: MembershipStatus.ACTIVE },
          { id: "m2", status: MembershipStatus.ACTIVE },
        ],
        transactions: [
          {
            id: "tx1",
            type: TransactionType.ENTRY_FEE,
            status: TransactionStatus.CONFIRMED,
            amount: 10,
          },
          {
            id: "tx2",
            type: TransactionType.ENTRY_FEE,
            status: TransactionStatus.CONFIRMED,
            amount: 10,
          },
        ],
      });

      const service = new FinancialService(mockDb, createMockStellar());
      const report = await service.reconcileLeague("league_rec");

      assert.equal(report.activeMemberCount, 2);
      assert.equal(report.expectedGross, 20);
      assert.equal(report.confirmedDepositsTotal, 20);
      assert.equal(report.discrepancy, 0);
      assert.equal(report.isBalanced, true);
    });

    it("should identify discrepancy when a member is active but payment is unconfirmed", async () => {
      const mockDb = createMockDb();
      mockDb.state.leagues.set("league_discrepancy", {
        id: "league_discrepancy",
        name: "Discrepancy Test",
        entryFee: 10,
        status: LeagueStatus.ACTIVE,
        members: [
          { id: "m1", status: MembershipStatus.ACTIVE },
          { id: "m2", status: MembershipStatus.ACTIVE },
        ],
        transactions: [
          {
            id: "tx1",
            type: TransactionType.ENTRY_FEE,
            status: TransactionStatus.CONFIRMED,
            amount: 10,
          },
          // Second transaction is still SUBMITTED, not CONFIRMED
          {
            id: "tx2",
            type: TransactionType.ENTRY_FEE,
            status: TransactionStatus.SUBMITTED,
            amount: 10,
          },
        ],
      });

      const service = new FinancialService(mockDb, createMockStellar());
      const report = await service.reconcileLeague("league_discrepancy");

      assert.equal(report.expectedGross, 20);
      assert.equal(report.confirmedDepositsTotal, 10);
      assert.equal(report.discrepancy, 10);
      assert.equal(report.isBalanced, false);
    });
  });
});
