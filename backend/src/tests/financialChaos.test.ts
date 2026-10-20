import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FinancialService } from "../services/financial/financialService.js";
import { ChaosLink, type Fault } from "./helpers/chaosLink.js";

const leagueId = "6e5f9a4c-8b21-70d3-1234-567890abcdef";
const hash = "a".repeat(64);
const plan = { canSettle: true, winners: [{ userId: "winner", stellarAddress: "wallet", prizeAmount: 9.5, rank: 1 }], platformFee: 0.5, netPrizePool: 9.5 };
/** Lazy query thenables model Prisma's deferred array transactions. State is committed only on success. */
function fixture() {
  let state: any = {
    league: { id: leagueId, creatorId: "creator", status: "ACTIVE", endGameweek: { isFinished: true }, entryFee: 10 },
    member: { id: "member", leagueId, userId: "winner", stellarAddress: "wallet", paymentStatus: "PAYMENT_SUBMITTED", status: "PENDING" },
    transactions: [{ id: "deposit", stellarTxHash: hash, amount: 10, type: "ENTRY_FEE", status: "SUBMITTED" }], journal: null,
  };
  const dbLink = new ChaosLink();
  let serial = Promise.resolve();
  const lazy = (fn: () => unknown) => ({ then: (ok: any, fail: any) => Promise.resolve().then(fn).then(ok, fail) });
  const db: any = {
    league: {
      findUnique: async () => ({ ...state.league }),
      updateMany: ({ data }: any) => lazy(() => {
        if (state.league.status === "COMPLETED") return { count: 0 };
        Object.assign(state.league, data); return { count: 1 };
      }),
    },
    user: { findUnique: async () => ({ id: "admin", role: "ADMIN" }) },
    leagueMember: {
      findUnique: async () => ({ ...state.member, league: state.league }),
      update: ({ data }: any) => lazy(() => Object.assign(state.member, data)),
    },
    transaction: {
      create: ({ data }: any) => lazy(() => { state.transactions.push({ ...data }); return data; }),
      updateMany: ({ data }: any) => lazy(() => { Object.assign(state.transactions[0], data); return { count: 1 }; }),
    },
    coordinatedTransaction: {
      findUnique: async () => state.journal,
      findMany: async () => state.journal ? [state.journal] : [],
      upsert: async ({ create }: any) => { state.journal ??= { ...create, id: "journal" }; return state.journal; },
      updateMany: ({ data }: any) => lazy(() => { Object.assign(state.journal, data); return { count: 1 }; }),
    },
    $transaction: (ops: any) => {
      const task = serial.then(async () => {
        const before = structuredClone(state);
        try {
          const result = typeof ops === "function" ? await ops(db) : await Promise.all(ops);
          await dbLink.call(async () => undefined); // Inject faults at the multi-table commit boundary.
          return result;
        } catch (error) { state = before; throw error; }
      });
      serial = task.catch(() => undefined);
      return task;
    },
  };
  let chainSettlements = 0, rpcCalls = 0;
  let chainCommitted = false;
  const rpcLink = new ChaosLink();
  const stellar: any = {
    isValidStellarAddress: () => true,
    verifyPaymentTransaction: () => rpcLink.call(async () => ({ success: true, txHash: hash, ledgerSeq: 123 })),
    settleLeague: async (_id: bigint, _winners: unknown, _fee: bigint, beforeSubmit: (hash: string) => Promise<void>) => {
      rpcCalls++;
      await beforeSubmit(hash);
      return rpcLink.call(async () => {
        if (!chainCommitted) { chainSettlements++; chainCommitted = true; }
        return { success: true, txHash: hash, ledgerSeq: 123 };
      });
    },
    getSettlementStatus: () => rpcLink.call(async () => ({ status: chainCommitted ? "SUCCESS" : "NOT_FOUND", ledger: 123 })),
  };
  const service = () => {
    const instance = new FinancialService(db, stellar, {} as any, { record() {} } as any);
    instance.prepareSettlement = async () => plan as any;
    return instance;
  };
  return { db, dbLink, rpcLink, stellar, service, state: () => state,
    chainSettlements: () => chainSettlements, rpcCalls: () => rpcCalls };
}

describe("financial chaos (#320): deterministic isolated network partitions", () => {
  it("preserves every financial state under 100% deposit verification RPC drops", async () => {
    const f = fixture(); f.rpcLink.faults = Array(20).fill("drop");
    const before = structuredClone(f.state());
    for (let i = 0; i < 20; i++) await assert.rejects(f.service().verifyAndConfirmPayment("winner", leagueId, hash), /timeout/);
    assert.deepEqual(f.state(), before);
    await f.service().verifyAndConfirmPayment("winner", leagueId, hash);
    assert.equal(f.state().member.hasPaid, true);
    assert.equal(f.state().transactions.length, 1);
  });
  for (const fault of ["disconnect", "drop"] as Fault[]) {
    it(`rolls back multi-table deposit confirmation on ${fault} and recovers after restart`, async () => {
      const f = fixture(); f.dbLink.faults = [fault, "latency"];
      await assert.rejects(f.service().verifyAndConfirmPayment("winner", leagueId, hash));
      assert.equal(f.state().member.paymentStatus, "PAYMENT_SUBMITTED");
      assert.equal(f.state().transactions[0].status, "SUBMITTED");
      await f.service().verifyAndConfirmPayment("winner", leagueId, hash);
      await f.service().verifyAndConfirmPayment("winner", leagueId, hash);
      assert.equal(f.state().member.paymentStatus, "PAYMENT_CONFIRMED");
      assert.equal(f.state().transactions[0].status, "CONFIRMED");
      assert.equal(f.state().transactions.length, 1);
    });
  }
  it("does not mark a submitted deposit failed during a transient verifier outage", async () => {
    const f = fixture(); f.stellar.verifyPaymentTransaction = async () => ({ success: false, retryable: true, txHash: hash, error: "timeout" });
    await f.service().verifyAndConfirmPayment("winner", leagueId, hash);
    assert.equal(f.state().member.paymentStatus, "PAYMENT_SUBMITTED");
    assert.equal(f.state().transactions[0].status, "SUBMITTED");
  });
  it("recovers a lost settlement response by the same hash without paying twice", async () => {
    const f = fixture(); f.rpcLink.faults = ["lose-response", "drop", "pass"];
    await assert.rejects(f.service().executeSettlement(leagueId, "admin"), /response loss/);
    assert.equal(f.chainSettlements(), 1);
    assert.equal(f.state().transactions.length, 1);
    await assert.rejects(f.service().executeSettlement(leagueId, "admin"), /timeout/);
    await f.service().executeSettlement(leagueId, "admin");
    assert.equal(f.chainSettlements(), 1); assert.equal(f.rpcCalls(), 1);
    assert.equal(f.state().transactions.length, 3);
    assert.equal(f.state().league.status, "COMPLETED");
    assert.equal(f.state().transactions.filter((tx: any) => tx.type !== "ENTRY_FEE").reduce((sum: number, tx: any) => sum + tx.amount, 0), 10);
  });
  it("rolls back a settlement DB disconnect then lets concurrent recovery workers create one ledger", async () => {
    const f = fixture(); f.dbLink.faults = ["disconnect", "latency", "pass"];
    await assert.rejects(f.service().executeSettlement(leagueId, "admin"), /reset/);
    assert.equal(f.chainSettlements(), 1);
    assert.equal(f.state().league.status, "ACTIVE");
    assert.equal(f.state().transactions.length, 1);
    await Promise.all([f.service().executeSettlement(leagueId, "admin"), f.service().executeSettlement(leagueId, "admin")]);
    assert.equal(f.state().transactions.length, 3);
    assert.equal(f.chainSettlements(), 1);
  });
  it("keeps a pre-submission partition journaled and blocks unsafe new settlement hashes", async () => {
    const f = fixture(); f.rpcLink.faults = Array(10).fill("drop");
    for (let i = 0; i < 10; i++) await assert.rejects(f.service().executeSettlement(leagueId, "admin"));
    assert.equal(f.chainSettlements(), 0); assert.equal(f.rpcCalls(), 1);
    assert.equal(f.state().league.status, "ACTIVE"); assert.equal(f.state().transactions.length, 1);
  });
});
