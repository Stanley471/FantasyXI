/**
 * Unit Tests for DepositVerificationService
 *
 * Verifies Stellar Horizon API integration with mocked responses:
 * - Accurate confirmation of valid transactions (Classic & Soroban)
 * - Rejection of fake, malformed, or non-existent transaction hashes
 * - Rejection of mismatched sender, recipient, amount, asset, memo, or league ID
 * - Rejection of failed on-chain transactions
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DepositVerificationService,
  DepositVerificationErrorCode,
} from "../services/financial/depositVerificationService.js";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Contract,
  Address,
  nativeToScVal,
  StrKey,
} from "@stellar/stellar-sdk";

describe("DepositVerificationService Unit Tests", () => {
  const SENDER = Keypair.random().publicKey();
  const ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TREASURY_PUBKEY = Keypair.random().publicKey();
  const VALID_HASH = "a".repeat(64);
  const SOROBAN_HASH = "b".repeat(64);
  const USDC_CODE = "USDC";
  const USDC_ISSUER = Keypair.random().publicKey();

  // Helper to build a signed mock transaction envelope XDR with a Soroban deposit
  function createMockSorobanEnvelopeXdr(params: {
    contractId?: string;
    functionName?: string;
    participant?: string;
    leagueId?: bigint | number;
  }): string {
    const {
      contractId = ESCROW_CONTRACT_ID,
      functionName = "deposit",
      participant = SENDER,
      leagueId = 12345n,
    } = params;

    const source = Keypair.random();
    const account = {
      accountId: () => source.publicKey(),
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    };

    const contract = new Contract(contractId);
    const op = contract.call(
      functionName,
      new Address(participant).toScVal(),
      nativeToScVal(BigInt(leagueId), { type: "u64" })
    );

    const tx = new TransactionBuilder(account as any, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    tx.sign(source);
    return tx.toXDR();
  }

  describe("Transaction Hash Validation", () => {
    const service = new DepositVerificationService();

    it("should accept valid 64-character hexadecimal hashes", () => {
      assert.strictEqual(service.isValidTransactionHash("a".repeat(64)), true);
      assert.strictEqual(service.isValidTransactionHash("0123456789abcdef".repeat(4)), true);
      assert.strictEqual(service.isValidTransactionHash("ABCDEF0123456789".repeat(4)), true);
    });

    it("should reject invalid, malformed, or fake hashes", () => {
      assert.strictEqual(service.isValidTransactionHash(""), false);
      assert.strictEqual(service.isValidTransactionHash("   "), false);
      assert.strictEqual(service.isValidTransactionHash("not-a-hash"), false);
      assert.strictEqual(service.isValidTransactionHash("a".repeat(63)), false); // 63 chars
      assert.strictEqual(service.isValidTransactionHash("a".repeat(65)), false); // 65 chars
      assert.strictEqual(service.isValidTransactionHash("z".repeat(64)), false); // non-hex
      assert.strictEqual(service.isValidTransactionHash(null as any), false);
    });

    it("should immediately return INVALID_HASH_FORMAT without calling Horizon for fake hashes", async () => {
      const result = await service.verifyDeposit({
        txHash: "fake_hash_123",
        expectedDestination: ESCROW_CONTRACT_ID,
        expectedAmount: 10,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.INVALID_HASH_FORMAT);
      }
    });
  });

  describe("Classic Stellar Payment Verification", () => {
    it("should accurately confirm a valid payment transaction", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              created_at: "2026-09-25T12:00:00Z",
              source_account: SENDER,
              memo: "LEAGUE-100",
            }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({
              records: [
                {
                  type: "payment",
                  to: TREASURY_PUBKEY,
                  from: SENDER,
                  amount: "10.0000000",
                  asset_code: USDC_CODE,
                  asset_issuer: USDC_ISSUER,
                  asset_type: "credit_alphanum4",
                },
              ],
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
        expectedSender: SENDER,
        expectedAssetCode: USDC_CODE,
        expectedAssetIssuer: USDC_ISSUER,
        expectedMemo: "LEAGUE-100",
      });

      assert.strictEqual(result.verified, true);
      if (result.verified) {
        assert.strictEqual(result.txHash, VALID_HASH);
        assert.strictEqual(result.ledgerSeq, 1000);
        assert.strictEqual(result.amount, 10);
        assert.strictEqual(result.assetCode, USDC_CODE);
        assert.strictEqual(result.sender, SENDER);
        assert.strictEqual(result.destination, TREASURY_PUBKEY);
        assert.strictEqual(result.type, "classic_payment");
      }
    });

    it("should reject a transaction that does not exist on Horizon (404 Not Found)", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => {
              const err: any = new Error("Transaction not found");
              err.response = { status: 404 };
              throw err;
            },
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.TRANSACTION_NOT_FOUND);
      }
    });

    it("should reject a transaction that failed on-chain", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: false,
              ledger_attr: 1001,
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.TRANSACTION_FAILED_ON_CHAIN);
      }
    });

    it("should reject a transaction with mismatched recipient/destination", async () => {
      const wrongDestination = Keypair.random().publicKey();
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              created_at: "2026-09-25T12:00:00Z",
              source_account: SENDER,
            }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({
              records: [
                {
                  type: "payment",
                  to: wrongDestination,
                  from: SENDER,
                  amount: "10.0000000",
                  asset_code: USDC_CODE,
                  asset_issuer: USDC_ISSUER,
                },
              ],
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
        expectedAssetCode: USDC_CODE,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.DESTINATION_MISMATCH);
      }
    });

    it("should reject a transaction with mismatched amount", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              created_at: "2026-09-25T12:00:00Z",
              source_account: SENDER,
            }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({
              records: [
                {
                  type: "payment",
                  to: TREASURY_PUBKEY,
                  from: SENDER,
                  amount: "5.0000000", // Paid 5 instead of 10
                  asset_code: USDC_CODE,
                  asset_issuer: USDC_ISSUER,
                },
              ],
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
        expectedAssetCode: USDC_CODE,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.AMOUNT_MISMATCH);
      }
    });

    it("should reject a transaction with mismatched sender", async () => {
      const otherSender = Keypair.random().publicKey();
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              created_at: "2026-09-25T12:00:00Z",
              source_account: otherSender,
            }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({
              records: [
                {
                  type: "payment",
                  to: TREASURY_PUBKEY,
                  from: otherSender,
                  amount: "10.0000000",
                  asset_code: USDC_CODE,
                  asset_issuer: USDC_ISSUER,
                },
              ],
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
        expectedSender: SENDER,
        expectedAssetCode: USDC_CODE,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.SENDER_MISMATCH);
      }
    });

    it("should reject a transaction with mismatched memo", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              memo: "WRONG_MEMO",
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
        expectedMemo: "EXPECTED_MEMO",
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.MEMO_MISMATCH);
      }
    });

    it("should reject a transaction with mismatched asset code or issuer", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              created_at: "2026-09-25T12:00:00Z",
              source_account: SENDER,
            }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({
              records: [
                {
                  type: "payment",
                  to: TREASURY_PUBKEY,
                  from: SENDER,
                  amount: "10.0000000",
                  asset_type: "native", // XLM instead of USDC
                },
              ],
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
        expectedAssetCode: USDC_CODE,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.ASSET_MISMATCH);
      }
    });
  });

  describe("Soroban Smart Contract Escrow Deposit Verification", () => {
    it("should accurately confirm a valid Soroban deposit invocation", async () => {
      const envelopeXdr = createMockSorobanEnvelopeXdr({
        contractId: ESCROW_CONTRACT_ID,
        functionName: "deposit",
        participant: SENDER,
        leagueId: 9999n,
      });

      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: SOROBAN_HASH,
              successful: true,
              ledger_attr: 2000,
              created_at: "2026-09-25T13:00:00Z",
              envelope_xdr: envelopeXdr,
              source_account: SENDER,
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: SOROBAN_HASH,
        expectedDestination: ESCROW_CONTRACT_ID,
        expectedAmount: 10,
        expectedSender: SENDER,
        expectedLeagueId: 9999,
      });

      assert.strictEqual(result.verified, true);
      if (result.verified) {
        assert.strictEqual(result.type, "soroban_escrow_deposit");
        assert.strictEqual(result.destination, ESCROW_CONTRACT_ID);
        assert.strictEqual(result.sender, SENDER);
        assert.strictEqual(result.leagueId, "9999");
      }
    });

    it("should reject a Soroban invocation targeting wrong contract", async () => {
      const rogueContract = StrKey.encodeContract(Buffer.alloc(32, 2));
      const envelopeXdr = createMockSorobanEnvelopeXdr({
        contractId: rogueContract,
      });

      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: SOROBAN_HASH,
              successful: true,
              ledger_attr: 2000,
              envelope_xdr: envelopeXdr,
              source_account: SENDER,
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: SOROBAN_HASH,
        expectedDestination: ESCROW_CONTRACT_ID,
        expectedAmount: 10,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.DESTINATION_MISMATCH);
      }
    });

    it("should reject a Soroban invocation with wrong function name", async () => {
      const envelopeXdr = createMockSorobanEnvelopeXdr({
        functionName: "settle",
      });

      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: SOROBAN_HASH,
              successful: true,
              ledger_attr: 2000,
              envelope_xdr: envelopeXdr,
              source_account: SENDER,
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: SOROBAN_HASH,
        expectedDestination: ESCROW_CONTRACT_ID,
        expectedAmount: 10,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.UNSUPPORTED_OPERATION);
      }
    });

    it("should reject a Soroban deposit with mismatched league ID", async () => {
      const envelopeXdr = createMockSorobanEnvelopeXdr({
        leagueId: 100n,
      });

      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: SOROBAN_HASH,
              successful: true,
              ledger_attr: 2000,
              envelope_xdr: envelopeXdr,
              source_account: SENDER,
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: SOROBAN_HASH,
        expectedDestination: ESCROW_CONTRACT_ID,
        expectedAmount: 10,
        expectedLeagueId: 200, // Expected 200, got 100
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.LEAGUE_MISMATCH);
      }
    });

    it("should reject a Soroban deposit with mismatched participant sender", async () => {
      const otherSender = Keypair.random().publicKey();
      const envelopeXdr = createMockSorobanEnvelopeXdr({
        participant: otherSender,
      });

      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: SOROBAN_HASH,
              successful: true,
              ledger_attr: 2000,
              envelope_xdr: envelopeXdr,
              source_account: otherSender,
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const result = await service.verifyDeposit({
        txHash: SOROBAN_HASH,
        expectedDestination: ESCROW_CONTRACT_ID,
        expectedAmount: 10,
        expectedSender: SENDER,
      });

      assert.strictEqual(result.verified, false);
      if (!result.verified) {
        assert.strictEqual(result.errorCode, DepositVerificationErrorCode.SENDER_MISMATCH);
      }
    });
  });

  describe("Batch Verification and Helpers", () => {
    it("should support batch verification of multiple deposits", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              created_at: "2026-09-25T12:00:00Z",
              source_account: SENDER,
            }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({
              records: [
                {
                  type: "payment",
                  to: TREASURY_PUBKEY,
                  from: SENDER,
                  amount: "10.0000000",
                  asset_code: USDC_CODE,
                  asset_issuer: USDC_ISSUER,
                },
              ],
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);
      const results = await service.batchVerify([
        {
          txHash: VALID_HASH,
          expectedDestination: TREASURY_PUBKEY,
          expectedAmount: 10,
          expectedAssetCode: USDC_CODE,
        },
        {
          txHash: "invalid_hash",
          expectedDestination: TREASURY_PUBKEY,
          expectedAmount: 10,
        },
      ]);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].verified, true);
      assert.strictEqual(results[1].verified, false);
    });

    it("confirmDepositOrThrow should throw on failure and return details on success", async () => {
      const mockServer: any = {
        transactions: () => ({
          transaction: () => ({
            call: async () => ({
              hash: VALID_HASH,
              successful: true,
              ledger_attr: 1000,
              created_at: "2026-09-25T12:00:00Z",
              source_account: SENDER,
            }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({
              records: [
                {
                  type: "payment",
                  to: TREASURY_PUBKEY,
                  from: SENDER,
                  amount: "10.0000000",
                  asset_code: USDC_CODE,
                  asset_issuer: USDC_ISSUER,
                },
              ],
            }),
          }),
        }),
      };

      const service = new DepositVerificationService(mockServer);

      const confirmed = await service.confirmDepositOrThrow({
        txHash: VALID_HASH,
        expectedDestination: TREASURY_PUBKEY,
        expectedAmount: 10,
        expectedAssetCode: USDC_CODE,
      });
      assert.strictEqual(confirmed.verified, true);

      await assert.rejects(
        async () => {
          await service.confirmDepositOrThrow({
            txHash: "fake_hash",
            expectedDestination: TREASURY_PUBKEY,
            expectedAmount: 10,
          });
        },
        /Deposit verification failed/
      );
    });
  });
});
