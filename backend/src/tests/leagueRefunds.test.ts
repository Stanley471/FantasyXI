import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  FinancialService,
  FinancialValidationError,
  REFUND_BATCH_SIZE,
} from "../services/financial/financialService.js";
import { LeagueService } from "../services/league/leagueService.js";
import {
  LeagueStatus,
  PaymentStatus,
  TransactionStatus,
  TransactionType,
} from "../types/index.js";
import { createInMemoryFailedPayouts } from "./helpers/inMemoryFailedPayouts.js";

const LEAGUE_ID = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";

function createMockDb(memberCount: number, status: LeagueStatus = LeagueStatus.CANCELLED) {
  const members = Array.from({ length: memberCount }, (_, i) => ({
    id: `m${i}`,
    userId: `u${i}`,
    paymentStatus: PaymentStatus.REFUND_PENDING,
    stellarAddress: Keypair.random().publicKey(),
  }));
  const transactions: any[] = [];
  const db: any = {
    members,
    transactions,
    league: {
      findUnique: async () => ({ id: LEAGUE_ID, status, entryFee: 5, members }),
    },
    leagueMember: {
      update: async ({ where, data }: any) =>
        Object.assign(members.find((m) => m.id === where.id)!, data),
    },
    transaction: {
      create: async ({ data }: any) => {
        transactions.push(data);
        return data;
      },
    },
    failedPayout: createInMemoryFailedPayouts(),
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  return db;
}

describe("Mass-Refund Reconciliation Service", () => {
  it("maps a league UUID to a deterministic u64 contract league id", () => {
    const id = FinancialService.toContractLeagueId(LEAGUE_ID);
    assert.equal(id, 0x3f2a9c1e7b4d4e8an);
    assert.ok(id < 2n ** 64n);
    assert.throws(() => FinancialService.toContractLeagueId("league_1"), FinancialValidationError);
  });

  it("partitions participants into batches of at most 10", () => {
    const batches = FinancialService.chunk(Array.from({ length: 23 }, (_, i) => i), REFUND_BATCH_SIZE);
    assert.deepEqual(batches.map((b) => b.length), [10, 10, 3]);
  });

  it("refunds in batches and records REFUND transactions with each batch's hash", async () => {
    const db = createMockDb(23);
    const calls: Array<{ leagueId: bigint; participants: string[] }> = [];
    const stellar: any = {
      refundParticipants: async (leagueId: bigint, participants: string[]) => {
        calls.push({ leagueId, participants });
        return { success: true, txHash: String(calls.length).repeat(64) };
      },
    };

    const report = await new FinancialService(db, stellar).processLeagueRefunds(LEAGUE_ID);

    assert.deepEqual(calls.map((c) => c.participants.length), [10, 10, 3]);
    assert.ok(calls.every((c) => c.leagueId === FinancialService.toContractLeagueId(LEAGUE_ID)));
    assert.equal(report.refundedMemberIds.length, 23);
    assert.ok(db.members.every((m: any) => m.paymentStatus === PaymentStatus.REFUNDED));

    assert.equal(db.transactions.length, 23);
    const first = db.transactions[0];
    assert.equal(first.type, TransactionType.REFUND);
    assert.equal(first.status, TransactionStatus.CONFIRMED);
    assert.equal(first.amount, 5);
    assert.equal(first.stellarTxHash, "1".repeat(64));
    assert.equal(db.transactions[22].stellarTxHash, "3".repeat(64));
  });

  it("leaves a failed batch pending while committing successful ones", async () => {
    const db = createMockDb(12);
    let call = 0;
    const stellar: any = {
      refundParticipants: async () =>
        ++call === 1
          ? { success: false, error: "Error(Contract, #10)" }
          : { success: true, txHash: "a".repeat(64) },
    };

    const report = await new FinancialService(db, stellar).processLeagueRefunds(LEAGUE_ID);

    assert.equal(report.failedBatches.length, 1);
    assert.equal(report.failedBatches[0].memberIds.length, 10);
    assert.equal(report.refundedMemberIds.length, 2);
    assert.equal(
      db.members.filter((m: any) => m.paymentStatus === PaymentStatus.REFUND_PENDING).length,
      10
    );
    assert.equal(db.transactions.length, 2);

    // The failed batch is isolated in the dead-letter queue, not silently retried
    assert.equal(report.deadLetteredIds.length, 1);
    assert.equal(db.failedPayout.rows[0].memberIds.length, 10);
    assert.equal(db.failedPayout.rows[0].recoverable, false);
    assert.equal(db.failedPayout.rows[0].errorCode, 10);
  });

  it("skips members without a Stellar address", async () => {
    const db = createMockDb(3);
    db.members[1].stellarAddress = null;
    const stellar: any = { refundParticipants: async () => ({ success: true, txHash: "b".repeat(64) }) };

    const report = await new FinancialService(db, stellar).processLeagueRefunds(LEAGUE_ID);
    assert.deepEqual(report.skippedMemberIds, ["m1"]);
    assert.equal(report.refundedMemberIds.length, 2);
    assert.deepEqual(db.failedPayout.rows[0].memberIds, ["m1"]);
    assert.match(db.failedPayout.rows[0].errorMessage, /MISSING_WALLET/);
  });

  it("refuses to refund a league that is not cancelled", async () => {
    const db = createMockDb(2, LeagueStatus.ACTIVE);
    await assert.rejects(
      () => new FinancialService(db, {} as any).processLeagueRefunds(LEAGUE_ID),
      FinancialValidationError
    );
  });

  it("verifies the escrow balance drops to 0 after refunds", async () => {
    const db = createMockDb(2);
    db.members.forEach((m: any) => (m.paymentStatus = PaymentStatus.REFUNDED));
    const deposits = new Map<string, bigint>([[db.members[0].stellarAddress, 0n], [db.members[1].stellarAddress, 0n]]);
    const stellar: any = { getContractDeposit: async (_id: bigint, addr: string) => deposits.get(addr) };
    const service = new FinancialService(db, stellar);

    let check = await service.verifyRefundReconciliation(LEAGUE_ID);
    assert.equal(check.isFullyRefunded, true);
    assert.equal(check.remainingEscrowStroops, "0");

    deposits.set(db.members[1].stellarAddress, 50_000_000n);
    check = await service.verifyRefundReconciliation(LEAGUE_ID);
    assert.equal(check.isFullyRefunded, false);
    assert.equal(check.remainingEscrowStroops, "50000000");
  });

  it("detects leagues below minMembers once the start gameweek kicks off", () => {
    const deadline = new Date("2026-09-01T10:00:00Z");
    const firstKickoff = new Date("2026-09-01T11:30:00Z");
    const underfilled = { currentMembers: 2, minMembers: 4 };

    assert.equal(
      LeagueService.isUnderfilledAfterKickoff(underfilled, { deadline, firstKickoff }, new Date("2026-09-01T11:00:00Z")),
      false
    );
    assert.equal(
      LeagueService.isUnderfilledAfterKickoff(underfilled, { deadline, firstKickoff }, new Date("2026-09-01T11:30:00Z")),
      true
    );
    assert.equal(
      LeagueService.isUnderfilledAfterKickoff({ currentMembers: 4, minMembers: 4 }, { deadline, firstKickoff }, new Date("2026-09-02")),
      false
    );
    // Falls back to the deadline when no kickoff time is known
    assert.equal(
      LeagueService.isUnderfilledAfterKickoff(underfilled, { deadline, firstKickoff: null }, new Date("2026-09-01T10:00:00Z")),
      true
    );
  });
});
