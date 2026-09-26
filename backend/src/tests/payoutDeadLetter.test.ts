import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { FinancialService } from "../services/financial/financialService.js";
import {
  PayoutDeadLetterService,
  DeadLetterConflictError,
  FailedPayoutStatus,
  MAX_AUTOMATIC_ATTEMPTS,
  STALE_RETRY_MS,
} from "../services/financial/payoutDeadLetterService.js";
import {
  FinancialAuditAction,
  FinancialAuditEntryInput,
  FinancialAuditRecorder,
} from "../services/audit/financialAuditLog.js";
import adminRoutes from "../routes/admin.routes.js";
import { setRoleResolver } from "../middleware/authMiddleware.js";
import { signAccessToken } from "../config/jwt.js";
import {
  LeagueStatus,
  PaymentStatus,
  TransactionType,
  UserRole,
} from "../types/index.js";
import { createInMemoryFailedPayouts } from "./helpers/inMemoryFailedPayouts.js";

const LEAGUE_ID = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const ADMIN_ID = "admin-1";

function createRecorder() {
  const entries: FinancialAuditEntryInput[] = [];
  const recorder: FinancialAuditRecorder = { record: (entry) => entries.push(entry) };
  return { entries, recorder };
}

function createMockDb(memberCount: number) {
  const members = Array.from({ length: memberCount }, (_, i) => ({
    id: `m${i}`,
    userId: `u${i}`,
    paymentStatus: PaymentStatus.REFUND_PENDING as PaymentStatus,
    stellarAddress: Keypair.random().publicKey() as string | null,
  }));
  const transactions: any[] = [];
  const db: any = {
    members,
    transactions,
    league: {
      findUnique: async () => ({
        id: LEAGUE_ID,
        status: LeagueStatus.CANCELLED,
        entryFee: 5,
        members: members.map((m) => ({ ...m })),
      }),
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

/** Stellar double whose refund outcome is scripted per call. */
function scriptedStellar(outcomes: Array<{ success: boolean; error?: string; txHash?: string; contractErrorCode?: number }>) {
  const calls: string[][] = [];
  return {
    calls,
    stellar: {
      refundParticipants: async (_leagueId: bigint, participants: string[]) => {
        calls.push(participants);
        return outcomes.shift() ?? { success: true, txHash: "f".repeat(64) };
      },
    } as any,
  };
}

function buildService(db: any, stellar: any, recorder: FinancialAuditRecorder) {
  const deadLetters = new PayoutDeadLetterService(db, recorder);
  return { service: new FinancialService(db, stellar, deadLetters, recorder), deadLetters };
}

describe("Payout Dead-Letter Queue", () => {
  describe("error classification", () => {
    it("treats contract, configuration and wallet errors as non-recoverable", () => {
      for (const message of [
        "Simulation failed: HostError: Error(Contract, #10)",
        "TESTNET_ADMIN_SECRET is required to execute refunds",
        "Soroban contract client is not configured",
        "MISSING_WALLET: member has no linked Stellar address",
      ]) {
        assert.equal(PayoutDeadLetterService.classifyError(message).recoverable, false, message);
      }
      assert.equal(PayoutDeadLetterService.classifyError("Error(Contract, #7)").errorCode, 7);
    });

    it("treats transient network and RPC errors as recoverable", () => {
      for (const message of [
        "Transaction abc not confirmed in time",
        "connect ECONNRESET 1.2.3.4:443",
        "Request failed with status code 503",
        "Transaction rejected (TRY_AGAIN_LATER): unknown",
      ]) {
        assert.equal(PayoutDeadLetterService.classifyError(message).recoverable, true, message);
      }
    });

    it("defaults unknown errors to manual review", () => {
      assert.equal(PayoutDeadLetterService.classifyError("Transaction failed: AAAA").recoverable, false);
    });
  });

  describe("isolation of failed payouts", () => {
    it("isolates a non-recoverable failure and never auto-retries it", async () => {
      const db = createMockDb(3);
      const { recorder, entries } = createRecorder();
      const { stellar, calls } = scriptedStellar([
        { success: false, error: "Error(Contract, #10)", contractErrorCode: 10 },
      ]);
      const { service } = buildService(db, stellar, recorder);

      const first = await service.processLeagueRefunds(LEAGUE_ID);
      assert.equal(first.deadLetteredIds.length, 1);
      assert.equal(db.failedPayout.rows[0].status, FailedPayoutStatus.PENDING);
      assert.equal(db.failedPayout.rows[0].recoverable, false);
      assert.ok(entries.some((e) => e.action === FinancialAuditAction.PAYOUT_DEAD_LETTERED));

      // Subsequent job runs skip the isolated members entirely
      const second = await service.processLeagueRefunds(LEAGUE_ID);
      assert.equal(calls.length, 1);
      assert.equal(second.batches, 0);
      assert.deepEqual(second.isolatedMemberIds.sort(), ["m0", "m1", "m2"]);
      assert.equal(second.deadLetteredIds.length, 0);
      assert.ok(db.members.every((m: any) => m.paymentStatus === PaymentStatus.REFUND_PENDING));
    });

    it("automatically retries recoverable failures as their original batch", async () => {
      const db = createMockDb(2);
      const { recorder } = createRecorder();
      const { stellar, calls } = scriptedStellar([
        { success: false, error: "Transaction x not confirmed in time" },
        { success: true, txHash: "a".repeat(64) },
      ]);
      const { service } = buildService(db, stellar, recorder);

      await service.processLeagueRefunds(LEAGUE_ID);
      const retryRun = await service.processLeagueRefunds(LEAGUE_ID);

      assert.equal(calls.length, 2);
      assert.deepEqual(retryRun.autoRetried, [
        { failedPayoutId: db.failedPayout.rows[0].id, success: true },
      ]);
      assert.equal(db.failedPayout.rows[0].status, FailedPayoutStatus.RESOLVED);
      assert.equal(db.failedPayout.rows[0].resolvedById, "system");
      assert.ok(db.members.every((m: any) => m.paymentStatus === PaymentStatus.REFUNDED));
      assert.equal(db.transactions.length, 2);
    });

    it("stops automatic retries after MAX_AUTOMATIC_ATTEMPTS", async () => {
      const db = createMockDb(1);
      const { recorder } = createRecorder();
      const timeout = { success: false, error: "ETIMEDOUT" };
      const { stellar, calls } = scriptedStellar(Array(10).fill(timeout).map((o) => ({ ...o })));
      const { service } = buildService(db, stellar, recorder);

      for (let run = 0; run < MAX_AUTOMATIC_ATTEMPTS + 2; run++) {
        await service.processLeagueRefunds(LEAGUE_ID);
      }

      assert.equal(calls.length, MAX_AUTOMATIC_ATTEMPTS);
      assert.equal(db.failedPayout.rows.length, 1);
      assert.equal(db.failedPayout.rows[0].attempts, MAX_AUTOMATIC_ATTEMPTS);
      assert.equal(db.failedPayout.rows[0].status, FailedPayoutStatus.PENDING);
    });
  });

  describe("manual intervention", () => {
    it("lets an admin retry a dead-lettered payout successfully", async () => {
      const db = createMockDb(2);
      const { recorder, entries } = createRecorder();
      const { stellar } = scriptedStellar([
        { success: false, error: "Error(Contract, #3)" },
        { success: true, txHash: "b".repeat(64) },
      ]);
      const { service } = buildService(db, stellar, recorder);

      await service.processLeagueRefunds(LEAGUE_ID);
      const id = db.failedPayout.rows[0].id;

      const result = await service.retryDeadLetteredPayout(id, ADMIN_ID, "Escrow topped up");

      assert.equal(result.success, true);
      assert.equal(result.status, FailedPayoutStatus.RESOLVED);
      assert.deepEqual(result.paidMemberIds, ["m0", "m1"]);
      const row = db.failedPayout.rows[0];
      assert.equal(row.resolvedById, ADMIN_ID);
      assert.equal(row.retryTxHash, "b".repeat(64));
      assert.equal(row.resolutionNote, "Escrow topped up");
      assert.ok(db.members.every((m: any) => m.paymentStatus === PaymentStatus.REFUNDED));
      assert.ok(db.transactions.every((t: any) => t.type === TransactionType.REFUND));

      const success = entries.find((e) => e.action === FinancialAuditAction.PAYOUT_RETRY_SUCCEEDED);
      assert.equal(success?.actorId, ADMIN_ID);
      const refunds = entries.filter((e) => e.action === FinancialAuditAction.REFUND);
      assert.equal(refunds.length, 2);
      assert.ok(refunds.every((e) => e.actorId === ADMIN_ID));
    });

    it("re-queues the entry when a manual retry fails again", async () => {
      const db = createMockDb(1);
      const { recorder, entries } = createRecorder();
      const { stellar } = scriptedStellar([
        { success: false, error: "Error(Contract, #3)" },
        { success: false, error: "Error(Contract, #3)" },
      ]);
      const { service } = buildService(db, stellar, recorder);

      await service.processLeagueRefunds(LEAGUE_ID);
      const result = await service.retryDeadLetteredPayout(db.failedPayout.rows[0].id, ADMIN_ID);

      assert.equal(result.success, false);
      assert.equal(db.failedPayout.rows[0].status, FailedPayoutStatus.PENDING);
      assert.equal(db.failedPayout.rows[0].attempts, 2);
      assert.equal(db.members[0].paymentStatus, PaymentStatus.REFUND_PENDING);
      assert.ok(entries.some((e) => e.action === FinancialAuditAction.PAYOUT_RETRY_FAILED));
    });

    it("never pays a member twice when they were refunded in the meantime", async () => {
      const db = createMockDb(2);
      const { recorder } = createRecorder();
      const { stellar, calls } = scriptedStellar([{ success: false, error: "Error(Contract, #3)" }]);
      const { service } = buildService(db, stellar, recorder);

      await service.processLeagueRefunds(LEAGUE_ID);
      db.members[0].paymentStatus = PaymentStatus.REFUNDED; // e.g. picked up by the indexer

      const result = await service.retryDeadLetteredPayout(db.failedPayout.rows[0].id, ADMIN_ID);

      assert.deepEqual(result.paidMemberIds, ["m1"]);
      assert.deepEqual(calls[1], [db.members[1].stellarAddress]);
      assert.equal(db.transactions.length, 1);
    });

    it("uses a freshly linked wallet when retrying a missing-wallet entry", async () => {
      const db = createMockDb(1);
      db.members[0].stellarAddress = null;
      const { recorder } = createRecorder();
      const { stellar, calls } = scriptedStellar([]);
      const { service } = buildService(db, stellar, recorder);

      await service.processLeagueRefunds(LEAGUE_ID);
      assert.equal(calls.length, 0);
      assert.match(db.failedPayout.rows[0].errorMessage, /MISSING_WALLET/);

      const wallet = Keypair.random().publicKey();
      db.members[0].stellarAddress = wallet;
      const result = await service.retryDeadLetteredPayout(db.failedPayout.rows[0].id, ADMIN_ID);

      assert.equal(result.success, true);
      assert.deepEqual(calls[0], [wallet]);
    });

    it("rejects a concurrent retry of the same entry", async () => {
      const db = createMockDb(1);
      const { recorder } = createRecorder();
      const { deadLetters } = buildService(db, scriptedStellar([]).stellar, recorder);

      const entry = await deadLetters.deadLetter({
        type: TransactionType.REFUND,
        leagueId: LEAGUE_ID,
        memberIds: ["m0"],
        recipients: [db.members[0].stellarAddress],
        amountPerRecipient: 5,
        error: "Error(Contract, #3)",
      });

      await deadLetters.claimForRetry(entry.id);
      await assert.rejects(() => deadLetters.claimForRetry(entry.id), DeadLetterConflictError);

      // An orphaned claim (e.g. the process died mid-retry) becomes claimable again
      const later = new Date(Date.now() + STALE_RETRY_MS + 1_000);
      const reclaimed = await deadLetters.claimForRetry(entry.id, later);
      assert.equal(reclaimed.status, FailedPayoutStatus.RETRYING);
    });

    it("requires a reason to discard and blocks retries of closed entries", async () => {
      const db = createMockDb(1);
      const { recorder, entries } = createRecorder();
      const { service, deadLetters } = buildService(
        db,
        scriptedStellar([{ success: false, error: "Error(Contract, #3)" }]).stellar,
        recorder
      );

      await service.processLeagueRefunds(LEAGUE_ID);
      const id = db.failedPayout.rows[0].id;

      await assert.rejects(() => deadLetters.discard(id, ADMIN_ID, "  "), DeadLetterConflictError);
      const discarded = await deadLetters.discard(id, ADMIN_ID, "Refunded manually by support");
      assert.equal(discarded.status, FailedPayoutStatus.DISCARDED);
      assert.ok(entries.some((e) => e.action === FinancialAuditAction.PAYOUT_DISCARDED));

      await assert.rejects(() => service.retryDeadLetteredPayout(id, ADMIN_ID), DeadLetterConflictError);

      // A written-off payout is never picked up again by the automatic dispatcher
      const nextRun = await service.processLeagueRefunds(LEAGUE_ID);
      assert.equal(nextRun.batches, 0);
      assert.deepEqual(nextRun.isolatedMemberIds, ["m0"]);
      assert.equal(db.failedPayout.rows.length, 1);
    });
  });

  describe("admin endpoint access control", () => {
    let server: Server;
    let baseUrl: string;

    const tokenFor = (role: UserRole) =>
      signAccessToken({
        userId: `usr_${role.toLowerCase()}`,
        email: `${role.toLowerCase()}@example.com`,
        username: role.toLowerCase(),
        role,
      });

    const call = (method: string, path: string, role?: UserRole) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(role ? { Authorization: `Bearer ${tokenFor(role)}` } : {}),
        },
        body: method === "POST" ? JSON.stringify({ reason: "test" }) : undefined,
      });

    before(async () => {
      // No database here: elevated permissions re-check the role, so resolve it from the test user id
      setRoleResolver(async (userId) => userId.replace(/^usr_/, "").toUpperCase() as UserRole);
      const app = express();
      app.use(express.json());
      app.use("/api/v1/admin", adminRoutes);
      server = app.listen(0);
      await new Promise((resolve) => server.once("listening", resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
      setRoleResolver(null);
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("rejects unauthenticated access", async () => {
      const res = await call("GET", "/api/v1/admin/payouts/dead-letter");
      assert.equal(res.status, 401);
    });

    it("rejects regular users from viewing failed payouts", async () => {
      const res = await call("GET", "/api/v1/admin/payouts/dead-letter", UserRole.USER);
      assert.equal(res.status, 403);
    });

    it("rejects moderators from retrying, discarding or reading the audit log", async () => {
      for (const [method, path] of [
        ["POST", "/api/v1/admin/payouts/dead-letter/abc/retry"],
        ["POST", "/api/v1/admin/payouts/dead-letter/abc/discard"],
        ["GET", "/api/v1/admin/audit/financial"],
      ]) {
        const res = await call(method, path, UserRole.MODERATOR);
        assert.equal(res.status, 403, `${method} ${path}`);
      }
    });

    it("validates filters before touching the database", async () => {
      const res = await call("GET", "/api/v1/admin/payouts/dead-letter?status=BOGUS", UserRole.ADMIN);
      assert.equal(res.status, 400);
    });
  });
});
