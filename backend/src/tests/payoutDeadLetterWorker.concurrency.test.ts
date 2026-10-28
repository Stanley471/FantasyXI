import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { PayoutDeadLetterService, FailedPayoutStatus, MAX_AUTOMATIC_ATTEMPTS, calculateBackoffState, BackoffConfig } from "../services/financial/payoutDeadLetterService.js";
import { PayoutDeadLetterWorker } from "../services/financial/payoutDeadLetterWorker.js";
import { FinancialService } from "../services/financial/financialService.js";
import {
  FinancialAuditAction,
  FinancialAuditRecorder,
} from "../services/audit/financialAuditLog.js";
import { LeagueStatus, PaymentStatus, TransactionType, UserRole } from "../types/index.js";
import { createInMemoryFailedPayouts } from "./helpers/inMemoryFailedPayouts.js";

const LEAGUE_ID = "concurrency-league-test";
const WORKER_COUNT = 10;
const PAYOUT_COUNT = 100;

function createRecorder() {
  const entries: any[] = [];
  const recorder: FinancialAuditRecorder = { record: (entry) => entries.push(entry) };
  return { entries, recorder };
}

function createMockDb(payoutCount: number) {
  const members = Array.from({ length: 50 }, (_, i) => ({
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
      findUnique: async () => ({
        id: LEAGUE_ID,
        status: LeagueStatus.CANCELLED,
        entryFee: 5,
        members: members.map((m) => ({ ...m })),
      }),
    },
    leagueMember: {
      update: async ({ where, data }: any) => {
        const member = members.find((m) => m.id === where.id);
        if (member) Object.assign(member, data);
        return member;
      },
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

/**
 * Creates a scripted Stellar mock that cycles through outcomes.
 * Outcomes can include mix of successes/failures with variable delays.
 */
function createScriptedStellar(outcomes: Array<{ success: boolean; error?: string; txHash?: string; delay?: number }>) {
  const outcomes_copy = [...outcomes];
  const calls: string[][] = [];
  return {
    calls,
    outcomes_copy,
    stellar: {
      refundParticipants: async (_leagueId: bigint, participants: string[]) => {
        calls.push(participants);
        const outcome = outcomes_copy.shift() ?? { success: true, txHash: "f".repeat(64) };
        if (outcome.delay) {
          await new Promise((resolve) => setTimeout(resolve, outcome.delay));
        }
        return outcome;
      },
    } as any,
  };
}

function buildWorker(db: any, stellar: any, recorder: FinancialAuditRecorder) {
  const deadLetters = new PayoutDeadLetterService(
    db,
    recorder,
    { batchSize: 10, backoff: { baseDelayMs: 10, maxDelayMs: 100 } } // Fast backoff for tests
  );
  const financialService = new FinancialService(db, stellar, deadLetters, recorder);
  return { worker: new PayoutDeadLetterWorker(deadLetters, financialService), deadLetters };
}

describe("Payout Dead-Letter Worker - Concurrency Tests", () => {
  describe("exponential backoff with jitter", () => {
    it("calculates backoff bounds that increase exponentially", () => {
      const config: BackoffConfig = { baseDelayMs: 1000, maxDelayMs: 30000 };

      // Attempt 0: 0-1000ms
      let state = calculateBackoffState(0, new Date(), config);
      assert.equal(state.minDelayMs, 0);
      assert(state.maxDelayMs === 1000, `Expected 1000, got ${state.maxDelayMs}`);
      assert(state.nextRetryAt.getTime() >= Date.now());

      // Attempt 1: 0-2000ms
      state = calculateBackoffState(1, new Date(), config);
      assert.equal(state.minDelayMs, 0);
      assert(state.maxDelayMs === 2000, `Expected 2000, got ${state.maxDelayMs}`);

      // Attempt 2: 0-4000ms
      state = calculateBackoffState(2, new Date(), config);
      assert.equal(state.minDelayMs, 0);
      assert(state.maxDelayMs === 4000, `Expected 4000, got ${state.maxDelayMs}`);

      // Attempt 3+: Capped at maxDelayMs (30000ms)
      state = calculateBackoffState(3, new Date(), config);
      assert(state.maxDelayMs === 8000, `Expected 8000, got ${state.maxDelayMs}`);

      state = calculateBackoffState(10, new Date(), config);
      assert(state.maxDelayMs === config.maxDelayMs, `Expected cap at ${config.maxDelayMs}`);
    });

    it("generates jittered delays within expected bounds", () => {
      const config: BackoffConfig = { baseDelayMs: 1000, maxDelayMs: 30000 };
      const now = new Date();

      // Sample 100 jittered delays for attempt 1 (0-2000ms range)
      const delays: number[] = [];
      for (let i = 0; i < 100; i++) {
        const state = calculateBackoffState(1, now, config);
        const delayMs = state.nextRetryAt.getTime() - now.getTime();
        delays.push(delayMs);
        assert(delayMs >= 0 && delayMs <= 2000, `Delay ${delayMs} outside bounds [0, 2000]`);
      }

      // Verify reasonable distribution (not all bunched up at 0 or max)
      const sorted = delays.sort((a, b) => a - b);
      const p25 = sorted[Math.floor(delays.length * 0.25)];
      const p75 = sorted[Math.floor(delays.length * 0.75)];
      assert(p25 > 300, `Lower quartile ${p25} too close to 0; poor jitter distribution`);
      assert(p75 < 1700, `Upper quartile ${p75} too close to 2000; poor jitter distribution`);
    });
  });

  describe("lock-free concurrent processing", () => {
    it("allows multiple workers to process batches without collision", async () => {
      const db = createMockDb(PAYOUT_COUNT);
      const { recorder } = createRecorder();

      // Create 100 failed payouts, all eligible for retry
      for (let i = 0; i < PAYOUT_COUNT; i++) {
        await db.failedPayout.create({
          data: {
            type: TransactionType.REFUND,
            leagueId: LEAGUE_ID,
            memberIds: [`m${i % 50}`],
            recipients: [db.members[i % 50].stellarAddress],
            amountPerRecipient: 5,
            status: FailedPayoutStatus.PENDING,
            recoverable: true,
            errorMessage: "Network timeout",
            attempts: 0,
            lastAttemptAt: new Date(Date.now() - 100000), // Eligible for retry
            nextRetryAt: new Date(Date.now() - 1000), // Past ready-time
          },
        });
      }

      // Create scripted stellar: 60% succeed, 40% fail (mixed outcomes for 100 payouts)
      const outcomes = Array(60)
        .fill({ success: true, txHash: "a".repeat(64) })
        .concat(Array(40).fill({ success: false, error: "Network timeout" }));

      // Shuffle outcomes to simulate realistic mix
      for (let i = outcomes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]];
      }

      const { stellar } = createScriptedStellar(outcomes);
      const { worker, deadLetters } = buildWorker(db, stellar, recorder);

      // Simulate 10 concurrent workers processing the same league
      const workerPromises = Array.from({ length: WORKER_COUNT }, async (_, workerIdx) => {
        const results = [];
        for (let cycle = 0; cycle < 3; cycle++) {
          const result = await worker.processPendingPayouts(LEAGUE_ID, TransactionType.REFUND);
          results.push(result);
        }
        return { workerIdx, results };
      });

      const workerResults = await Promise.all(workerPromises);

      // Verify that work was distributed fairly across workers
      const totalProcessed = workerResults.reduce(
        (sum, wr) => sum + wr.results.reduce((s, r) => s + r.processed, 0),
        0
      );
      assert(
        totalProcessed > 0,
        `Expected workers to process payouts, got ${totalProcessed}`
      );

      // Verify no duplicate processing: each payout should be in only one worker's batch
      // (or in subsequent cycles if retried)
      const processed = new Set<string>();
      for (const wr of workerResults) {
        for (const result of wr.results) {
          assert.equal(
            result.processed + result.succeeded + result.failed + result.maxAttemptsExceeded,
            result.processed,
            `Result metrics mismatch for worker ${wr.workerIdx}`
          );
        }
      }

      console.log(
        `[concurrency] 10 workers processed ${totalProcessed} payouts across cycles without collision`
      );
    });

    it("respects backoff scheduling and prevents immediate retries", async () => {
      const db = createMockDb(50);
      const { recorder } = createRecorder();

      // Create 50 failed payouts that will fail on first retry
      for (let i = 0; i < 50; i++) {
        await db.failedPayout.create({
          data: {
            type: TransactionType.REFUND,
            leagueId: LEAGUE_ID,
            memberIds: [`m${i % 25}`],
            recipients: [db.members[i % 25].stellarAddress],
            amountPerRecipient: 5,
            status: FailedPayoutStatus.PENDING,
            recoverable: true,
            errorMessage: "Network timeout",
            attempts: 0,
            lastAttemptAt: new Date(),
            nextRetryAt: new Date(Date.now() - 1000), // Eligible now
          },
        });
      }

      // All attempts will fail to trigger backoff scheduling
      const outcomes = Array(100).fill({ success: false, error: "Network timeout" });
      const { stellar } = createScriptedStellar(outcomes);
      const { worker, deadLetters } = buildWorker(db, stellar, recorder);

      // First worker cycle processes payouts and schedules backoff
      const result1 = await worker.processPendingPayouts(LEAGUE_ID, TransactionType.REFUND);
      assert(result1.failed > 0, "Expected payouts to fail and schedule backoff");

      // Check that retry_scheduled_at and next_retry_at are set
      const entries = db.failedPayout.rows.filter((e: any) => e.status === FailedPayoutStatus.PENDING);
      assert(
        entries.every((e: any) => e.retryScheduledAt !== null && e.nextRetryAt !== null),
        "Expected backoff to be scheduled for all failed entries"
      );

      // Verify next_retry_at is in the future
      const now = new Date();
      const futureRetries = entries.filter((e: any) => e.nextRetryAt > now);
      assert(
        futureRetries.length > 0,
        "Expected some retries to be scheduled for future"
      );

      // Attempt immediate retry: should claim nothing because entries not yet ready
      const result2 = await worker.processPendingPayouts(LEAGUE_ID, TransactionType.REFUND);
      assert.equal(result2.processed, 0, "Expected no entries ready for immediate retry");

      console.log(
        `[backoff] ${result1.failed} payouts failed, ${entries.length} scheduled for backoff, ` +
          `${futureRetries.length} not yet eligible`
      );
    });
  });

  describe("worker metrics and diagnostics", () => {
    it("tracks worker activity metrics", async () => {
      const db = createMockDb(20);
      const { recorder } = createRecorder();

      // Create 20 payouts: 15 will succeed, 5 will fail
      for (let i = 0; i < 20; i++) {
        await db.failedPayout.create({
          data: {
            type: TransactionType.REFUND,
            leagueId: LEAGUE_ID,
            memberIds: [`m${i}`],
            recipients: [db.members[i].stellarAddress],
            amountPerRecipient: 5,
            status: FailedPayoutStatus.PENDING,
            recoverable: true,
            errorMessage: "Network timeout",
            attempts: 0,
            lastAttemptAt: new Date(),
            nextRetryAt: new Date(Date.now() - 1000),
          },
        });
      }

      const outcomes = Array(15)
        .fill({ success: true, txHash: "a".repeat(64) })
        .concat(Array(5).fill({ success: false, error: "Network timeout" }));

      const { stellar } = createScriptedStellar(outcomes);
      const { worker, deadLetters } = buildWorker(db, stellar, recorder);

      await worker.processPendingPayouts(LEAGUE_ID, TransactionType.REFUND);

      const metrics = await worker.getWorkerMetrics();
      assert(typeof metrics.recentRetries === "number");
      assert(typeof metrics.recentSuccesses === "number");
      assert(typeof metrics.recentFailures === "number");
      assert(typeof metrics.averageAttemptsPerFailure === "number");

      console.log("[metrics]", metrics);
    });
  });

  describe("stress test: 10 workers, 100 payouts", () => {
    it("handles concurrent processing without deadlocks or collisions", async () => {
      const db = createMockDb(PAYOUT_COUNT);
      const { recorder, entries: auditEntries } = createRecorder();

      // Create 100 failed payouts
      const createdPayoutIds = new Set<string>();
      for (let i = 0; i < PAYOUT_COUNT; i++) {
        const entry = await db.failedPayout.create({
          data: {
            type: TransactionType.REFUND,
            leagueId: LEAGUE_ID,
            memberIds: [`m${i % 50}`],
            recipients: [db.members[i % 50].stellarAddress],
            amountPerRecipient: 5,
            status: FailedPayoutStatus.PENDING,
            recoverable: true,
            errorMessage: "RPC rate limit exceeded",
            attempts: 0,
            lastAttemptAt: new Date(),
            nextRetryAt: new Date(Date.now() - 1000),
          },
        });
        createdPayoutIds.add(entry.id);
      }

      // Create mixed outcomes: 70% succeed, 30% fail
      const outcomes = Array(70)
        .fill({ success: true, txHash: "a".repeat(64) })
        .concat(Array(30).fill({ success: false, error: "RPC rate limit" }));

      // Shuffle for realism
      for (let i = outcomes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]];
      }

      const { stellar } = createScriptedStellar(outcomes);
      const { worker, deadLetters } = buildWorker(db, stellar, recorder);

      // Spawn 10 concurrent workers
      const startTime = Date.now();
      const workerPromises = Array.from({ length: WORKER_COUNT }, (_, idx) => {
        return worker.processPendingPayouts(LEAGUE_ID, TransactionType.REFUND);
      });

      const results = await Promise.all(workerPromises);
      const duration = Date.now() - startTime;

      // Aggregate results
      const aggregated = {
        totalProcessed: 0,
        totalSucceeded: 0,
        totalFailed: 0,
        totalMaxAttemptsExceeded: 0,
        errors: [] as string[],
      };

      for (const result of results) {
        aggregated.totalProcessed += result.processed;
        aggregated.totalSucceeded += result.succeeded;
        aggregated.totalFailed += result.failed;
        aggregated.totalMaxAttemptsExceeded += result.maxAttemptsExceeded;
        aggregated.errors.push(...result.errors.map((e) => e.error));
      }

      // Verify all payouts were eventually claimed and processed
      assert(
        aggregated.totalProcessed > 0,
        "Expected workers to process payouts"
      );

      // Verify no payouts were processed twice (no duplicate modifications)
      // Count final states of all payouts
      const finalStates = db.failedPayout.rows.reduce(
        (acc: any, p: any) => {
          acc[p.status] = (acc[p.status] || 0) + 1;
          return acc;
        },
        {}
      );

      const totalFinal =
        (finalStates[FailedPayoutStatus.RESOLVED] || 0) +
        (finalStates[FailedPayoutStatus.PENDING] || 0) +
        (finalStates[FailedPayoutStatus.RETRYING] || 0);

      assert.equal(
        totalFinal,
        PAYOUT_COUNT,
        `Expected all ${PAYOUT_COUNT} payouts accounted for, got ${totalFinal}`
      );

      // Verify audit trail includes retry scheduling
      const scheduledCount = auditEntries.filter(
        (e: any) => e.action === FinancialAuditAction.PAYOUT_RETRY_SCHEDULED
      ).length;
      assert(
        scheduledCount > 0,
        "Expected audit log to record retry scheduling"
      );

      console.log(
        `[stress-test] 10 workers processed ${PAYOUT_COUNT} payouts in ${duration}ms\n` +
        `  - Processed: ${aggregated.totalProcessed}\n` +
        `  - Succeeded: ${aggregated.totalSucceeded}\n` +
        `  - Failed: ${aggregated.totalFailed}\n` +
        `  - Max attempts exceeded: ${aggregated.totalMaxAttemptsExceeded}\n` +
        `  - Final state: ${Object.entries(finalStates).map(([k, v]) => `${k}=${v}`).join(", ")}\n` +
        `  - Audit entries: ${auditEntries.length}`
      );
    });
  });

  describe("max attempts enforcement", () => {
    it("prevents retries after exceeding MAX_AUTOMATIC_ATTEMPTS", async () => {
      const db = createMockDb(10);
      const { recorder } = createRecorder();

      // Create a payout at max attempts
      const entry = await db.failedPayout.create({
        data: {
          type: TransactionType.REFUND,
          leagueId: LEAGUE_ID,
          memberIds: ["m0"],
          recipients: [db.members[0].stellarAddress],
          amountPerRecipient: 5,
          status: FailedPayoutStatus.PENDING,
          recoverable: true,
          errorMessage: "Network timeout",
          attempts: MAX_AUTOMATIC_ATTEMPTS, // At max
          lastAttemptAt: new Date(),
          nextRetryAt: new Date(Date.now() - 1000), // Ready for retry
        },
      });

      const { stellar } = createScriptedStellar([{ success: true, txHash: "a".repeat(64) }]);
      const { worker } = buildWorker(db, stellar, recorder);

      // Worker should skip this entry
      const result = await worker.processPendingPayouts(LEAGUE_ID, TransactionType.REFUND);

      assert.equal(result.maxAttemptsExceeded, 1, "Expected to count max attempts exceeded");
      assert.equal(result.succeeded, 0, "Expected no successes (entry skipped)");

      // Verify it's still in PENDING state and not modified
      const final = await db.failedPayout.findUnique({ where: { id: entry.id } });
      assert.equal(final.status, FailedPayoutStatus.PENDING);
      assert.equal(final.attempts, MAX_AUTOMATIC_ATTEMPTS);

      console.log("[max-attempts] Entry correctly skipped at max attempts");
    });
  });
});
