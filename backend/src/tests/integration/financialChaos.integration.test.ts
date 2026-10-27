import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { FinancialService } from "../../services/financial/financialService.js";
import { ChaosLink } from "../helpers/chaosLink.js";

const url = process.env.CHAOS_DATABASE_URL;
describe("real PostgreSQL financial chaos", { skip: !url }, () => {
  it("rolls back terminated multi-table commits and recovers deposits/settlements exactly once", async () => {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const client = new PrismaClient({ adapter: new PrismaPg(pool) });
    const id = randomUUID();
    const leagueId = randomUUID();
    const hash = "b".repeat(64);
    let terminateCommit = false, latencyMs = 0;
    const db = new Proxy(client, {
      get(target, prop) {
        if (prop === "$transaction") return async (ops: any) => {
          if (typeof ops === "function") return client.$transaction(async tx => {
            const result = await ops(tx);
            if (latencyMs) await tx.$queryRawUnsafe(`SELECT pg_sleep(${latencyMs / 1000})::text`);
            if (terminateCommit) await tx.$queryRawUnsafe("SELECT pg_terminate_backend(pg_backend_pid())");
            return result;
          });
          const faultOps = [...ops];
          if (latencyMs) faultOps.push(client.$queryRawUnsafe(`SELECT pg_sleep(${latencyMs / 1000})::text`));
          if (terminateCommit) faultOps.push(client.$queryRawUnsafe("SELECT pg_terminate_backend(pg_backend_pid())"));
          return client.$transaction(faultOps);
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const rpc = new ChaosLink();
    let settlements = 0, sends = 0;
    const stellar: any = {
      isValidStellarAddress: () => true,
      verifyPaymentTransaction: () => rpc.call(async () => ({ success: true, txHash: hash, ledgerSeq: 123 })),
      settleLeague: async (_id: unknown, _winners: unknown, _fee: unknown, checkpoint: (hash: string, envelope: string) => Promise<void>) => {
        sends++; await checkpoint(hash, "test-envelope");
        return rpc.call(async () => { settlements++; return { success: true, txHash: hash, ledgerSeq: 124 }; });
      },
      getSettlementStatus: () => rpc.call(async () => ({ status: settlements ? "SUCCESS" : "NOT_FOUND", ledger: 124 })),
    };
    const service = () => {
      const result = new FinancialService(db, stellar, { sendDepositConfirmation: async () => {} } as any, { record() {} } as any);
      result.prepareSettlement = async () => ({ canSettle: true, netPrizePool: 9.5, platformFee: 0.5,
        winners: [{ userId: id, stellarAddress: "wallet", prizeAmount: 9.5, rank: 1 }] } as any);
      return result;
    };
    let gwId: number | undefined;
    try {
      await client.user.create({ data: { id, email: `${id}@chaos.test`, username: id, role: "ADMIN" } });
      const squad = await client.squad.create({ data: { name: "Chaos", userId: id } });
      const gw = await client.gameweek.create({ data: { fplId: Math.floor(Math.random() * 1e9), name: "Chaos", deadline: new Date(), season: "chaos", isFinished: true } });
      gwId = gw.id;
      await client.league.create({ data: { id: leagueId, name: "Chaos", creatorId: id, inviteCode: id,
        entryFee: 10, status: "ACTIVE", startGameweekId: gw.id, endGameweekId: gw.id } });
      await client.leagueMember.create({ data: { leagueId, userId: id, squadId: squad.id, paymentStatus: "PAYMENT_SUBMITTED", stellarAddress: "wallet" } });
      await client.transaction.create({ data: { userId: id, leagueId, stellarTxHash: hash, amount: 10, type: "ENTRY_FEE", status: "SUBMITTED" } });
      rpc.faults = ["drop"];
      await assert.rejects(service().verifyAndConfirmPayment(id, leagueId, hash), /timeout/);
      terminateCommit = true;
      await assert.rejects(service().verifyAndConfirmPayment(id, leagueId, hash));
      const member = await client.leagueMember.findUniqueOrThrow({ where: { leagueId_userId: { leagueId, userId: id } } });
      assert.equal(member.paymentStatus, "PAYMENT_SUBMITTED");
      assert.equal((await client.transaction.findFirstOrThrow({ where: { leagueId } })).status, "SUBMITTED");
      terminateCommit = false; latencyMs = 25;
      await service().verifyAndConfirmPayment(id, leagueId, hash);
      assert.equal((await client.leagueMember.findUniqueOrThrow({ where: { id: member.id } })).hasPaid, true);
      terminateCommit = true;
      await assert.rejects(service().executeSettlement(leagueId, id));
      assert.equal(settlements, 1);
      assert.equal(await client.transaction.count({ where: { leagueId } }), 1);
      assert.equal((await client.league.findUniqueOrThrow({ where: { id: leagueId } })).status, "ACTIVE");
      terminateCommit = false;
      // Two independent services imitate separate workers after a process restart.
      await Promise.all([service().executeSettlement(leagueId, id), service().executeSettlement(leagueId, id)]);
      assert.equal(sends, 1); assert.equal(settlements, 1);
      assert.equal(await client.transaction.count({ where: { leagueId } }), 3);
      const amounts = await client.transaction.aggregate({ where: { leagueId, type: { in: ["PRIZE_PAYOUT", "PLATFORM_FEE"] } }, _sum: { amount: true } });
      assert.equal(Number(amounts._sum.amount), 10);
      assert.equal((await client.league.findUniqueOrThrow({ where: { id: leagueId } })).status, "COMPLETED");
    } finally {
      await client.coordinatedTransaction.deleteMany({ where: { leagueId } });
      await client.transaction.deleteMany({ where: { leagueId } });
      await client.leagueMember.deleteMany({ where: { leagueId } });
      await client.league.deleteMany({ where: { id: leagueId } });
      await client.squad.deleteMany({ where: { userId: id } });
      await client.user.deleteMany({ where: { id } });
      if (gwId) await client.gameweek.deleteMany({ where: { id: gwId } });
      await client.$disconnect(); await pool.end();
    }
  });
});
