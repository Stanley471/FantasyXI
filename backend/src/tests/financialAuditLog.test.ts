import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  FinancialAuditAction,
  FinancialAuditEntryInput,
  FinancialAuditLogger,
  FinancialAuditRecorder,
  SYSTEM_ACTOR,
} from "../services/audit/financialAuditLog.js";
import { FinancialService } from "../services/financial/financialService.js";
import { PayoutDeadLetterService } from "../services/financial/payoutDeadLetterService.js";
import { EscrowEventIndexer } from "../workers/eventIndexer.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  TransactionStatus,
} from "../types/index.js";
import { createInMemoryFailedPayouts } from "./helpers/inMemoryFailedPayouts.js";

const LEAGUE_ID = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";
const TX_HASH = "c".repeat(64);
const wallet = Keypair.random().publicKey();

function createRecorder() {
  const entries: FinancialAuditEntryInput[] = [];
  const recorder: FinancialAuditRecorder = { record: (entry) => entries.push(entry) };
  return { entries, recorder };
}

function createAuditDb(options: { failFirst?: number } = {}) {
  let failures = options.failFirst ?? 0;
  const rows: any[] = [];
  const calls: number[] = [];
  return {
    rows,
    calls,
    financialAuditLog: {
      createMany: async ({ data }: { data: any[] }) => {
        calls.push(data.length);
        if (failures > 0) {
          failures--;
          throw new Error("connection refused");
        }
        rows.push(...data);
        return { count: data.length };
      },
      findMany: async (args: any) => ({ args }),
    },
  };
}

describe("Financial Audit Log", () => {
  describe("FinancialAuditLogger", () => {
    it("records without awaiting the database and persists entries in one batch", async () => {
      const db = createAuditDb();
      const logger = new FinancialAuditLogger({ db, flushIntervalMs: 60_000 });

      logger.record({ action: FinancialAuditAction.DEPOSIT_CONFIRMED, userId: "u1", amount: 10 });
      logger.record({ action: FinancialAuditAction.REFUND, userId: "u2", amount: "5.50" });

      // Nothing hits the database on the hot path
      assert.equal(db.calls.length, 0);
      assert.equal(logger.pending, 2);

      await logger.flush();
      assert.deepEqual(db.calls, [2]);
      assert.equal(logger.pending, 0);

      const [first, second] = db.rows;
      assert.equal(first.action, FinancialAuditAction.DEPOSIT_CONFIRMED);
      assert.equal(first.userId, "u1");
      assert.equal(first.actorId, SYSTEM_ACTOR);
      assert.equal(first.amount, "10");
      assert.ok(first.createdAt instanceof Date);
      assert.equal(second.amount, "5.50");
      await logger.close();
    });

    it("flushes immediately once a batch fills up", async () => {
      const db = createAuditDb();
      const logger = new FinancialAuditLogger({ db, flushIntervalMs: 60_000, batchSize: 3 });

      for (let i = 0; i < 7; i++) {
        logger.record({ action: FinancialAuditAction.DEPOSIT_SUBMITTED, userId: `u${i}` });
      }
      await logger.close();

      assert.equal(db.rows.length, 7);
      assert.ok(db.calls.every((size) => size <= 3));
      // Insertion order is preserved
      assert.deepEqual(db.rows.map((r: any) => r.userId), ["u0", "u1", "u2", "u3", "u4", "u5", "u6"]);
    });

    it("keeps entries and retries them after a failed flush", async () => {
      const db = createAuditDb({ failFirst: 1 });
      const logger = new FinancialAuditLogger({ db, flushIntervalMs: 60_000 });

      logger.record({ action: FinancialAuditAction.FEE_EXTRACTION, amount: 1.25 });
      await logger.flush();
      assert.equal(db.rows.length, 0);
      assert.equal(logger.pending, 1);

      await logger.flush();
      assert.equal(db.rows.length, 1);
      assert.equal(logger.pending, 0);
      await logger.close();
    });

    it("bounds the buffer during a database outage", async () => {
      const db = createAuditDb({ failFirst: Infinity });
      const logger = new FinancialAuditLogger({ db, flushIntervalMs: 60_000, batchSize: 1_000, maxBufferSize: 5 });

      for (let i = 0; i < 8; i++) {
        logger.record({ action: FinancialAuditAction.WITHDRAWAL, userId: `u${i}` });
      }

      assert.equal(logger.pending, 5);
      assert.equal(logger.droppedCount, 3);
    });

    it("adds negligible overhead to the calling transaction", () => {
      const db = createAuditDb();
      const logger = new FinancialAuditLogger({ db, flushIntervalMs: 60_000, batchSize: 100_000, maxBufferSize: 100_000 });

      const started = process.hrtime.bigint();
      for (let i = 0; i < 10_000; i++) {
        logger.record({ action: FinancialAuditAction.DEPOSIT_CONFIRMED, userId: `u${i}`, amount: 10 });
      }
      const perRecordMicros = Number(process.hrtime.bigint() - started) / 1_000 / 10_000;

      assert.ok(perRecordMicros < 50, `record() took ${perRecordMicros.toFixed(2)}µs per call`);
      assert.equal(db.calls.length, 0);
    });

    it("exposes a read-only query API with bounded page size", async () => {
      const db = createAuditDb();
      const logger = new FinancialAuditLogger({ db });
      const result: any = await logger.query({ userId: "u1", action: FinancialAuditAction.REFUND, limit: 10_000 });

      assert.deepEqual(result.args.where, { userId: "u1", action: FinancialAuditAction.REFUND });
      assert.equal(result.args.take, 500);
      assert.deepEqual(result.args.orderBy, { createdAt: "desc" });
      assert.equal("update" in logger, false);
      assert.equal("delete" in logger, false);
    });
  });

  describe("FinancialService hooks", () => {
    function createPaymentDb(paymentStatus: PaymentStatus) {
      const member: any = {
        id: "member_1",
        leagueId: LEAGUE_ID,
        userId: "user_1",
        status: MembershipStatus.PENDING,
        paymentStatus,
        stellarAddress: wallet,
      };
      const league = { id: LEAGUE_ID, entryFee: 10, status: LeagueStatus.UPCOMING };
      return {
        member,
        leagueMember: {
          findUnique: async () => ({ ...member, league }),
          update: async ({ data }: any) => Object.assign(member, data),
        },
        transaction: {
          findFirst: async () => null,
          create: async ({ data }: any) => ({ id: "tx_1", ...data }),
          updateMany: async () => ({ count: 1 }),
        },
        $transaction: async (ops: any[]) => Promise.all(ops),
      };
    }

    function verifyingStellar(success: boolean) {
      return {
        isValidStellarAddress: () => true,
        isValidTransactionHash: () => true,
        verifyPaymentTransaction: async () =>
          success
            ? { success: true, txHash: TX_HASH, ledgerSeq: 42, confirmedAt: new Date() }
            : { success: false, txHash: TX_HASH, error: "Amount mismatch" },
      } as any;
    }

    it("logs deposit submission with user, amount and hash", async () => {
      const db = createPaymentDb(PaymentStatus.PAYMENT_INITIATED);
      const { entries, recorder } = createRecorder();
      const service = new FinancialService(db, verifyingStellar(true), undefined, recorder);

      await service.submitPayment("user_1", LEAGUE_ID, { stellarTxHash: TX_HASH, stellarAddress: wallet });

      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, FinancialAuditAction.DEPOSIT_SUBMITTED);
      assert.equal(entries[0].userId, "user_1");
      assert.equal(entries[0].actorId, "user_1");
      assert.equal(entries[0].transactionId, "tx_1");
      assert.equal(entries[0].amount, 10);
      assert.equal(entries[0].stellarTxHash, TX_HASH);
    });

    it("logs confirmed and failed deposits", async () => {
      const confirmed = createRecorder();
      await new FinancialService(
        createPaymentDb(PaymentStatus.PAYMENT_SUBMITTED),
        verifyingStellar(true),
        undefined,
        confirmed.recorder
      ).verifyAndConfirmPayment("user_1", LEAGUE_ID, TX_HASH);
      assert.equal(confirmed.entries[0].action, FinancialAuditAction.DEPOSIT_CONFIRMED);
      assert.deepEqual(confirmed.entries[0].metadata, { memberId: "member_1", ledgerSeq: 42 });

      const failed = createRecorder();
      await new FinancialService(
        createPaymentDb(PaymentStatus.PAYMENT_SUBMITTED),
        verifyingStellar(false),
        undefined,
        failed.recorder
      ).verifyAndConfirmPayment("user_1", LEAGUE_ID, TX_HASH);
      assert.equal(failed.entries[0].action, FinancialAuditAction.DEPOSIT_FAILED);
      assert.equal(failed.entries[0].metadata?.error, "Amount mismatch");
    });

    it("logs one REFUND entry per refunded member", async () => {
      const members = [0, 1].map((i) => ({
        id: `m${i}`,
        userId: `u${i}`,
        paymentStatus: PaymentStatus.REFUND_PENDING,
        stellarAddress: Keypair.random().publicKey(),
      }));
      const db: any = {
        league: {
          findUnique: async () => ({ id: LEAGUE_ID, status: LeagueStatus.CANCELLED, entryFee: 5, members }),
        },
        leagueMember: { update: async () => ({}) },
        transaction: { create: async ({ data }: any) => data },
        failedPayout: createInMemoryFailedPayouts(),
        $transaction: async (ops: any[]) => Promise.all(ops),
      };
      const { entries, recorder } = createRecorder();
      const stellar: any = { refundParticipants: async () => ({ success: true, txHash: TX_HASH }) };

      await new FinancialService(
        db,
        stellar,
        new PayoutDeadLetterService(db, recorder),
        recorder
      ).processLeagueRefunds(LEAGUE_ID);

      assert.deepEqual(
        entries.map((e) => [e.action, e.userId, e.amount, e.stellarTxHash]),
        [
          [FinancialAuditAction.REFUND, "u0", 5, TX_HASH],
          [FinancialAuditAction.REFUND, "u1", 5, TX_HASH],
        ]
      );
    });
  });

  describe("event indexer hooks", () => {
    function event(name: string, value: xdr.ScVal, txHash = TX_HASH, ledger = 500) {
      return {
        id: `${ledger}-1`,
        type: "contract",
        ledger,
        ledgerClosedAt: "2026-09-20T12:00:00Z",
        inSuccessfulContractCall: true,
        txHash,
        topic: [xdr.ScVal.scvSymbol(name), nativeToScVal(toContractLeagueId(LEAGUE_ID), { type: "u64" })],
        value,
      } as any;
    }

    function createIndexerDb() {
      const league: any = { id: LEAGUE_ID, creatorId: "creator_1", entryFee: 10, status: "ACTIVE" };
      const member: any = {
        id: "member_1",
        userId: "user_1",
        leagueId: LEAGUE_ID,
        status: MembershipStatus.PENDING,
        paymentStatus: PaymentStatus.PAYMENT_INITIATED,
        stellarAddress: wallet,
      };
      return {
        league: {
          findFirst: async () => league,
          update: async ({ data }: any) => Object.assign(league, data),
        },
        leagueMember: {
          findFirst: async () => member,
          findMany: async () => [],
          update: async ({ data }: any) => Object.assign(member, data),
        },
        transaction: { upsert: async () => ({ status: TransactionStatus.CONFIRMED }) },
        $transaction: async (ops: any[]) => Promise.all(ops),
      };
    }

    it("logs on-chain deposits once, even when the event is replayed", async () => {
      const { entries, recorder } = createRecorder();
      const indexer = new EscrowEventIndexer({ db: createIndexerDb(), audit: recorder });
      const deposit = event(
        "deposit",
        nativeToScVal([nativeToScVal(wallet, { type: "address" }), nativeToScVal(100_000_000n, { type: "i128" })])
      );

      await indexer.handleEvent(deposit);
      await indexer.handleEvent(deposit);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, FinancialAuditAction.DEPOSIT_CONFIRMED);
      assert.equal(entries[0].userId, "user_1");
      assert.equal(entries[0].amount, 10);
    });

    it("logs platform fee extraction on settlement", async () => {
      const { entries, recorder } = createRecorder();
      const indexer = new EscrowEventIndexer({ db: createIndexerDb(), audit: recorder });
      const settle = event(
        "settle",
        nativeToScVal([nativeToScVal(95_000_000n, { type: "i128" }), nativeToScVal(5_000_000n, { type: "i128" })])
      );

      await indexer.handleEvent(settle);
      await indexer.handleEvent(settle);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, FinancialAuditAction.FEE_EXTRACTION);
      assert.equal(entries[0].amount, 0.5);
      assert.equal(entries[0].leagueId, LEAGUE_ID);
    });

    it("logs prize withdrawals", async () => {
      const { entries, recorder } = createRecorder();
      const indexer = new EscrowEventIndexer({ db: createIndexerDb(), audit: recorder });

      await indexer.handleEvent(
        event(
          "claimed",
          nativeToScVal([nativeToScVal(wallet, { type: "address" }), nativeToScVal(95_000_000n, { type: "i128" })])
        )
      );

      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, FinancialAuditAction.WITHDRAWAL);
      assert.equal(entries[0].userId, "user_1");
      assert.equal(entries[0].amount, 9.5);
    });
  });
});
