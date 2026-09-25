/**
 * End-to-End Integration Tests for Payment Settlement
 *
 * Simulates the complete Stellar / Soroban payment lifecycle:
 * 1. League Escrow Partition Initialization
 * 2. Multi-Manager Participant Deposits with Balance Tracking
 * 3. 5% Platform Treasury Fee + 95% Winner Prize Settlement (60/30/10 Tiering)
 * 4. Error States & Reverts:
 *    - Rejection of duplicate deposits (AlreadyDeposited)
 *    - Rejection of deposits into non-upcoming leagues (LeagueNotAcceptingDeposits)
 *    - Rejection of payouts exceeding total escrow deposits (PayoutExceedsDeposits)
 *    - Rejection of platform fees exceeding 5% cap (FeeExceedsMaxCap)
 *    - Rejection of unauthorized non-admin settlement (NotAuthorized)
 *    - Rejection of double-settlement on settled leagues (AlreadySettled)
 *    - Competition cancellation and 100% full deposit refunds
 *    - Prevention of duplicate refunds
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EscrowContractErrorCode,
  parseSorobanError,
} from "../services/financial/sorobanErrorRecovery.js";
import { PrizeService } from "../services/league/prizeService.js";

// Mock In-Memory State representing the on-chain Soroban Escrow Contract
interface MockLeaguePartition {
  creator: string;
  entryFee: bigint;
  status: number; // 0 = Upcoming, 1 = Active, 2 = Settled, 3 = Cancelled
  totalDeposited: bigint;
  participantCount: number;
  participants: Set<string>;
  deposits: Map<string, bigint>;
  payouts: Map<string, bigint>;
}

class MockSorobanEscrowContract {
  public admin: string;
  public tokenAddress: string;
  public leagues = new Map<bigint, MockLeaguePartition>();
  public balances = new Map<string, bigint>();
  public maxFeeBps = 500n; // 5%

  constructor(admin: string, tokenAddress: string) {
    this.admin = admin;
    this.tokenAddress = tokenAddress;
  }

  public setTokenBalance(address: string, amount: bigint) {
    this.balances.set(address, amount);
  }

  public getTokenBalance(address: string): bigint {
    return this.balances.get(address) || 0n;
  }

  public createLeague(caller: string, leagueId: bigint, entryFee: bigint): void {
    if (this.leagues.has(leagueId)) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.LeagueAlreadyExists})`);
    }
    if (entryFee <= 0n) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.InvalidAmount})`);
    }

    this.leagues.set(leagueId, {
      creator: caller,
      entryFee,
      status: 0, // Upcoming
      totalDeposited: 0n,
      participantCount: 0,
      participants: new Set(),
      deposits: new Map(),
      payouts: new Map(),
    });
  }

  public deposit(participant: string, leagueId: bigint): void {
    const league = this.leagues.get(leagueId);
    if (!league) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.LeagueNotFound})`);
    }
    if (league.status !== 0) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.LeagueNotAcceptingDeposits})`);
    }
    if (league.participants.has(participant)) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.AlreadyDeposited})`);
    }

    const currentBal = this.getTokenBalance(participant);
    if (currentBal < league.entryFee) {
      throw new Error("HostError: op_underfunded: insufficient token balance");
    }

    // Transfer token into escrow
    this.setTokenBalance(participant, currentBal - league.entryFee);
    const escrowBal = this.getTokenBalance(this.admin);
    this.setTokenBalance(this.admin, escrowBal + league.entryFee);

    league.participants.add(participant);
    league.deposits.set(participant, league.entryFee);
    league.totalDeposited += league.entryFee;
    league.participantCount += 1;
  }

  public lockLeague(leagueId: bigint): void {
    const league = this.leagues.get(leagueId);
    if (!league) throw new Error("League not found");
    league.status = 1; // Active / Locked
  }

  public settle(
    caller: string,
    leagueId: bigint,
    winners: Array<{ winner: string; amount: bigint }>,
    platformTreasury: string,
    platformFee: bigint,
    proofHash?: string
  ): void {
    if (caller !== this.admin) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.NotAuthorized})`);
    }
    const league = this.leagues.get(leagueId);
    if (!league) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.LeagueNotFound})`);
    }
    if (league.status === 2) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.AlreadySettled})`);
    }

    // Validate platform fee cap (5% max)
    const maxAllowedFee = (league.totalDeposited * this.maxFeeBps) / 10000n;
    if (platformFee > maxAllowedFee) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.FeeExceedsMaxCap})`);
    }

    const totalWinnerPayouts = winners.reduce((sum, w) => sum + w.amount, 0n);
    if (totalWinnerPayouts + platformFee > league.totalDeposited) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.PayoutExceedsDeposits})`);
    }

    if (proofHash && !/^[0-9a-fA-F]{64}$/.test(proofHash)) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.InvalidProof})`);
    }

    // Disburse treasury fee
    const treasuryBal = this.getTokenBalance(platformTreasury);
    this.setTokenBalance(platformTreasury, treasuryBal + platformFee);

    // Disburse winner payouts
    for (const w of winners) {
      const prev = this.getTokenBalance(w.winner);
      this.setTokenBalance(w.winner, prev + w.amount);
      league.payouts.set(w.winner, w.amount);
    }

    league.status = 2; // Settled
  }

  public refund(caller: string, leagueId: bigint, participants: string[]): void {
    if (caller !== this.admin) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.NotAuthorized})`);
    }
    const league = this.leagues.get(leagueId);
    if (!league) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.LeagueNotFound})`);
    }
    if (league.status === 2) {
      throw new Error(`HostError: Error(Contract, #${EscrowContractErrorCode.AlreadySettled})`);
    }

    for (const p of participants) {
      const deposit = league.deposits.get(p);
      if (!deposit || deposit === 0n) {
        continue;
      }
      const prevBal = this.getTokenBalance(p);
      this.setTokenBalance(p, prevBal + deposit);
      league.deposits.set(p, 0n);
    }

    league.status = 3; // Cancelled
  }
}

describe("E2E Payment Settlement Integration Suite", () => {
  const adminKey = Keypair.random();
  const treasuryKey = Keypair.random();
  const managerA = Keypair.random();
  const managerB = Keypair.random();
  const managerC = Keypair.random();
  const unauthorizedKey = Keypair.random();

  const ENTRY_FEE_10_USDC = 100_000_000n; // 10 USDC (7 decimals)
  let contract: MockSorobanEscrowContract;

  beforeEach(() => {
    contract = new MockSorobanEscrowContract(adminKey.publicKey(), "USDC_CONTRACT_ID");
    // Fund managers with 50 USDC each
    contract.setTokenBalance(managerA.publicKey(), 500_000_000n);
    contract.setTokenBalance(managerB.publicKey(), 500_000_000n);
    contract.setTokenBalance(managerC.publicKey(), 500_000_000n);
  });

  describe("Full Successful Settlement Lifecycle", () => {
    it("should simulate entire lifecycle: creation -> deposits -> 95/5 settlement -> payout confirmation", () => {
      const leagueId = 101n;

      // 1. Admin creates league partition
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      const initialLeague = contract.leagues.get(leagueId)!;
      assert.strictEqual(initialLeague.status, 0); // Upcoming
      assert.strictEqual(initialLeague.totalDeposited, 0n);

      // 2. Three managers deposit entry fees
      contract.deposit(managerA.publicKey(), leagueId);
      contract.deposit(managerB.publicKey(), leagueId);
      contract.deposit(managerC.publicKey(), leagueId);

      // Verify escrow partition after deposits
      const activeLeague = contract.leagues.get(leagueId)!;
      assert.strictEqual(activeLeague.participantCount, 3);
      assert.strictEqual(activeLeague.totalDeposited, 300_000_000n); // 30 USDC

      // Balances deducted from managers
      assert.strictEqual(contract.getTokenBalance(managerA.publicKey()), 400_000_000n);
      assert.strictEqual(contract.getTokenBalance(managerB.publicKey()), 400_000_000n);
      assert.strictEqual(contract.getTokenBalance(managerC.publicKey()), 400_000_000n);

      // 3. Compute 95/5 prize distribution
      const totalPoolStroops = activeLeague.totalDeposited;
      const platformFee = (totalPoolStroops * 500n) / 10000n; // 5% = 15_000_000 stroops (1.5 USDC)
      const netPrizePool = totalPoolStroops - platformFee; // 95% = 285_000_000 stroops (28.5 USDC)

      // 60/30/10 prize tiering
      const firstPlace = (netPrizePool * 60n) / 100n; // 171_000_000 (17.1 USDC)
      const secondPlace = (netPrizePool * 30n) / 100n; // 85_500_000 (8.55 USDC)
      const thirdPlace = netPrizePool - firstPlace - secondPlace; // 28_500_000 (2.85 USDC)

      const winners = [
        { winner: managerA.publicKey(), amount: firstPlace },
        { winner: managerB.publicKey(), amount: secondPlace },
        { winner: managerC.publicKey(), amount: thirdPlace },
      ];

      // 4. Admin settles competition on-chain
      contract.settle(
        adminKey.publicKey(),
        leagueId,
        winners,
        treasuryKey.publicKey(),
        platformFee,
        "a".repeat(64)
      );

      // 5. Assert final state and token distributions
      const settledLeague = contract.leagues.get(leagueId)!;
      assert.strictEqual(settledLeague.status, 2); // Settled

      // Treasury received 5% platform fee
      assert.strictEqual(contract.getTokenBalance(treasuryKey.publicKey()), 15_000_000n);

      // Winners received exact prizes:
      // Manager A (1st): 400M + 171M = 571M
      assert.strictEqual(contract.getTokenBalance(managerA.publicKey()), 571_000_000n);
      // Manager B (2nd): 400M + 85.5M = 485.5M
      assert.strictEqual(contract.getTokenBalance(managerB.publicKey()), 485_500_000n);
      // Manager C (3rd): 400M + 28.5M = 428.5M
      assert.strictEqual(contract.getTokenBalance(managerC.publicKey()), 428_500_000n);

      // Verify zero leak: Total tokens across all parties equals initial sum
      const finalSum =
        contract.getTokenBalance(treasuryKey.publicKey()) +
        contract.getTokenBalance(managerA.publicKey()) +
        contract.getTokenBalance(managerB.publicKey()) +
        contract.getTokenBalance(managerC.publicKey());
      assert.strictEqual(finalSum, 1_500_000_000n); // 150 USDC preserved exactly
    });
  });

  describe("Error States and Reverts Handling", () => {
    it("should revert duplicate deposit attempts from the same participant (AlreadyDeposited)", () => {
      const leagueId = 201n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.deposit(managerA.publicKey(), leagueId);

      assert.throws(
        () => contract.deposit(managerA.publicKey(), leagueId),
        (err: Error) => {
          const parsed = parseSorobanError(err);
          return (
            parsed.isContractError &&
            parsed.errorCode === EscrowContractErrorCode.AlreadyDeposited
          );
        }
      );
    });

    it("should revert deposits into non-upcoming or locked leagues (LeagueNotAcceptingDeposits)", () => {
      const leagueId = 202n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.lockLeague(leagueId); // Gameweek started

      assert.throws(
        () => contract.deposit(managerA.publicKey(), leagueId),
        (err: Error) => {
          const parsed = parseSorobanError(err);
          return (
            parsed.isContractError &&
            parsed.errorCode === EscrowContractErrorCode.LeagueNotAcceptingDeposits
          );
        }
      );
    });

    it("should revert settlement when payouts exceed total escrow deposits (PayoutExceedsDeposits)", () => {
      const leagueId = 203n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.deposit(managerA.publicKey(), leagueId); // 10 USDC deposited

      const excessiveWinners = [
        { winner: managerA.publicKey(), amount: 500_000_000n }, // 50 USDC > 10 USDC deposited
      ];

      assert.throws(
        () =>
          contract.settle(
            adminKey.publicKey(),
            leagueId,
            excessiveWinners,
            treasuryKey.publicKey(),
            5_000_000n
          ),
        (err: Error) => {
          const parsed = parseSorobanError(err);
          return (
            parsed.isContractError &&
            parsed.errorCode === EscrowContractErrorCode.PayoutExceedsDeposits
          );
        }
      );
    });

    it("should revert settlement when platform fee exceeds 5% cap (FeeExceedsMaxCap)", () => {
      const leagueId = 204n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.deposit(managerA.publicKey(), leagueId); // 100_000_000 stroops

      const excessiveFee = 10_000_000n; // 10% fee (> 5% max cap)
      const winners = [{ winner: managerA.publicKey(), amount: 90_000_000n }];

      assert.throws(
        () =>
          contract.settle(
            adminKey.publicKey(),
            leagueId,
            winners,
            treasuryKey.publicKey(),
            excessiveFee
          ),
        (err: Error) => {
          const parsed = parseSorobanError(err);
          return (
            parsed.isContractError &&
            parsed.errorCode === EscrowContractErrorCode.FeeExceedsMaxCap
          );
        }
      );
    });

    it("should revert settlement when caller is not contract admin (NotAuthorized)", () => {
      const leagueId = 205n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.deposit(managerA.publicKey(), leagueId);

      const winners = [{ winner: managerA.publicKey(), amount: 95_000_000n }];

      assert.throws(
        () =>
          contract.settle(
            unauthorizedKey.publicKey(), // Non-admin caller
            leagueId,
            winners,
            treasuryKey.publicKey(),
            5_000_000n
          ),
        (err: Error) => {
          const parsed = parseSorobanError(err);
          return (
            parsed.isContractError &&
            parsed.errorCode === EscrowContractErrorCode.NotAuthorized
          );
        }
      );
    });

    it("should revert double-settlement on an already settled league (AlreadySettled)", () => {
      const leagueId = 206n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.deposit(managerA.publicKey(), leagueId);

      const winners = [{ winner: managerA.publicKey(), amount: 95_000_000n }];

      // First settlement succeeds
      contract.settle(adminKey.publicKey(), leagueId, winners, treasuryKey.publicKey(), 5_000_000n);

      // Second settlement must revert
      assert.throws(
        () =>
          contract.settle(
            adminKey.publicKey(),
            leagueId,
            winners,
            treasuryKey.publicKey(),
            5_000_000n
          ),
        (err: Error) => {
          const parsed = parseSorobanError(err);
          return (
            parsed.isContractError &&
            parsed.errorCode === EscrowContractErrorCode.AlreadySettled
          );
        }
      );
    });

    it("should handle cancellation and 100% full deposit refunds", () => {
      const leagueId = 207n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.deposit(managerA.publicKey(), leagueId);
      contract.deposit(managerB.publicKey(), leagueId);

      assert.strictEqual(contract.getTokenBalance(managerA.publicKey()), 400_000_000n);
      assert.strictEqual(contract.getTokenBalance(managerB.publicKey()), 400_000_000n);

      // Quorum not met -> Admin refunds all participants
      contract.refund(adminKey.publicKey(), leagueId, [
        managerA.publicKey(),
        managerB.publicKey(),
      ]);

      // Managers restored to 500M each
      assert.strictEqual(contract.getTokenBalance(managerA.publicKey()), 500_000_000n);
      assert.strictEqual(contract.getTokenBalance(managerB.publicKey()), 500_000_000n);
      assert.strictEqual(contract.leagues.get(leagueId)!.status, 3); // Cancelled

      // Second refund attempt returns no funds (deposits already zeroed)
      contract.refund(adminKey.publicKey(), leagueId, [managerA.publicKey()]);
      assert.strictEqual(contract.getTokenBalance(managerA.publicKey()), 500_000_000n);
    });

    it("should revert settlement when proof hash is malformed (InvalidProof)", () => {
      const leagueId = 208n;
      contract.createLeague(adminKey.publicKey(), leagueId, ENTRY_FEE_10_USDC);
      contract.deposit(managerA.publicKey(), leagueId);

      const winners = [{ winner: managerA.publicKey(), amount: 95_000_000n }];

      assert.throws(
        () =>
          contract.settle(
            adminKey.publicKey(),
            leagueId,
            winners,
            treasuryKey.publicKey(),
            5_000_000n,
            "not-a-32-byte-hex"
          ),
        (err: Error) => {
          const parsed = parseSorobanError(err);
          return (
            parsed.isContractError &&
            parsed.errorCode === EscrowContractErrorCode.InvalidProof
          );
        }
      );
    });
  });
});
