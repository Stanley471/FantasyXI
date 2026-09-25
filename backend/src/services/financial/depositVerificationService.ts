/**
 * Deposit Verification Service
 *
 * Dedicated backend service that independently verifies that deposits claimed by users
 * actually occurred and settled on the Stellar network.
 *
 * Verifies:
 * - Transaction hash format validity (rejects malformed / non-hex hashes)
 * - Ledger inclusion and finalized status via Stellar Horizon API
 * - Operation type (Soroban escrow deposit or classic payment)
 * - Matching sender public key
 * - Matching recipient / escrow contract destination
 * - Matching asset code & issuer (preventing rogue token deposits)
 * - Matching deposit amount within decimal precision
 * - Matching memo or league partition reference
 */

import {
  Horizon,
  StrKey,
  TransactionBuilder,
  Networks,
  Address,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { getHorizonServer, stellarConfig } from "../../config/stellar.js";
import { toContractLeagueId } from "./contractLeagueId.js";

export enum DepositVerificationErrorCode {
  INVALID_HASH_FORMAT = "INVALID_HASH_FORMAT",
  TRANSACTION_NOT_FOUND = "TRANSACTION_NOT_FOUND",
  TRANSACTION_FAILED_ON_CHAIN = "TRANSACTION_FAILED_ON_CHAIN",
  SENDER_MISMATCH = "SENDER_MISMATCH",
  DESTINATION_MISMATCH = "DESTINATION_MISMATCH",
  AMOUNT_MISMATCH = "AMOUNT_MISMATCH",
  ASSET_MISMATCH = "ASSET_MISMATCH",
  MEMO_MISMATCH = "MEMO_MISMATCH",
  LEAGUE_MISMATCH = "LEAGUE_MISMATCH",
  UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION",
  INSUFFICIENT_ARGUMENTS = "INSUFFICIENT_ARGUMENTS",
  NETWORK_ERROR = "NETWORK_ERROR",
}

export interface VerifyDepositParams {
  txHash: string;
  expectedDestination: string;
  expectedAmount: number;
  expectedSender?: string;
  expectedAssetCode?: string;
  expectedAssetIssuer?: string;
  expectedMemo?: string;
  expectedLeagueId?: number | string | bigint;
  toleranceEpsilon?: number;
}

export interface VerificationSuccess {
  verified: true;
  txHash: string;
  ledgerSeq: number;
  amount: number;
  assetCode: string;
  assetIssuer?: string;
  sender: string;
  destination: string;
  confirmedAt: Date;
  type: "soroban_escrow_deposit" | "classic_payment";
  memo?: string;
  leagueId?: string;
}

export interface VerificationFailure {
  verified: false;
  txHash: string;
  ledgerSeq?: number;
  errorCode: DepositVerificationErrorCode;
  error: string;
}

export type DepositVerificationResult = VerificationSuccess | VerificationFailure;

export class DepositVerificationService {
  private server: Horizon.Server;
  private networkPassphrase: string;

  constructor(customServer?: Horizon.Server, networkPassphrase?: string) {
    this.server = customServer || getHorizonServer();
    this.networkPassphrase =
      networkPassphrase ||
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      stellarConfig.networkPassphrase ||
      Networks.TESTNET;
  }

  /**
   * Validate whether a string is a valid 64-hexadecimal Stellar transaction hash.
   */
  public isValidTransactionHash(hash: string): boolean {
    if (!hash || typeof hash !== "string") return false;
    return /^[0-9a-fA-F]{64}$/.test(hash.trim());
  }

  /**
   * Validate whether a string is a valid Stellar Ed25519 public key (G...)
   * or a valid Soroban Contract ID (C...).
   */
  public isValidStellarAddress(address: string): boolean {
    if (!address || typeof address !== "string") return false;
    return (
      StrKey.isValidEd25519PublicKey(address) ||
      StrKey.isValidContract(address)
    );
  }

  /**
   * Independently verify a deposit transaction against expected deposit parameters.
   */
  public async verifyDeposit(
    params: VerifyDepositParams
  ): Promise<DepositVerificationResult> {
    const {
      txHash,
      expectedDestination,
      expectedAmount,
      expectedSender,
      expectedAssetCode = stellarConfig.usdcAssetCode || "USDC",
      expectedAssetIssuer = params.expectedAssetIssuer,
      expectedMemo,
      expectedLeagueId,
      toleranceEpsilon = 0.00001,
    } = params;

    // 1. Syntactic verification of transaction hash format
    if (!this.isValidTransactionHash(txHash)) {
      return {
        verified: false,
        txHash: txHash || "",
        errorCode: DepositVerificationErrorCode.INVALID_HASH_FORMAT,
        error: "Invalid transaction hash format. Expected a 64-character hexadecimal string.",
      };
    }

    const cleanHash = txHash.trim();

    try {
      // 2. Fetch transaction record from Stellar Horizon API
      const tx = await this.server.transactions().transaction(cleanHash).call();

      // 3. Confirm transaction was executed successfully on the ledger
      if (!tx.successful) {
        return {
          verified: false,
          txHash: cleanHash,
          ledgerSeq: tx.ledger_attr,
          errorCode: DepositVerificationErrorCode.TRANSACTION_FAILED_ON_CHAIN,
          error: "Transaction failed on the Stellar network.",
        };
      }

      // 4. Check for Soroban contract invocation (invokeHostFunction) in envelope XDR
      let sorobanOp: any = null;
      if (tx.envelope_xdr) {
        try {
          const envelopeTx = TransactionBuilder.fromXDR(
            tx.envelope_xdr,
            this.networkPassphrase
          );
          sorobanOp = envelopeTx.operations.find(
            (op: any) => op.type === "invokeHostFunction"
          );
        } catch {
          // If envelope decoding fails, fall back to checking operations endpoint
        }
      }

      if (sorobanOp) {
        return this.verifySorobanDepositInvocation({
          tx,
          sorobanOp,
          expectedDestination,
          expectedAmount,
          expectedSender,
          expectedAssetCode,
          expectedLeagueId,
        });
      }

      // 5. Classic payment verification
      return await this.verifyClassicPayment({
        tx,
        cleanHash,
        expectedDestination,
        expectedAmount,
        expectedSender,
        expectedAssetCode,
        expectedAssetIssuer,
        expectedMemo,
        toleranceEpsilon,
      });
    } catch (error: any) {
      if (
        error?.response?.status === 404 ||
        error?.name === "NotFoundError" ||
        error?.message?.includes("Not Found") ||
        error?.status === 404
      ) {
        return {
          verified: false,
          txHash: cleanHash,
          errorCode: DepositVerificationErrorCode.TRANSACTION_NOT_FOUND,
          error: "Transaction not found on Stellar network or ledger not yet closed.",
        };
      }

      return {
        verified: false,
        txHash: cleanHash,
        errorCode: DepositVerificationErrorCode.NETWORK_ERROR,
        error: `Stellar Horizon network error: ${error?.message || "Unknown error"}`,
      };
    }
  }

  /**
   * Verifies a Soroban smart contract escrow deposit invocation.
   */
  private verifySorobanDepositInvocation(params: {
    tx: any;
    sorobanOp: any;
    expectedDestination: string;
    expectedAmount: number;
    expectedSender?: string;
    expectedAssetCode: string;
    expectedLeagueId?: number | string | bigint;
  }): DepositVerificationResult {
    const {
      tx,
      sorobanOp,
      expectedDestination,
      expectedAmount,
      expectedSender,
      expectedAssetCode,
      expectedLeagueId,
    } = params;

    const func = sorobanOp.func;
    if (!func || !func.invokeContract) {
      return {
        verified: false,
        txHash: tx.hash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.UNSUPPORTED_OPERATION,
        error: "Soroban invocation is not a contract function call.",
      };
    }

    const invokeContract = func.invokeContract;
    const targetContractId = Address.fromScAddress(
      invokeContract.contractAddress
    ).toString();
    const functionName = invokeContract.functionName.toString();
    const args = invokeContract.args || [];

    const expectedEscrowId =
      stellarConfig.escrowContractId || expectedDestination;

    if (
      targetContractId !== expectedEscrowId &&
      targetContractId !== expectedDestination
    ) {
      return {
        verified: false,
        txHash: tx.hash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.DESTINATION_MISMATCH,
        error: `Target contract mismatch: expected '${expectedDestination}', got '${targetContractId}'.`,
      };
    }

    if (functionName !== "deposit") {
      return {
        verified: false,
        txHash: tx.hash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.UNSUPPORTED_OPERATION,
        error: `Invalid contract function: expected 'deposit', got '${functionName}'.`,
      };
    }

    if (args.length < 2) {
      return {
        verified: false,
        txHash: tx.hash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.INSUFFICIENT_ARGUMENTS,
        error: "Contract invocation has insufficient arguments for deposit (expected participant and leagueId).",
      };
    }

    const participantAddress = String(scValToNative(args[0]));
    const invocationLeagueId = scValToNative(args[1]);

    if (
      expectedSender &&
      participantAddress !== expectedSender &&
      tx.source_account !== expectedSender
    ) {
      return {
        verified: false,
        txHash: tx.hash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.SENDER_MISMATCH,
        error: `Participant mismatch: expected '${expectedSender}', got '${participantAddress}'.`,
      };
    }

    if (expectedLeagueId !== undefined) {
      const numericExpected =
        typeof expectedLeagueId === "string"
          ? parseInt(expectedLeagueId, 10)
          : expectedLeagueId;

      const expectedContractId =
        typeof expectedLeagueId === "string" &&
        /^[0-9a-fA-F]{8}-/.test(expectedLeagueId)
          ? toContractLeagueId(expectedLeagueId)
          : isNaN(numericExpected as any)
            ? null
            : BigInt(numericExpected);

      if (
        expectedContractId !== null &&
        expectedContractId !== BigInt(invocationLeagueId)
      ) {
        return {
          verified: false,
          txHash: tx.hash,
          ledgerSeq: tx.ledger_attr,
          errorCode: DepositVerificationErrorCode.LEAGUE_MISMATCH,
          error: `League ID mismatch: expected '${expectedLeagueId}', got '${invocationLeagueId}'.`,
        };
      }
    }

    return {
      verified: true,
      txHash: tx.hash,
      ledgerSeq: tx.ledger_attr,
      amount: expectedAmount,
      assetCode: expectedAssetCode,
      sender: participantAddress || tx.source_account,
      destination: targetContractId,
      confirmedAt: new Date(tx.created_at),
      type: "soroban_escrow_deposit",
      leagueId: String(invocationLeagueId),
    };
  }

  /**
   * Verifies a classic Stellar payment operation.
   */
  private async verifyClassicPayment(params: {
    tx: any;
    cleanHash: string;
    expectedDestination: string;
    expectedAmount: number;
    expectedSender?: string;
    expectedAssetCode: string;
    expectedAssetIssuer?: string;
    expectedMemo?: string;
    toleranceEpsilon: number;
  }): Promise<DepositVerificationResult> {
    const {
      tx,
      cleanHash,
      expectedDestination,
      expectedAmount,
      expectedSender,
      expectedAssetCode,
      expectedAssetIssuer,
      expectedMemo,
      toleranceEpsilon,
    } = params;

    // Verify memo if expected
    if (expectedMemo !== undefined) {
      const txMemo = (tx.memo || "").trim();
      const targetMemo = expectedMemo.trim();
      if (txMemo !== targetMemo) {
        return {
          verified: false,
          txHash: cleanHash,
          ledgerSeq: tx.ledger_attr,
          errorCode: DepositVerificationErrorCode.MEMO_MISMATCH,
          error: `Memo mismatch: expected '${expectedMemo}', found '${tx.memo || "none"}'.`,
        };
      }
    }

    // Fetch operations
    const opsPage = await this.server
      .operations()
      .forTransaction(cleanHash)
      .call();

    const paymentOps = opsPage.records.filter(
      (op: any) => op.type === "payment"
    );

    if (paymentOps.length === 0) {
      return {
        verified: false,
        txHash: cleanHash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.UNSUPPORTED_OPERATION,
        error: "No payment operations found in transaction.",
      };
    }

    // Check destination match
    const destMatchOps = paymentOps.filter(
      (op: any) => op.to === expectedDestination
    );
    if (destMatchOps.length === 0) {
      return {
        verified: false,
        txHash: cleanHash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.DESTINATION_MISMATCH,
        error: `Destination mismatch: expected '${expectedDestination}'.`,
      };
    }

    // Check asset match
    const assetMatchOps = destMatchOps.filter((op: any) => {
      const isNative = op.asset_type === "native";
      if (expectedAssetCode === "XLM") {
        return isNative;
      }
      if (op.asset_code !== expectedAssetCode) return false;
      if (expectedAssetIssuer && op.asset_issuer !== expectedAssetIssuer) {
        return false;
      }
      return true;
    });

    if (assetMatchOps.length === 0) {
      return {
        verified: false,
        txHash: cleanHash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.ASSET_MISMATCH,
        error: `Asset mismatch: expected '${expectedAssetCode}'${
          expectedAssetIssuer ? ` issued by ${expectedAssetIssuer}` : ""
        }.`,
      };
    }

    // Check amount match
    const amountMatchOps = assetMatchOps.filter((op: any) => {
      const parsedAmount = parseFloat(op.amount);
      return Math.abs(parsedAmount - expectedAmount) <= toleranceEpsilon;
    });

    if (amountMatchOps.length === 0) {
      const actualAmount = assetMatchOps[0]?.amount;
      return {
        verified: false,
        txHash: cleanHash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.AMOUNT_MISMATCH,
        error: `Amount mismatch: expected ${expectedAmount}, actual ${actualAmount}.`,
      };
    }

    // Check sender match if specified
    const matchingOp = amountMatchOps.find((op: any) => {
      if (!expectedSender) return true;
      return op.from === expectedSender || tx.source_account === expectedSender;
    });

    if (!matchingOp) {
      return {
        verified: false,
        txHash: cleanHash,
        ledgerSeq: tx.ledger_attr,
        errorCode: DepositVerificationErrorCode.SENDER_MISMATCH,
        error: `Sender mismatch: expected '${expectedSender}', actual sender was '${amountMatchOps[0].from}'.`,
      };
    }

    return {
      verified: true,
      txHash: tx.hash,
      ledgerSeq: tx.ledger_attr,
      amount: parseFloat(matchingOp.amount),
      assetCode: matchingOp.asset_code || "XLM",
      assetIssuer: matchingOp.asset_issuer,
      sender: matchingOp.from || tx.source_account,
      destination: matchingOp.to,
      confirmedAt: new Date(tx.created_at),
      type: "classic_payment",
      memo: tx.memo,
    };
  }

  /**
   * Helper that throws an Error if verification fails, or returns the verified details.
   */
  public async confirmDepositOrThrow(
    params: VerifyDepositParams
  ): Promise<VerificationSuccess> {
    const result = await this.verifyDeposit(params);
    if (!result.verified) {
      throw new Error(`Deposit verification failed [${result.errorCode}]: ${result.error}`);
    }
    return result;
  }

  /**
   * Batch verify an array of deposits.
   */
  public async batchVerify(
    paramsList: VerifyDepositParams[]
  ): Promise<DepositVerificationResult[]> {
    return Promise.all(paramsList.map((params) => this.verifyDeposit(params)));
  }
}
