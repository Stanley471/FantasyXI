/**
 * FantasyXI Live Stellar Testnet End-to-End Escrow Suite
 *
 * Tests on-chain lifecycle against Stellar Testnet:
 * 1. Contract Initialization & League Partitioning
 * 2. Multi-Manager Deposits with On-Chain Token Transfers
 * 3. Security Invariants (Duplicate deposit guard, Unauthorized actions guard, Payout limit guard)
 * 4. Full Settlement Execution (5% platform fee + 60/30/10 prize distribution)
 * 5. Double Settlement Prevention (Atomic transition to Settled)
 * 6. Competition Cancellation & Full Deposit Refunds
 * 7. Duplicate Refund Prevention
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import { PrizeService } from "../services/league/prizeService.js";

// Load testnet credentials from .env.testnet.local
const envTestnetPath = path.resolve(process.cwd(), ".env.testnet.local");
if (fs.existsSync(envTestnetPath)) {
  dotenv.config({ path: envTestnetPath });
}

const configured = Boolean(
  process.env.TESTNET_ADMIN_PUBLIC &&
  process.env.TESTNET_ADMIN_SECRET &&
  process.env.TESTNET_MANAGER_A_PUBLIC &&
  process.env.TESTNET_MANAGER_A_SECRET &&
  process.env.TESTNET_MANAGER_B_PUBLIC &&
  process.env.TESTNET_MANAGER_B_SECRET &&
  process.env.TESTNET_MANAGER_C_PUBLIC &&
  process.env.TESTNET_MANAGER_C_SECRET
);

describe("Stellar Testnet Live Soroban Escrow Lifecycle", { skip: !configured && "testnet env not configured" }, () => {
  let client: SorobanContractClient;

  // Keypairs from Testnet deployer
  const adminPublic = process.env.TESTNET_ADMIN_PUBLIC!;
  const adminSecret = process.env.TESTNET_ADMIN_SECRET!;

  const managerAPublic = process.env.TESTNET_MANAGER_A_PUBLIC!;
  const managerASecret = process.env.TESTNET_MANAGER_A_SECRET!;

  const managerBPublic = process.env.TESTNET_MANAGER_B_PUBLIC!;
  const managerBSecret = process.env.TESTNET_MANAGER_B_SECRET!;

  const managerCPublic = process.env.TESTNET_MANAGER_C_PUBLIC!;
  const managerCSecret = process.env.TESTNET_MANAGER_C_SECRET!;

  // 10 USDC in stroops (7 decimals)
  const ENTRY_FEE_10_USDC = 100_000_000n;

  before(() => {
    if (!configured) return;
    client = new SorobanContractClient();
  });

  describe("Step 3: League #1 Settlement & Security Invariants", () => {
    // Generate unique league ID based on timestamp
    const leagueId = Math.floor(Date.now() / 1000) % 1_000_000 + 1000;

    it("should successfully create a new league partition on-chain", async () => {
      const res = await client.createLeague(
        adminSecret,
        adminPublic,
        leagueId,
        ENTRY_FEE_10_USDC
      );
      assert.strictEqual(res.success, true, `League creation failed: ${res.error}`);

      const state = await client.getLeague(leagueId);
      assert.ok(state, "League state should exist on-chain");
      assert.strictEqual(state?.creator, adminPublic);
      assert.strictEqual(state?.entry_fee, ENTRY_FEE_10_USDC);
      assert.strictEqual(state?.participant_count, 0);
      assert.strictEqual(state?.status, 0); // Upcoming
      assert.strictEqual(state?.total_deposited, 0n);
    });

    it("should record 3 participant deposits and transfer USDC into escrow", async () => {
      const escrowBefore = await client.getTokenBalance(client.getEscrowContractId());
      const mgrABefore = await client.getTokenBalance(managerAPublic);
      const mgrBBefore = await client.getTokenBalance(managerBPublic);
      const mgrCBefore = await client.getTokenBalance(managerCPublic);

      // Manager A deposits 10 USDC
      const depA = await client.deposit(managerASecret, managerAPublic, leagueId);
      assert.strictEqual(depA.success, true, `Manager A deposit failed: ${depA.error}`);

      // Manager B deposits 10 USDC
      const depB = await client.deposit(managerBSecret, managerBPublic, leagueId);
      assert.strictEqual(depB.success, true, `Manager B deposit failed: ${depB.error}`);

      // Manager C deposits 10 USDC
      const depC = await client.deposit(managerCSecret, managerCPublic, leagueId);
      assert.strictEqual(depC.success, true, `Manager C deposit failed: ${depC.error}`);

      // Verify on-chain league state
      const state = await client.getLeague(leagueId);
      assert.strictEqual(state?.participant_count, 3);
      assert.strictEqual(state?.total_deposited, 300_000_000n);

      // Verify individual deposits
      const depValA = await client.getDeposit(leagueId, managerAPublic);
      const depValB = await client.getDeposit(leagueId, managerBPublic);
      const depValC = await client.getDeposit(leagueId, managerCPublic);
      assert.strictEqual(depValA, ENTRY_FEE_10_USDC);
      assert.strictEqual(depValB, ENTRY_FEE_10_USDC);
      assert.strictEqual(depValC, ENTRY_FEE_10_USDC);

      // Verify token balances
      const escrowAfter = await client.getTokenBalance(client.getEscrowContractId());
      const mgrAAfter = await client.getTokenBalance(managerAPublic);
      const mgrBAfter = await client.getTokenBalance(managerBPublic);
      const mgrCAfter = await client.getTokenBalance(managerCPublic);

      assert.strictEqual(escrowAfter - escrowBefore, 300_000_000n, "Escrow balance should increase by 30 USDC");
      assert.strictEqual(mgrABefore - mgrAAfter, 100_000_000n, "Manager A balance should decrease by 10 USDC");
      assert.strictEqual(mgrBBefore - mgrBAfter, 100_000_000n, "Manager B balance should decrease by 10 USDC");
      assert.strictEqual(mgrCBefore - mgrCAfter, 100_000_000n, "Manager C balance should decrease by 10 USDC");
    });

    it("should reject duplicate deposit on-chain (AlreadyDeposited = 6)", async () => {
      const dupDep = await client.deposit(managerASecret, managerAPublic, leagueId);
      assert.strictEqual(dupDep.success, false, "Duplicate deposit should fail");
      assert.strictEqual(dupDep.contractErrorCode, 6, "Expected EscrowError::AlreadyDeposited (#6)");
    });

    it("should reject settlement attempt by non-admin (NotAuthorized = 10)", async () => {
      const unauthorizedSettle = await client.settle(
        managerASecret,
        managerAPublic, // Not the contract admin!
        leagueId,
        [{ winner: managerAPublic, amount: "285000000" }],
        adminPublic,
        15_000_000n
      );
      assert.strictEqual(unauthorizedSettle.success, false, "Unauthorized settle should fail");
      assert.strictEqual(unauthorizedSettle.contractErrorCode, 10, "Expected EscrowError::NotAuthorized (#10)");
    });

    it("should reject settlement where total payouts exceed deposits (PayoutExceedsDeposits = 9)", async () => {
      const excessiveSettle = await client.settle(
        adminSecret,
        adminPublic,
        leagueId,
        [{ winner: managerAPublic, amount: "350000000" }], // 35 USDC > 30 USDC deposited!
        adminPublic,
        15_000_000n
      );
      assert.strictEqual(excessiveSettle.success, false, "Excessive settle should fail");
      assert.strictEqual(excessiveSettle.contractErrorCode, 9, "Expected EscrowError::PayoutExceedsDeposits (#9)");
    });

    it("should execute settlement with 60/30/10 prize split + 5% platform fee", async () => {
      // Off-chain calculation via FantasyXI PrizeService
      const prizeConfig = PrizeService.calculatePrizeDistribution(3, 10);
      assert.strictEqual(prizeConfig.platformFee, 1.5);
      assert.strictEqual(prizeConfig.prizePool, 28.5);
      assert.strictEqual(prizeConfig.prizes.first, 17.1);
      assert.strictEqual(prizeConfig.prizes.second, 8.55);
      assert.strictEqual(prizeConfig.prizes.third, 2.85);

      const feeStroops = 15_000_000n; // 1.50 USDC
      const winners = [
        { winner: managerAPublic, amount: "171000000" }, // 17.10 USDC (60%)
        { winner: managerBPublic, amount: "85500000" },  // 8.55 USDC (30%)
        { winner: managerCPublic, amount: "28500000" },  // 2.85 USDC (10%)
      ];

      const escrowBefore = await client.getTokenBalance(client.getEscrowContractId());
      const mgrABefore = await client.getTokenBalance(managerAPublic);
      const mgrBBefore = await client.getTokenBalance(managerBPublic);
      const mgrCBefore = await client.getTokenBalance(managerCPublic);

      const settleRes = await client.settle(
        adminSecret,
        adminPublic,
        leagueId,
        winners,
        adminPublic,
        feeStroops
      );
      assert.strictEqual(settleRes.success, true, `Settlement failed: ${settleRes.error}`);
      assert.ok(settleRes.txHash, "Should produce transaction hash on Testnet");

      // Verify on-chain league status transitioned to Settled (2)
      const state = await client.getLeague(leagueId);
      assert.strictEqual(state?.status, 2, "League status should be Settled (2)");

      // Verify token balances after settlement
      const escrowAfter = await client.getTokenBalance(client.getEscrowContractId());
      const mgrAAfter = await client.getTokenBalance(managerAPublic);
      const mgrBAfter = await client.getTokenBalance(managerBPublic);
      const mgrCAfter = await client.getTokenBalance(managerCPublic);

      assert.strictEqual(escrowBefore - escrowAfter, 300_000_000n, "Escrow balance should decrease by total 30 USDC");
      assert.strictEqual(mgrAAfter - mgrABefore, 171_000_000n, "Manager A should receive 17.10 USDC (1st Place)");
      assert.strictEqual(mgrBAfter - mgrBBefore, 85_500_000n, "Manager B should receive 8.55 USDC (2nd Place)");
      assert.strictEqual(mgrCAfter - mgrCBefore, 28_500_000n, "Manager C should receive 2.85 USDC (3rd Place)");
    });

    it("should prevent double settlement on-chain (AlreadySettled = 7)", async () => {
      const doubleSettle = await client.settle(
        adminSecret,
        adminPublic,
        leagueId,
        [{ winner: managerAPublic, amount: "10000000" }],
        adminPublic,
        1_000_000n
      );
      assert.strictEqual(doubleSettle.success, false, "Double settlement should fail");
      assert.strictEqual(doubleSettle.contractErrorCode, 7, "Expected EscrowError::AlreadySettled (#7)");
    });
  });

  describe("Step 4: League #2 Cancellation & Full Refund Flow", () => {
    const cancelLeagueId = Math.floor(Date.now() / 1000) % 1_000_000 + 2000;

    it("should create league and accept deposits for cancellation test", async () => {
      const createRes = await client.createLeague(
        adminSecret,
        adminPublic,
        cancelLeagueId,
        ENTRY_FEE_10_USDC
      );
      assert.strictEqual(createRes.success, true);

      // Manager A and Manager B deposit 10 USDC each
      const depA = await client.deposit(managerASecret, managerAPublic, cancelLeagueId);
      assert.strictEqual(depA.success, true);

      const depB = await client.deposit(managerBSecret, managerBPublic, cancelLeagueId);
      assert.strictEqual(depB.success, true);

      const state = await client.getLeague(cancelLeagueId);
      assert.strictEqual(state?.participant_count, 2);
      assert.strictEqual(state?.total_deposited, 200_000_000n);
    });

    it("should reject refund attempt by non-admin (NotAuthorized = 10)", async () => {
      const unauthRefund = await client.refund(
        managerASecret,
        managerAPublic, // Not admin!
        cancelLeagueId,
        [managerAPublic, managerBPublic]
      );
      assert.strictEqual(unauthRefund.success, false, "Unauthorized refund should fail");
      assert.strictEqual(unauthRefund.contractErrorCode, 10, "Expected EscrowError::NotAuthorized (#10)");
    });

    it("should execute full refund, returning exact USDC to managers and setting status to Cancelled (3)", async () => {
      const mgrABefore = await client.getTokenBalance(managerAPublic);
      const mgrBBefore = await client.getTokenBalance(managerBPublic);
      const escrowBefore = await client.getTokenBalance(client.getEscrowContractId());

      const refundRes = await client.refund(
        adminSecret,
        adminPublic,
        cancelLeagueId,
        [managerAPublic, managerBPublic]
      );
      assert.strictEqual(refundRes.success, true, `Refund failed: ${refundRes.error}`);
      assert.ok(refundRes.txHash, "Should produce transaction hash on Testnet");

      // Verify on-chain league status is Cancelled (3)
      const state = await client.getLeague(cancelLeagueId);
      assert.strictEqual(state?.status, 3, "League status should be Cancelled (3)");

      // Verify token balances restored
      const mgrAAfter = await client.getTokenBalance(managerAPublic);
      const mgrBAfter = await client.getTokenBalance(managerBPublic);
      const escrowAfter = await client.getTokenBalance(client.getEscrowContractId());

      assert.strictEqual(mgrAAfter - mgrABefore, 100_000_000n, "Manager A should be refunded 10 USDC");
      assert.strictEqual(mgrBAfter - mgrBBefore, 100_000_000n, "Manager B should be refunded 10 USDC");
      assert.strictEqual(escrowBefore - escrowAfter, 200_000_000n, "Escrow balance should decrease by 20 USDC");

      // Verify deposit storage removed
      const depA = await client.getDeposit(cancelLeagueId, managerAPublic);
      const depB = await client.getDeposit(cancelLeagueId, managerBPublic);
      assert.strictEqual(depA, 0n, "Manager A deposit record should be cleared");
      assert.strictEqual(depB, 0n, "Manager B deposit record should be cleared");
    });

    it("should prevent duplicate refund from double-paying participants", async () => {
      const mgrABefore = await client.getTokenBalance(managerAPublic);

      // Attempt refund again
      const secondRefund = await client.refund(
        adminSecret,
        adminPublic,
        cancelLeagueId,
        [managerAPublic, managerBPublic]
      );
      assert.strictEqual(secondRefund.success, true, "Refund executes idempotently");

      const mgrAAfter = await client.getTokenBalance(managerAPublic);
      assert.strictEqual(mgrAAfter, mgrABefore, "Manager A must not receive double refund");
    });
  });
});
