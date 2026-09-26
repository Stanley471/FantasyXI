import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { FinancialService, FinancialNotFoundError } from "../services/financial/financialService.js";
import { LeagueStatus, MembershipStatus, PaymentStatus, TransactionType, TransactionStatus } from "../types/index.js";

const wallet = Keypair.random().publicKey();

function createMockDb(member: any, transactions: any[] = []) {
  const state = { member: { ...member }, transactions: [...transactions] };
  return {
    state,
    leagueMember: {
      findUnique: async ({ where }: any) => {
        if (where.leagueId_userId) {
          if (
            state.member.leagueId !== where.leagueId_userId.leagueId ||
            state.member.userId !== where.leagueId_userId.userId
          ) {
            return null;
          }
        }
        return { ...state.member, league: state.member.league };
      },
      updateMany: async ({ where, data }: any) => {
        if (where.paymentStatus?.not && state.member.paymentStatus === where.paymentStatus.not) {
          return { count: 0 };
        }
        state.member = { ...state.member, ...data };
        return { count: 1 };
      },
    },
    transaction: {
      findFirst: async ({ where }: any) =>
        state.transactions.find(
          (tx) => tx.memberId === where.memberId && tx.type === where.type
        ) || null,
      create: async ({ data }: any) => {
        const record = { id: `tx_${state.transactions.length + 1}`, ...data };
        state.transactions.push(record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const idx = state.transactions.findIndex((tx) => tx.id === where.id);
        state.transactions[idx] = { ...state.transactions[idx], ...data };
        return state.transactions[idx];
      },
    },
  };
}

const LEAGUE_ID = "11111111-1111-1111-1111-111111111111";

function baseMember(overrides?: any) {
  return {
    id: "member1",
    leagueId: LEAGUE_ID,
    userId: "user1",
    stellarAddress: wallet,
    paymentStatus: PaymentStatus.PAYMENT_SUBMITTED,
    status: MembershipStatus.PENDING,
    hasPaid: false,
    league: { id: LEAGUE_ID, entryFee: 5, status: LeagueStatus.UPCOMING },
    ...overrides,
  };
}

function createMockStellar(depositStroops: bigint, shouldThrow = false) {
  return {
    getContractDeposit: async () => {
      if (shouldThrow) throw new Error("RPC timeout");
      return depositStroops;
    },
  } as any;
}

describe("FinancialService.reconcileDeposit", () => {
  it("is idempotent when already confirmed and active", async () => {
    const db = createMockDb(
      baseMember({ paymentStatus: PaymentStatus.PAYMENT_CONFIRMED, status: MembershipStatus.ACTIVE })
    );
    const service = new FinancialService(db, createMockStellar(0n));
    const result = await service.reconcileDeposit("user1", LEAGUE_ID);
    assert.equal(result.success, true);
  });

  it("fails clearly when the member never recorded a wallet address", async () => {
    const db = createMockDb(baseMember({ stellarAddress: null }));
    const service = new FinancialService(db, createMockStellar(0n));
    const result = await service.reconcileDeposit("user1", LEAGUE_ID);
    assert.equal(result.success, false);
    assert.match(result.error!, /No wallet address/);
  });

  it("fails when the on-chain deposit is below the entry fee", async () => {
    const db = createMockDb(baseMember());
    // 4 USDC deposited (entry fee is 5 USDC)
    const service = new FinancialService(db, createMockStellar(40_000_000n));
    const result = await service.reconcileDeposit("user1", LEAGUE_ID);
    assert.equal(result.success, false);
    assert.match(result.error!, /No matching on-chain deposit/);
  });

  it("surfaces a friendly error when the Soroban RPC call fails", async () => {
    const db = createMockDb(baseMember());
    const service = new FinancialService(db, createMockStellar(0n, true));
    const result = await service.reconcileDeposit("user1", LEAGUE_ID);
    assert.equal(result.success, false);
    assert.match(result.error!, /Could not reach the Soroban network/);
  });

  it("confirms membership and records a transaction when the escrow deposit covers the entry fee", async () => {
    const db = createMockDb(baseMember());
    const service = new FinancialService(db, createMockStellar(50_000_000n));
    const result = await service.reconcileDeposit("user1", LEAGUE_ID);

    assert.equal(result.success, true);
    assert.equal(db.state.member.paymentStatus, PaymentStatus.PAYMENT_CONFIRMED);
    assert.equal(db.state.member.status, MembershipStatus.ACTIVE);
    assert.equal(db.state.member.hasPaid, true);
    assert.equal(db.state.transactions.length, 1);
    assert.equal(db.state.transactions[0].status, TransactionStatus.CONFIRMED);
    assert.equal(db.state.transactions[0].type, TransactionType.ENTRY_FEE);
  });

  it("updates an existing pending transaction instead of creating a duplicate", async () => {
    const db = createMockDb(baseMember(), [
      {
        id: "tx1",
        memberId: "member1",
        type: TransactionType.ENTRY_FEE,
        status: TransactionStatus.SUBMITTED,
      },
    ]);
    const service = new FinancialService(db, createMockStellar(50_000_000n));
    const result = await service.reconcileDeposit("user1", LEAGUE_ID);

    assert.equal(result.success, true);
    assert.equal(db.state.transactions.length, 1);
    assert.equal(db.state.transactions[0].status, TransactionStatus.CONFIRMED);
  });

  it("does not double-confirm when a concurrent call already confirmed the member", async () => {
    const db = createMockDb(baseMember());
    // Simulate a race: updateMany reports no rows matched because another
    // request already flipped the member to PAYMENT_CONFIRMED.
    db.leagueMember.updateMany = async () => {
      db.state.member.paymentStatus = PaymentStatus.PAYMENT_CONFIRMED;
      return { count: 0 };
    };
    const service = new FinancialService(db, createMockStellar(50_000_000n));
    const result = await service.reconcileDeposit("user1", LEAGUE_ID);

    assert.equal(result.success, true);
    assert.equal(db.state.transactions.length, 0);
  });

  it("throws FinancialNotFoundError when the membership does not exist", async () => {
    const db = createMockDb(baseMember());
    const service = new FinancialService(db, createMockStellar(0n));
    await assert.rejects(
      () => service.reconcileDeposit("someone-else", LEAGUE_ID),
      FinancialNotFoundError
    );
  });
});
