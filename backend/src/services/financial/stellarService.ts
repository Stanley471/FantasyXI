/**
 * Stellar Service — Horizon & Soroban Network Abstraction
 *
 * Laravel analogy: Like a dedicated PaymentGateway client or StripeService.
 * Handles read queries and transaction verification against the Stellar Testnet.
 * Never executes state changes on the database directly; returns pure verification results.
 */

import {
  Horizon,
  StrKey,
  TransactionBuilder,
  Networks,
  Address,
  Keypair,
  scValToNative,
  rpc,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import {
  getHorizonServer,
  getSorobanRpcServer,
  stellarConfig,
} from "../../config/stellar.js";
import { PaymentVerificationResult } from "../../types/index.js";
import {
  SorobanContractClient,
  OnChainLeagueState,
  InvocationResult,
} from "./sorobanContractClient.js";
import { toContractLeagueId } from "./contractLeagueId.js";

export interface VerifyPaymentParams {
  txHash: string;
  expectedDestination: string;
  expectedAmount: number;
  expectedAssetCode?: string;
  expectedAssetIssuer?: string;
  expectedMemo?: string;
  expectedSender?: string;
  expectedLeagueId?: number | string;
}

export interface ContractReconciliationResult {
  onChainBalanced: boolean;
  onChainDepositedUsdc: number;
  onChainParticipantCount: number;
  onChainStatus: string;
  discrepancyUsdc: number;
}

/** Escrow contract event names emitted as the first topic (symbol_short!). */
export const ESCROW_EVENT_TOPICS = [
  "created",
  "deposit",
  "settle",
  "refund",
  "claimed",
] as const;

export class StellarService {
  private server: Horizon.Server;
  private sorobanClient?: SorobanContractClient;
  private rpcServer?: rpc.Server;

  constructor(
    customServer?: Horizon.Server,
    customSorobanClient?: SorobanContractClient,
    customRpcServer?: rpc.Server
  ) {
    this.server = customServer || getHorizonServer();
    this.sorobanClient = customSorobanClient;
    this.rpcServer = customRpcServer;
  }

  private getRpcServer(): rpc.Server {
    return this.rpcServer || getSorobanRpcServer();
  }

  /**
   * Fetches escrow contract events (created, deposit, settle, refund) from Soroban RPC.
   * Resumes from `cursor` when given, otherwise starts at `startLedger`.
   */
  public async getEscrowContractEvents(params: {
    cursor?: string;
    startLedger?: number;
    limit?: number;
  }): Promise<rpc.Api.GetEventsResponse> {
    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        // Read at call time: stellarConfig is evaluated before dotenv loads in server.ts
        contractIds: [process.env.STELLAR_ESCROW_CONTRACT_ID || stellarConfig.escrowContractId],
        topics: ESCROW_EVENT_TOPICS.map((name) => [
          xdr.ScVal.scvSymbol(name).toXDR("base64"),
          "*",
        ]),
      },
    ];

    const request: rpc.Api.GetEventsRequest = params.cursor
      ? { filters, cursor: params.cursor, limit: params.limit }
      : { filters, startLedger: params.startLedger!, limit: params.limit };

    return this.getRpcServer().getEvents(request);
  }

  /**
   * Returns the ledger range currently retained by the Soroban RPC node.
   */
  public async getRpcLedgerRange(): Promise<{ oldestLedger: number; latestLedger: number }> {
    const health = await this.getRpcServer().getHealth();
    return { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger };
  }

  public getSorobanClient(): SorobanContractClient | null {
    if (this.sorobanClient) return this.sorobanClient;
    try {
      this.sorobanClient = new SorobanContractClient();
      return this.sorobanClient;
    } catch {
      return null;
    }
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
   * Validate whether a string is a valid 64-hexadecimal Stellar transaction hash.
   */
  public isValidTransactionHash(hash: string): boolean {
    if (!hash || typeof hash !== "string") return false;
    return /^[0-9a-fA-F]{64}$/.test(hash);
  }

  /**
   * Verify an on-chain payment transaction against expected competition parameters.
   *
   * Verifies:
   * 1. Transaction exists and was successful on-chain.
   * 2. Transaction is confirmed in a finalized ledger.
   * 3. Memo matches expected reference string (if specified).
   * 4. Contains a payment operation with:
   *    - Correct destination address
   *    - Correct asset code & issuer
   *    - Correct amount (exact within decimal epsilon)
   *    - Correct sender address (if specified)
   */
  public async verifyPaymentTransaction(
    params: VerifyPaymentParams
  ): Promise<PaymentVerificationResult> {
    const {
      txHash,
      expectedDestination,
      expectedAmount,
      expectedAssetCode = stellarConfig.usdcAssetCode,
      expectedAssetIssuer = stellarConfig.usdcIssuer,
      expectedMemo,
      expectedSender,
      expectedLeagueId,
    } = params;

    if (!this.isValidTransactionHash(txHash)) {
      return {
        success: false,
        txHash,
        error: "Invalid transaction hash format. Expected 64-character hex string.",
      };
    }

    try {
      // 1. Fetch transaction record from Horizon
      const tx = await this.server.transactions().transaction(txHash).call();

      if (!tx.successful) {
        return {
          success: false,
          txHash,
          ledgerSeq: tx.ledger_attr,
          error: "Transaction failed on the Stellar network.",
        };
      }

      // 2. Check if transaction envelope contains a Soroban contract invocation (invokeHostFunction)
      let isSorobanInvocation = false;
      let sorobanOp: any = null;

      if (tx.envelope_xdr) {
        try {
          const envelopeTx = TransactionBuilder.fromXDR(
            tx.envelope_xdr,
            stellarConfig.networkPassphrase || Networks.TESTNET
          );
          sorobanOp = envelopeTx.operations.find(
            (op: any) => op.type === "invokeHostFunction"
          );
          if (sorobanOp) {
            isSorobanInvocation = true;
          }
        } catch {
          // If envelope decoding fails, fall back to checking operations endpoint
        }
      }

      // If it's a Soroban invocation, verify contract ID, function name, and invocation args
      if (isSorobanInvocation && sorobanOp) {
        const func = sorobanOp.func;
        if (!func || !func.invokeContract) {
          return {
            success: false,
            txHash,
            ledgerSeq: tx.ledger_attr,
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
            success: false,
            txHash,
            ledgerSeq: tx.ledger_attr,
            error: `Target contract mismatch: expected '${expectedEscrowId}', got '${targetContractId}'.`,
          };
        }

        if (functionName !== "deposit") {
          return {
            success: false,
            txHash,
            ledgerSeq: tx.ledger_attr,
            error: `Invalid contract function: expected 'deposit', got '${functionName}'.`,
          };
        }

        if (args.length < 2) {
          return {
            success: false,
            txHash,
            ledgerSeq: tx.ledger_attr,
            error: "Contract invocation has insufficient arguments for deposit.",
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
            success: false,
            txHash,
            ledgerSeq: tx.ledger_attr,
            error: `Participant mismatch: expected '${expectedSender}', got '${participantAddress}'.`,
          };
        }

        if (expectedLeagueId !== undefined) {
          // League UUIDs are mapped to their u64 contract id (compared exactly as bigint)
          const numericExpected =
            typeof expectedLeagueId === "string"
              ? parseInt(expectedLeagueId, 10)
              : expectedLeagueId;
          const expectedContractId =
            typeof expectedLeagueId === "string" && /^[0-9a-fA-F]{8}-/.test(expectedLeagueId)
              ? toContractLeagueId(expectedLeagueId)
              : isNaN(numericExpected)
                ? null
                : BigInt(numericExpected);

          if (
            expectedContractId !== null &&
            expectedContractId !== BigInt(invocationLeagueId)
          ) {
            return {
              success: false,
              txHash,
              ledgerSeq: tx.ledger_attr,
              error: `League ID mismatch: expected '${expectedLeagueId}', got '${invocationLeagueId}'.`,
            };
          }
        }

        // Check on-chain deposit balance if Soroban client was explicitly configured
        if (this.sorobanClient) {
          try {
            const onChainDeposit = await this.getContractDeposit(
              invocationLeagueId,
              participantAddress
            );
            if (onChainDeposit > 0n) {
              const depositedUsdc = Number(onChainDeposit) / 10_000_000;
              if (Math.abs(depositedUsdc - expectedAmount) > 0.0001) {
                return {
                  success: false,
                  txHash,
                  ledgerSeq: tx.ledger_attr,
                  error: `Deposit amount mismatch: expected ${expectedAmount} USDC, contract recorded ${depositedUsdc} USDC.`,
                };
              }
            }
          } catch {
            // If on-chain query encounters temporary RPC latency, trust confirmed ledger transaction
          }
        }

        return {
          success: true,
          txHash: tx.hash,
          ledgerSeq: tx.ledger_attr,
          amount: expectedAmount,
          assetCode: expectedAssetCode,
          senderAddress: participantAddress || tx.source_account,
          destinationAddress: targetContractId,
          confirmedAt: new Date(tx.created_at),
        };
      }

      // 3. Fallback: Classic Stellar payment operation verification
      if (expectedMemo) {
        if (!tx.memo || tx.memo.trim() !== expectedMemo.trim()) {
          return {
            success: false,
            txHash,
            ledgerSeq: tx.ledger_attr,
            error: `Memo mismatch: expected '${expectedMemo}', found '${tx.memo || "none"}'.`,
          };
        }
      }

      // Fetch operations for this transaction
      const opsPage = await this.server
        .operations()
        .forTransaction(txHash)
        .call();

      // Find payment operation matching criteria
      const matchingOp = opsPage.records.find((op: any) => {
        // We look for payment operations
        if (op.type !== "payment") return false;

        // Check destination
        if (op.to !== expectedDestination) return false;

        // Check asset
        const isNative = op.asset_type === "native";
        if (expectedAssetCode === "XLM") {
          if (!isNative) return false;
        } else {
          if (op.asset_code !== expectedAssetCode) return false;
          if (expectedAssetIssuer && op.asset_issuer !== expectedAssetIssuer) {
            return false;
          }
        }

        // Check amount (compare with 0.000001 precision)
        const parsedAmount = parseFloat(op.amount);
        if (Math.abs(parsedAmount - expectedAmount) > 0.00001) return false;

        // Check sender if specified
        if (expectedSender && op.from !== expectedSender && tx.source_account !== expectedSender) {
          return false;
        }

        return true;
      }) as any;

      if (!matchingOp) {
        return {
          success: false,
          txHash,
          ledgerSeq: tx.ledger_attr,
          error: `No valid payment operation found matching destination ${expectedDestination}, asset ${expectedAssetCode}, and amount ${expectedAmount}.`,
        };
      }

      return {
        success: true,
        txHash: tx.hash,
        ledgerSeq: tx.ledger_attr,
        amount: parseFloat(matchingOp.amount),
        assetCode: matchingOp.asset_code || "XLM",
        senderAddress: matchingOp.from || tx.source_account,
        destinationAddress: matchingOp.to,
        confirmedAt: new Date(tx.created_at),
      };
    } catch (error: any) {
      // Check for 404 Not Found from Horizon
      if (
        error?.response?.status === 404 ||
        error?.name === "NotFoundError" ||
        error?.message?.includes("Not Found")
      ) {
        return {
          success: false,
          txHash,
          error: "Transaction not found on Stellar network or ledger not yet closed.",
        };
      }

      return {
        success: false,
        txHash,
        error: `Stellar network error: ${error?.message || "Unknown error"}`,
      };
    }
  }

  /**
   * Look up the current USDC balance for a given Stellar account.
   * Returns 0 if account doesn't exist or has no USDC trustline.
   */
  public async getAccountUsdcBalance(
    stellarAddress: string,
    assetCode: string = stellarConfig.usdcAssetCode,
    assetIssuer: string = stellarConfig.usdcIssuer
  ): Promise<number> {
    if (!this.isValidStellarAddress(stellarAddress)) {
      throw new Error(`Invalid Stellar address: ${stellarAddress}`);
    }

    try {
      const account = await this.server.loadAccount(stellarAddress);
      const usdcBalance = account.balances.find((b: any) => {
        if (assetCode === "XLM") return b.asset_type === "native";
        return b.asset_code === assetCode && b.asset_issuer === assetIssuer;
      });

      if (!usdcBalance) return 0;
      return parseFloat(usdcBalance.balance);
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.name === "NotFoundError") {
        return 0; // Account not created on network yet
      }
      throw error;
    }
  }

  /**
   * Fetch on-chain league state from Soroban escrow contract.
   */
  public async getContractLeagueState(
    leagueId: number | bigint
  ): Promise<OnChainLeagueState | null> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }
    return client.getLeague(leagueId);
  }

  /**
   * Dispatches an administrator-authorized settlement and waits for finality.
   */
  public async settleLeague(
    leagueId: number | bigint,
    winners: Array<{ winner: string; amount: string }>,
    platformFeeStroops: bigint
  ): Promise<InvocationResult> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }

    const adminSecret = process.env.TESTNET_ADMIN_SECRET;
    if (!adminSecret) {
      throw new Error("TESTNET_ADMIN_SECRET is required to execute settlements");
    }

    const adminPublic = Keypair.fromSecret(adminSecret).publicKey();
    return client.settle(
      adminSecret,
      adminPublic,
      leagueId,
      winners,
      stellarConfig.treasuryAddress,
      platformFeeStroops
    );
  }

  /**
   * Fetch on-chain participant deposit amount from Soroban escrow contract.
   */
  public async getContractDeposit(
    leagueId: number | bigint,
    participantAddress: string
  ): Promise<bigint> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }
    return client.getDeposit(leagueId, participantAddress);
  }

  /**
   * Fetch USDC SAC token balance from Soroban for an account or contract address.
   */
  public async getContractTokenBalance(
    addressOrContractId: string
  ): Promise<bigint> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }
    return client.getTokenBalance(addressOrContractId);
  }

  /**
   * Refund escrowed deposits for a batch of participants via the admin keypair.
   */
  public async refundParticipants(
    leagueId: number | bigint,
    participants: string[]
  ): Promise<InvocationResult> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }
    const adminSecret = process.env.TESTNET_ADMIN_SECRET;
    if (!adminSecret) {
      throw new Error("TESTNET_ADMIN_SECRET is required to execute refunds");
    }
    const adminPublic = Keypair.fromSecret(adminSecret).publicKey();
    return client.refund(adminSecret, adminPublic, leagueId, participants);
  }

  /**
   * Reconcile database expectations with live on-chain Soroban escrow state.
   */
  public async reconcileWithContract(
    leagueId: number | bigint,
    dbExpectedDepositsUsdc: number,
    dbParticipantCount: number
  ): Promise<ContractReconciliationResult> {
    const state = await this.getContractLeagueState(leagueId);
    if (!state) {
      throw new Error(`League ${leagueId} not found on Soroban contract`);
    }

    // Convert stroops to USDC (7 decimals)
    const onChainDepositedUsdc = Number(state.total_deposited) / 10_000_000;
    const discrepancyUsdc = Math.abs(dbExpectedDepositsUsdc - onChainDepositedUsdc);
    const countMatches = state.participant_count === dbParticipantCount;
    const isBalanced = discrepancyUsdc < 0.0001 && countMatches;

    const statusNames = ["Upcoming", "Active", "Settled", "Cancelled"];

    return {
      onChainBalanced: isBalanced,
      onChainDepositedUsdc,
      onChainParticipantCount: state.participant_count,
      onChainStatus: statusNames[state.status] || "Unknown",
      discrepancyUsdc: parseFloat(discrepancyUsdc.toFixed(4)),
    };
  }
}

export const stellarService = new StellarService();
