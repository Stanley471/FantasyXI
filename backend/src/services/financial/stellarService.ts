/**
 * Stellar Service — Horizon & Soroban Network Abstraction
 *
 * Laravel analogy: Like a dedicated PaymentGateway client or StripeService.
 * Handles read queries and transaction verification against the Stellar Testnet.
 * Never executes state changes on the database directly; returns pure verification results.
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  Networks,
  Address,
  Keypair,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  getSorobanRpcServer,
  stellarConfig,
  withHorizonFailover,
} from "../../config/stellar.js";
import { PaymentVerificationResult } from "../../types/index.js";
import {
  SorobanContractClient,
  OnChainLeagueState,
  InvocationResult,
} from "./sorobanContractClient.js";
import { toContractLeagueId } from "./contractLeagueId.js";
export {
  DepositVerificationService,
  DepositVerificationErrorCode,
  type VerifyDepositParams,
  type VerificationSuccess,
  type VerificationFailure,
  type DepositVerificationResult,
} from "./depositVerificationService.js";
export {
  decodeSorobanEscrowEvent,
  DepositQueue,
  depositQueue,
  type DecodedSorobanEscrowEvent,
  type DepositQueueJobPayload,
} from "../../queues/depositQueue.js";

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
  "m_settle",
  "refund",
  "claimed",
  "m_claimed",
] as const;

/** Horizon operation types that deliver a destination asset to `to`. */
export const DEPOSIT_PAYMENT_OPERATION_TYPES = [
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
] as const;

export const PATH_PAYMENT_DEFAULT_SLIPPAGE_BPS = 50;
export const PATH_PAYMENT_MAX_SLIPPAGE_BPS = 500;
/** Quotes go stale fast on the DEX; envelopes are only valid this long. */
export const PATH_PAYMENT_QUOTE_TTL_SECONDS = 60;

export type PathPaymentErrorCode = "INVALID_AMOUNT" | "INVALID_SLIPPAGE" | "NO_PATH" | "QUOTE_EXPIRED";

export class PathPaymentError extends Error {
  constructor(public readonly code: PathPaymentErrorCode, message: string) {
    super(message);
    this.name = "PathPaymentError";
  }
}

export interface PathPaymentQuote {
  sendAsset: Asset;
  destAsset: Asset;
  /** Exact amount delivered (strict receive) */
  destAmount: string;
  /** Best-path cost at quote time */
  sourceAmount: string;
  /** Hard cap on the amount spent: sourceAmount + slippage */
  sendMax: string;
  path: Asset[];
  slippageBps: number;
  /** Unix seconds after which the envelope can no longer execute */
  expiresAt: number;
}

export interface PathPaymentEnvelope {
  xdr: string;
  networkPassphrase: string;
  /**
   * True when the swap pays the escrow account directly. Classic operations
   * cannot pay a Soroban contract, so for a contract escrow the swap lands in
   * the depositor's wallet and the contract `deposit` follows.
   */
  settlesIntoEscrow: boolean;
  expiresAt: number;
}

export type PathPaymentSubmission =
  | { status: "SETTLED"; txHash: string; ledger: number }
  | {
      status: "ABORTED";
      txHash?: string;
      reason: string;
      resultCodes: { transaction?: string; operations?: string[] };
      /** Re-quote and retry (price moved, liquidity gone, quote expired) */
      retryable: boolean;
      /** Path payments are atomic: a failed one moves no funds */
      fundsMoved: false;
    }
  | { status: "PENDING"; txHash: string; expiresAt?: number };

/** Result codes that a fresh quote can fix. */
const RETRYABLE_PATH_PAYMENT_CODES = new Set([
  "op_over_source_max",
  "op_under_dest_min",
  "op_too_few_offers",
  "op_cross_self",
  "tx_too_late",
  "tx_bad_seq",
]);

const STROOPS_PER_UNIT = 10_000_000n;

function amountToStroops(amount: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) {
    throw new PathPaymentError("INVALID_AMOUNT", `Invalid amount: ${amount}`);
  }
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
}

function stroopsToAmount(stroops: bigint): string {
  const fraction = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${stroops / STROOPS_PER_UNIT}.${fraction}`;
}

function horizonAsset(type: string, code?: string, issuer?: string): Asset {
  return type === "native" ? Asset.native() : new Asset(code!, issuer!);
}

function validateSlippage(slippageBps: number): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > PATH_PAYMENT_MAX_SLIPPAGE_BPS) {
    throw new PathPaymentError(
      "INVALID_SLIPPAGE",
      `Slippage must be an integer between 0 and ${PATH_PAYMENT_MAX_SLIPPAGE_BPS} bps`
    );
  }
}

export class StellarService {
  private customServer?: Horizon.Server;
  private sorobanClient?: SorobanContractClient;
  private rpcServer?: rpc.Server;

  constructor(
    customServer?: Horizon.Server,
    customSorobanClient?: SorobanContractClient,
    customRpcServer?: rpc.Server
  ) {
    this.customServer = customServer;
    this.sorobanClient = customSorobanClient;
    this.rpcServer = customRpcServer;
  }

  private runHorizon<T>(operation: (server: Horizon.Server) => Promise<T>): Promise<T> {
    return this.customServer ? operation(this.customServer) : withHorizonFailover(operation);
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

  public async getHorizonLatestLedger(): Promise<number> {
    const page = await this.server.ledgers().order("desc").limit(1).call();
    const ledger = page.records[0]?.sequence;
    if (!Number.isInteger(ledger)) {
      throw new Error("Horizon did not return a latest ledger sequence");
    }
    return ledger;
  }

  public async getContractLeagueStateForAudit(
    leagueId: number | bigint
  ): Promise<OnChainLeagueState | null> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }
    return client.getLeagueForAudit(leagueId);
  }

  public async getContractDepositForAudit(
    leagueId: number | bigint,
    participantAddress: string
  ): Promise<bigint> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }
    return client.getDepositForAudit(leagueId, participantAddress);
  }

  public async getContractTokenBalanceForAudit(
    addressOrContractId: string
  ): Promise<bigint> {
    const client = this.getSorobanClient();
    if (!client) {
      throw new Error("Soroban contract client is not configured");
    }
    return client.getTokenBalanceForAudit(addressOrContractId);
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
      const tx = await this.runHorizon((server) =>
        server.transactions().transaction(txHash).call()
      );

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
      const opsPage = await this.runHorizon((server) =>
        server.operations().forTransaction(txHash).call()
      );

      // Find payment operation matching criteria
      const matchingOp = opsPage.records.find((op: any) => {
        // We look for payment operations (including DEX path payments)
        if (!DEPOSIT_PAYMENT_OPERATION_TYPES.includes(op.type)) return false;

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
          retryable: true,
        };
      }

      return {
        success: false,
        txHash,
        error: `Stellar network error: ${error?.message || "Unknown error"}`,
        retryable: true,
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
      const account = await this.runHorizon((server) => server.loadAccount(stellarAddress));
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
  public async resumeSettlementEnvelope(envelope: string): Promise<InvocationResult> {
    const client = this.getSorobanClient();
    if (!client) throw new Error("Soroban contract client is not configured");
    return client.resumeEnvelope(envelope);
  }

  public async getSettlementStatus(hash: string): Promise<{ status: string; ledger?: number }> {
    return getSorobanRpcServer().getTransaction(hash);
  }

  public async settleLeague(
    leagueId: number | bigint,
    winners: Array<{ winner: string; amount: string }>,
    platformFeeStroops: bigint,
    distributionBpsOrBeforeSubmit?: number[] | ((hash: string, envelope: string) => Promise<void>),
    beforeSubmitArg?: (hash: string, envelope: string) => Promise<void>
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
      platformFeeStroops,
      distributionBpsOrBeforeSubmit,
      beforeSubmitArg
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

  /** Refund one authenticated deposit without cancelling the league. */
  public async refundDeposit(leagueId: number | bigint, participant: string): Promise<InvocationResult> {
    const client = this.getSorobanClient();
    if (!client) throw new Error("Soroban contract client is not configured");
    const adminSecret = process.env.TESTNET_ADMIN_SECRET;
    if (!adminSecret) throw new Error("TESTNET_ADMIN_SECRET is required to execute refunds");
    const adminPublic = Keypair.fromSecret(adminSecret).publicKey();
    return client.refundDeposit(adminSecret, adminPublic, leagueId, participant);
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

  /** USDC as configured for entry fees. */
  public static entryFeeAsset(): Asset {
    return new Asset(stellarConfig.usdcAssetCode, stellarConfig.usdcIssuer);
  }

  /**
   * Finds the cheapest Stellar DEX path that delivers exactly `destAmount` of
   * the entry-fee asset when paying with `sendAsset`, and caps the spend at
   * the quoted cost plus `slippageBps`.
   */
  public async quoteEntryFeePathPayment(params: {
    sendAsset: Asset;
    destAmount: string;
    destAsset?: Asset;
    slippageBps?: number;
    now?: number;
  }): Promise<PathPaymentQuote> {
    const destAsset = params.destAsset ?? StellarService.entryFeeAsset();
    const slippageBps = params.slippageBps ?? PATH_PAYMENT_DEFAULT_SLIPPAGE_BPS;
    validateSlippage(slippageBps);
    if (amountToStroops(params.destAmount) <= 0n) {
      throw new PathPaymentError("INVALID_AMOUNT", "Entry fee amount must be positive");
    }

    const page = await this.server
      .strictReceivePaths([params.sendAsset], destAsset, params.destAmount)
      .call();
    const candidates = page.records.filter((record) =>
      horizonAsset(record.source_asset_type, record.source_asset_code, record.source_asset_issuer).equals(
        params.sendAsset
      )
    );
    if (candidates.length === 0) {
      throw new PathPaymentError("NO_PATH", "No DEX liquidity path delivers the entry fee from this asset");
    }
    const best = candidates.reduce((a, b) =>
      amountToStroops(b.source_amount) < amountToStroops(a.source_amount) ? b : a
    );

    const sourceStroops = amountToStroops(best.source_amount);
    const sendMaxStroops = (sourceStroops * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
    const now = params.now ?? Math.floor(Date.now() / 1000);
    return {
      sendAsset: params.sendAsset,
      destAsset,
      destAmount: stroopsToAmount(amountToStroops(params.destAmount)),
      sourceAmount: stroopsToAmount(sourceStroops),
      sendMax: stroopsToAmount(sendMaxStroops),
      path: best.path.map((hop) => horizonAsset(hop.asset_type, hop.asset_code, hop.asset_issuer)),
      slippageBps,
      expiresAt: now + PATH_PAYMENT_QUOTE_TTL_SECONDS,
    };
  }

  /**
   * Builds the unsigned single-operation `pathPaymentStrictReceive` envelope
   * for the depositor to sign. The operation is atomic: it either delivers
   * exactly `destAmount` while spending at most `sendMax`, or fails without
   * moving funds. Its time bounds end at the quote expiry.
   */
  public async buildPathPaymentEnvelope(params: {
    sourceAccount: string;
    quote: PathPaymentQuote;
    destination: string;
    memo?: string;
    now?: number;
  }): Promise<PathPaymentEnvelope> {
    const { quote } = params;
    const now = params.now ?? Math.floor(Date.now() / 1000);
    if (now >= quote.expiresAt) {
      throw new PathPaymentError("QUOTE_EXPIRED", "Path payment quote has expired; request a new quote");
    }
    const settlesIntoEscrow = StrKey.isValidEd25519PublicKey(params.destination);
    const account = await this.server.loadAccount(params.sourceAccount);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: stellarConfig.networkPassphrase,
      timebounds: { minTime: 0, maxTime: quote.expiresAt },
    }).addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: quote.sendAsset,
        sendMax: quote.sendMax,
        destination: settlesIntoEscrow ? params.destination : params.sourceAccount,
        destAsset: quote.destAsset,
        destAmount: quote.destAmount,
        path: quote.path,
      })
    );
    if (params.memo) builder.addMemo(Memo.text(params.memo));
    return {
      xdr: builder.build().toXDR(),
      networkPassphrase: stellarConfig.networkPassphrase,
      settlesIntoEscrow,
      expiresAt: quote.expiresAt,
    };
  }

  /**
   * Fallback for the two-step contract-escrow flow: when the swap settled but
   * the Soroban `deposit` then failed, swaps the received entry-fee asset back
   * into the original asset (strict send, accepting at most `slippageBps` less
   * than the best path currently returns).
   */
  public async buildPathPaymentRefundEnvelope(params: {
    sourceAccount: string;
    quote: PathPaymentQuote;
    slippageBps?: number;
    now?: number;
  }): Promise<PathPaymentEnvelope> {
    const { quote } = params;
    const slippageBps = params.slippageBps ?? quote.slippageBps;
    validateSlippage(slippageBps);

    const page = await this.server
      .strictSendPaths(quote.destAsset, quote.destAmount, [quote.sendAsset])
      .call();
    const candidates = page.records.filter((record) =>
      horizonAsset(
        record.destination_asset_type,
        record.destination_asset_code,
        record.destination_asset_issuer
      ).equals(quote.sendAsset)
    );
    if (candidates.length === 0) {
      throw new PathPaymentError("NO_PATH", "No DEX liquidity path to swap the entry fee back");
    }
    const best = candidates.reduce((a, b) =>
      amountToStroops(b.destination_amount) > amountToStroops(a.destination_amount) ? b : a
    );
    const destMin =
      (amountToStroops(best.destination_amount) * BigInt(10_000 - slippageBps)) / 10_000n;

    const expiresAt = (params.now ?? Math.floor(Date.now() / 1000)) + PATH_PAYMENT_QUOTE_TTL_SECONDS;
    const account = await this.server.loadAccount(params.sourceAccount);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: stellarConfig.networkPassphrase,
      timebounds: { minTime: 0, maxTime: expiresAt },
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: quote.destAsset,
          sendAmount: quote.destAmount,
          destination: params.sourceAccount,
          destAsset: quote.sendAsset,
          destMin: stroopsToAmount(destMin),
          path: best.path.map((hop) => horizonAsset(hop.asset_type, hop.asset_code, hop.asset_issuer)),
        })
      )
      .build();
    return {
      xdr: tx.toXDR(),
      networkPassphrase: stellarConfig.networkPassphrase,
      settlesIntoEscrow: false,
      expiresAt,
    };
  }

  /**
   * Submits a signed path payment envelope. A rejected transaction is
   * reported as a clean abort (no funds moved) with a retry hint; an
   * ambiguous network failure is resolved by looking the hash up on Horizon.
   */
  public async submitPathPayment(signedXdr: string): Promise<PathPaymentSubmission> {
    const tx = TransactionBuilder.fromXDR(signedXdr, stellarConfig.networkPassphrase);
    const txHash = Buffer.from(tx.hash()).toString("hex");
    try {
      const result = await this.server.submitTransaction(tx);
      return { status: "SETTLED", txHash: result.hash, ledger: result.ledger };
    } catch (error) {
      const resultCodes = (error as {
        response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } };
      }).response?.data?.extras?.result_codes;

      if (resultCodes) {
        const codes = [resultCodes.transaction, ...(resultCodes.operations ?? [])].filter(
          (code): code is string => !!code && code !== "op_success" && code !== "tx_failed"
        );
        return {
          status: "ABORTED",
          txHash,
          reason: codes.join(", ") || "transaction rejected",
          resultCodes,
          retryable: codes.some((code) => RETRYABLE_PATH_PAYMENT_CODES.has(code)),
          fundsMoved: false,
        };
      }

      // No result codes: the submission may or may not have reached the network.
      try {
        const record = await this.server.transactions().transaction(txHash).call();
        if (record.successful) {
          return { status: "SETTLED", txHash, ledger: record.ledger_attr };
        }
        return {
          status: "ABORTED",
          txHash,
          reason: "transaction failed on-chain",
          resultCodes: {},
          retryable: true,
          fundsMoved: false,
        };
      } catch {
        const timeBounds = "timeBounds" in tx ? tx.timeBounds : undefined;
        const maxTime = timeBounds?.maxTime ? Number(timeBounds.maxTime) : undefined;
        return { status: "PENDING", txHash, expiresAt: maxTime };
      }
    }
  }
}

export const stellarService = new StellarService();
