/**
 * Integration and Unit Tests for Soroban Error Handling, Diagnostics, and State Recovery
 *
 * Verifies:
 * - Parsing and mapping of contract error codes to clear, human-readable explanations
 * - Distinction between retryable (transient network / sequence) and non-retryable errors
 * - Automatic retry execution with backoff on transient failures
 * - State consistency & automatic rollback execution upon contract invocation failure
 * - SorobanContractClient error parsing on simulated RPC failures
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSorobanError,
  executeWithRetry,
  executeWithRollback,
  EscrowContractErrorCode,
  ESCROW_ERROR_CATALOG,
} from "../services/financial/sorobanErrorRecovery.js";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import { Keypair } from "@stellar/stellar-sdk";

describe("Soroban Error Handling & Recovery Suite", () => {
  describe("Contract Error Code Decoding & Diagnostic Messaging", () => {
    it("should accurately decode all 15 escrow contract error codes", () => {
      const testCases = [
        {
          raw: "HostError: Error(Contract, #1)",
          code: EscrowContractErrorCode.AlreadyInitialized,
          contains: "Contract Already Initialized",
        },
        {
          raw: "Transaction simulation failed: Error(Contract, #2)",
          code: EscrowContractErrorCode.NotInitialized,
          contains: "Contract Not Initialized",
        },
        {
          raw: "HostError: Error(Contract, #3)",
          code: EscrowContractErrorCode.LeagueAlreadyExists,
          contains: "League Partition Already Exists",
        },
        {
          raw: "Error(Contract, #4)",
          code: EscrowContractErrorCode.LeagueNotFound,
          contains: "League Partition Not Found",
        },
        {
          raw: "Error(Contract, #5)",
          code: EscrowContractErrorCode.LeagueNotAcceptingDeposits,
          contains: "League Not Accepting Deposits",
        },
        {
          raw: "HostError: Error(Contract, #6)",
          code: EscrowContractErrorCode.AlreadyDeposited,
          contains: "Deposit Already Recorded",
        },
        {
          raw: "Error(Contract, #7)",
          code: EscrowContractErrorCode.AlreadySettled,
          contains: "League Already Settled",
        },
        {
          raw: "HostError: Error(Contract, #8)",
          code: EscrowContractErrorCode.InvalidAmount,
          contains: "Invalid Amount Specified",
        },
        {
          raw: "HostError: Error(Contract, #9)",
          code: EscrowContractErrorCode.PayoutExceedsDeposits,
          contains: "Payouts Exceed Escrow Balance",
        },
        {
          raw: "Error(Contract, #10)",
          code: EscrowContractErrorCode.NotAuthorized,
          contains: "Unauthorized Action",
        },
        {
          raw: "Error(Contract, #11)",
          code: EscrowContractErrorCode.FeeExceedsMaxCap,
          contains: "Platform Fee Exceeds Cap",
        },
        {
          raw: "Error(Contract, #12)",
          code: EscrowContractErrorCode.InvalidPrizeDistribution,
          contains: "Invalid Prize Distribution",
        },
        {
          raw: "Error(Contract, #13)",
          code: EscrowContractErrorCode.NoClaimablePrize,
          contains: "No Claimable Prize Found",
        },
        {
          raw: "Error(Contract, #14)",
          code: EscrowContractErrorCode.InvalidProof,
          contains: "Invalid Settlement Proof",
        },
        {
          raw: "Error(Contract, #15)",
          code: EscrowContractErrorCode.InvalidMultisig,
          contains: "Multisig Threshold Not Met",
        },
      ];

      for (const tc of testCases) {
        const parsed = parseSorobanError(tc.raw);
        assert.strictEqual(parsed.isContractError, true, `Failed for ${tc.raw}`);
        assert.strictEqual(parsed.errorCode, tc.code);
        assert.ok(
          parsed.humanMessage.includes(tc.contains),
          `Expected message to contain '${tc.contains}', got '${parsed.humanMessage}'`
        );
        assert.strictEqual(parsed.isRetryable, false);
      }
    });

    it("should provide friendly error message for missing USDC trustline or insufficient balance", () => {
      const res = parseSorobanError("HostError: op_no_trust line for asset USDC");
      assert.strictEqual(res.isContractError, false);
      assert.ok(res.humanMessage.includes("Insufficient balance or missing USDC trustline"));
      assert.strictEqual(res.isRetryable, false);
    });

    it("should flag transient network errors and bad sequences as retryable", () => {
      const badSeq = parseSorobanError("txBAD_SEQ");
      assert.strictEqual(badSeq.isRetryable, true);

      const timeout = parseSorobanError("Request failed with status code 504 Gateway Timeout");
      assert.strictEqual(timeout.isRetryable, true);

      const rateLimit = parseSorobanError("RPC rate limit exceeded (429 Too Many Requests)");
      assert.strictEqual(rateLimit.isRetryable, true);
    });
  });

  describe("Automated Retry Logic on Transient RPC Failures", () => {
    it("should succeed after recovering from transient retryable failures", async () => {
      let attempts = 0;
      const result = await executeWithRetry(
        async (attempt) => {
          attempts++;
          if (attempt < 3) {
            throw new Error("RPC rate limit exceeded (429)");
          }
          return { confirmed: true };
        },
        { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 50 }
      );

      assert.strictEqual(attempts, 3);
      assert.deepStrictEqual(result, { confirmed: true });
    });

    it("should fail immediately without retrying on contract business errors", async () => {
      let attempts = 0;
      await assert.rejects(
        async () => {
          await executeWithRetry(
            async () => {
              attempts++;
              throw new Error("HostError: Error(Contract, #6)"); // AlreadyDeposited
            },
            { maxRetries: 3, initialDelayMs: 10 }
          );
        },
        /Error\(Contract, #6\)/
      );

      assert.strictEqual(attempts, 1, "Should not retry non-retryable contract business errors");
    });
  });

  describe("Application State Consistency & Rollback Recovery", () => {
    it("should trigger rollback and keep state consistent when contract call fails", async () => {
      // Simulate database state
      let dbLeagueState = "UPCOMING";
      let dbParticipantBalance = 100;
      let rollbackInvoked = false;

      const mockDepositAttempt = async () => {
        return executeWithRollback({
          name: "DepositSettlement",
          prepareState: async () => {
            // Optimistically update DB state
            const previousBalance = dbParticipantBalance;
            dbParticipantBalance -= 10;
            return { previousBalance };
          },
          executeContract: async () => {
            // Simulated contract invocation fails because user already deposited
            return {
              success: false,
              error: "HostError: Error(Contract, #6)",
            };
          },
          isInvocationSuccessful: (res) => res.success,
          rollbackState: async (state, error) => {
            // Revert optimistic database update
            dbParticipantBalance = state.previousBalance;
            rollbackInvoked = true;
            assert.strictEqual(error.errorCode, EscrowContractErrorCode.AlreadyDeposited);
          },
        });
      };

      const result = await mockDepositAttempt();
      assert.strictEqual(result.success, false);
      assert.strictEqual(rollbackInvoked, true, "Rollback handler must be invoked");
      assert.strictEqual(dbParticipantBalance, 100, "State must be reverted to preserve consistency");
    });

    it("should maintain state and NOT trigger rollback when contract call succeeds", async () => {
      let dbBalance = 100;
      let rollbackInvoked = false;

      const result = await executeWithRollback({
        name: "DepositSettlement",
        prepareState: async () => {
          dbBalance -= 10;
          return { previousBalance: 100 };
        },
        executeContract: async () => {
          return { success: true, txHash: "0x123456" };
        },
        isInvocationSuccessful: (res) => res.success,
        rollbackState: async () => {
          rollbackInvoked = true;
        },
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(rollbackInvoked, false);
      assert.strictEqual(dbBalance, 90);
    });
  });

  describe("SorobanContractClient Integration with Error Recovery", () => {
    it("should return structured error info with humanError on simulation failure", async () => {
      const mockRpcServer: any = {
        getAccount: async () => ({
          accountId: () => Keypair.random().publicKey(),
          sequenceNumber: () => "1",
          incrementSequenceNumber: () => {},
        }),
        simulateTransaction: async () => ({
          error: "HostError: Error(Contract, #9)", // PayoutExceedsDeposits
        }),
      };

      const client = new SorobanContractClient({
        server: mockRpcServer,
        escrowContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      });

      const res = await client.settle(
        Keypair.random().secret(),
        Keypair.random().publicKey(),
        1001,
        [{ winner: Keypair.random().publicKey(), amount: "500000000" }],
        Keypair.random().publicKey(),
        5000000n
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.contractErrorCode, EscrowContractErrorCode.PayoutExceedsDeposits);
      assert.ok(res.humanError?.includes("Payouts Exceed Escrow Balance"));
      assert.strictEqual(res.isRetryable, false);
    });
  });
});
