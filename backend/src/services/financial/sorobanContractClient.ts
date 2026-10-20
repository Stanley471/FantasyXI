/**
 * Soroban Contract Client for FantasyXI Escrow & Token SAC
 *
 * Provides typed methods to interact with:
 * 1. FantasyXI Escrow Contract (initialize, create_league, deposit, settle, refund, get_league, get_deposit)
 * 2. Testnet USDC SAC (balance)
 *
 * Pure TypeScript implementation on top of @stellar/stellar-sdk's rpc.Server:
 * build invokeHostFunction -> simulate -> (restore footprint if needed) ->
 * assemble with Soroban data -> sign -> send -> poll until final.
 *
 * Analogous in Laravel to a dedicated SmartContractGateway or BlockchainRpcService.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  Account,
  Address,
  authorizeEntry,
  BASE_FEE,
  Contract,
  inspectAuthEntry,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
  xdr,
  Transaction,
} from "@stellar/stellar-sdk";
import {
  LocalSecretTransactionSigner,
  type StellarTransactionSigner,
  type StellarTransaction,
} from "./transactionSigner.js";

// Load testnet deployment configuration
const envTestnetPath = path.resolve(process.cwd(), ".env.testnet.local");
if (fs.existsSync(envTestnetPath)) {
  dotenv.config({ path: envTestnetPath });
}

/** Well-known empty account used as the source of read-only simulations. */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

import {
  parseSorobanError,
  executeWithRetry,
  executeWithRollback,
  EscrowContractErrorCode,
  ESCROW_ERROR_CATALOG,
  type ParsedSorobanError,
} from "./sorobanErrorRecovery.js";
import { toContractLeagueId } from "./contractLeagueId.js";

export {
  parseSorobanError,
  executeWithRetry,
  executeWithRollback,
  EscrowContractErrorCode,
  ESCROW_ERROR_CATALOG,
  type ParsedSorobanError,
};

export interface OnChainLeagueState {
  creator: string;
  entry_fee: bigint;
  participant_count: number;
  status: number; // 0 = Upcoming, 1 = Active, 2 = Settled, 3 = Cancelled
  total_deposited: bigint;
  token_address?: string;
  asset?: string;
}

export interface WinnerPayoutParam {
  winner: string;
  amount: string; // stroops as string e.g. "171000000"
}

export interface InvocationResult {
  success: boolean;
  txHash?: string;
  ledgerSeq?: number;
  returnValue?: unknown;
  error?: string;
  contractErrorCode?: number;
  humanError?: string;
  isRetryable?: boolean;
  uncertain?: boolean;
}

export type DepositSimulationResult =
  | {
      success: true;
      minResourceFee: string;
      needsRestoration: boolean;
      estimatedFeeXlm: string;
    }
  | { success: false; error: string };

export class SorobanContractClient {
  private static configuredSigner?: StellarTransactionSigner;
  private server: rpc.Server;
  private networkPassphrase: string;
  private escrowContractId: string;
  private usdcContractId: string;
  private pollIntervalMs: number;
  private maxPollAttempts: number;
  private signer: StellarTransactionSigner;
  private feeBumpFeeSource?: string;

  constructor(options?: {
    rpcUrl?: string;
    networkPassphrase?: string;
    escrowContractId?: string;
    usdcContractId?: string;
    server?: rpc.Server;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
    signer?: StellarTransactionSigner;
    feeBumpFeeSource?: string;
  }) {
    const rpcUrl =
      options?.rpcUrl ||
      process.env.STELLAR_SOROBAN_RPC_URL ||
      "https://soroban-testnet.stellar.org";
    this.server =
      options?.server ||
      new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.networkPassphrase =
      options?.networkPassphrase ||
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      Networks.TESTNET;
    this.escrowContractId =
      options?.escrowContractId || process.env.STELLAR_ESCROW_CONTRACT_ID || "";
    this.usdcContractId =
      options?.usdcContractId ||
      process.env.STELLAR_USDC_TOKEN_CONTRACT_ID ||
      "";
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxPollAttempts = options?.maxPollAttempts ?? 30;
    this.signer = options?.signer || SorobanContractClient.configuredSigner || new LocalSecretTransactionSigner();
    this.feeBumpFeeSource = options?.feeBumpFeeSource || process.env.STELLAR_FEE_BUMP_SOURCE;

    if (!this.escrowContractId) {
      throw new Error("STELLAR_ESCROW_CONTRACT_ID not provided or set in environment.");
    }
  }

  public static configureSigner(signer: StellarTransactionSigner): void {
    SorobanContractClient.configuredSigner = signer;
  }

  public getEscrowContractId(): string {
    return this.escrowContractId;
  }

  public getUsdcContractId(): string {
    return this.usdcContractId;
  }

  /**
   * Extracts the numeric code from a contract error such as "Error(Contract, #7)".
   */
  public static parseContractErrorCode(message: string): number | undefined {
    const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private failure(error: string, txHash?: string): InvocationResult {
    const parsed = parseSorobanError(error);
    return {
      success: false,
      txHash,
      error,
      contractErrorCode: parsed.errorCode ?? SorobanContractClient.parseContractErrorCode(error),
      humanError: parsed.humanMessage,
      isRetryable: parsed.isRetryable,
    };
  }

  private buildInvocation(
    source: Account,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    fee: string = BASE_FEE
  ): Transaction {
    return new TransactionBuilder(source, {
      fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
  }

  /**
   * Submits a signed transaction and polls until it is final.
   */
  private async sendAndPoll(tx: StellarTransaction, beforeSubmit?: (hash: string, envelope: string) => Promise<void>): Promise<InvocationResult> {
    let submitted: StellarTransaction = tx;
    if (this.feeBumpFeeSource && tx instanceof Transaction) {
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        await this.signer.publicKey(this.feeBumpFeeSource),
        Math.max(Number(BASE_FEE), Number(tx.fee)).toString(),
        tx,
        this.networkPassphrase
      );
      await this.signer.sign(feeBump, this.feeBumpFeeSource);
      submitted = feeBump;
    }
    const hash = Buffer.from(submitted.hash()).toString("hex");
    // Persist the exact signed hash before any bytes can reach the RPC server.
    // A journal failure prevents submission; a response loss must never rebuild a new tx.
    await beforeSubmit?.(hash, submitted.toXDR());
    try {
      const sent = await this.server.sendTransaction(submitted);
      if (sent.status === "ERROR") {
        return this.failure(
          `Transaction rejected (${sent.status}): ${sent.errorResult?.toXDR("base64") ?? "unknown"}`,
          hash
        );
      }

      for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
        const result = await this.server.getTransaction(hash);
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          return {
            success: true,
            txHash: hash,
            ledgerSeq: result.ledger,
            returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined,
          };
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          return this.failure(
            `Transaction failed: ${result.resultXdr.toXDR("base64")}`,
            hash
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }

      return { ...this.failure(`Transaction ${hash} not confirmed in time`, hash), uncertain: true, isRetryable: false };
    } catch (error) {
      return { ...this.failure(`Submission outcome unknown: ${(error as Error).message}`, hash), isRetryable: false, uncertain: true };
    }
  }

  /**
   * Restores archived ledger entries reported by a simulation (Operation.restoreFootprint).
   */
  private async restoreFootprint(
    sourceKey: string,
    restorePreamble: { minResourceFee: string; transactionData: { build(): xdr.SorobanTransactionData } }
  ): Promise<InvocationResult> {
    const account = await this.server.getAccount(await this.signer.publicKey(sourceKey));
    const restoreTx = new TransactionBuilder(account, {
      fee: (Number(BASE_FEE) + Number(restorePreamble.minResourceFee)).toString(),
      networkPassphrase: this.networkPassphrase,
    })
      .setSorobanData(restorePreamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(30)
      .build();
    await this.signer.sign(restoreTx, sourceKey);
    return this.sendAndPoll(restoreTx);
  }

  /**
   * Full RPC pipeline for a state-changing contract call.
   */
  /** Replay only the durable envelope: its hash/time bounds/sequence remain unchanged. */
  public async resumeEnvelope(envelope: string): Promise<InvocationResult> {
    const tx = TransactionBuilder.fromXDR(envelope, this.networkPassphrase);
    return this.sendAndPoll(tx);
  }

  public async invoke(
    sourceSecret: string,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    beforeSubmit?: (hash: string, envelope: string) => Promise<void>
  ): Promise<InvocationResult> {
    return executeWithRetry(
      async () => {
        try {
          const keypair = Keypair.fromSecret(sourceSecret);

          let account = await this.server.getAccount(keypair.publicKey());
          let tx = this.buildInvocation(account, contractId, method, args);
          let simulation = await this.server.simulateTransaction(tx);

          if (rpc.Api.isSimulationError(simulation)) {
            return this.failure(`Simulation failed: ${simulation.error}`);
          }

          if (rpc.Api.isSimulationRestore(simulation)) {
            const restored = await this.restoreFootprint(sourceSecret, simulation.restorePreamble);
            if (!restored.success) {
              return this.failure(`Footprint restoration failed: ${restored.error}`, restored.txHash);
            }
            account = await this.server.getAccount(keypair.publicKey());
            tx = this.buildInvocation(account, contractId, method, args);
            simulation = await this.server.simulateTransaction(tx);
            if (rpc.Api.isSimulationError(simulation)) {
              return this.failure(`Simulation failed: ${simulation.error}`);
            }
          }

          const prepared = rpc.assembleTransaction(tx, simulation).build();
          prepared.sign(keypair);
          const pollRes = await this.sendAndPoll(prepared, beforeSubmit);
          if (!pollRes.success && pollRes.isRetryable && !pollRes.txHash) {
            throw new Error(pollRes.error || "Retryable transaction failure");
          }
          return pollRes;
        } catch (error) {
          const errorMsg = (error as Error).message;
          const parsed = parseSorobanError(errorMsg);
          if (parsed.isRetryable) {
            throw error;
          }
          return this.failure(errorMsg);
        }
      },
      { maxRetries: 2, initialDelayMs: 250 }
    );
  }

  /**
   * Read-only contract call: simulation only, nothing is submitted.
   */
  public async simulateView(
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<InvocationResult> {
    try {
      const tx = this.buildInvocation(new Account(SIMULATION_SOURCE, "0"), contractId, method, args);
      const simulation = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulation)) {
        return this.failure(`Simulation failed: ${simulation.error}`);
      }
      const retval = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      return { success: true, returnValue: retval ? scValToNative(retval) : undefined };
    } catch (error) {
      return this.failure((error as Error).message);
    }
  }

  private static u64(value: number | bigint): xdr.ScVal {
    return nativeToScVal(BigInt(value), { type: "u64" });
  }

  private static i128(value: bigint | string): xdr.ScVal {
    return nativeToScVal(BigInt(value), { type: "i128" });
  }

  private static address(value: string): xdr.ScVal {
    return new Address(value).toScVal();
  }

  /** WinnerPayout struct -> ScMap with keys in lexicographic order. */
  private static winnersScVal(winners: WinnerPayoutParam[]): xdr.ScVal {
    return xdr.ScVal.scvVec(
      winners.map((w) =>
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("amount"),
            val: SorobanContractClient.i128(w.amount),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("winner"),
            val: SorobanContractClient.address(w.winner),
          }),
        ])
      )
    );
  }

  /**
   * One-time contract initialization with admin and USDC token.
   */
  public async initialize(
    adminSecret: string,
    adminPublic: string,
    usdcTokenContractId: string
  ): Promise<InvocationResult> {
    return this.invoke(adminSecret, this.escrowContractId, "initialize", [
      SorobanContractClient.address(adminPublic),
      SorobanContractClient.address(usdcTokenContractId),
    ]);
  }

  /**
   * Create competition partition identified by `league_id`.
   */
  public async createLeague(
    creatorSecret: string,
    creatorPublic: string,
    leagueId: number | bigint,
    entryFeeStroops: bigint
  ): Promise<InvocationResult> {
    return this.invoke(creatorSecret, this.escrowContractId, "create_league", [
      SorobanContractClient.address(creatorPublic),
      SorobanContractClient.u64(leagueId),
      SorobanContractClient.i128(entryFeeStroops),
    ]);
  }

  /**
   * Deposit entry fee into league partition.
   */
  public async deposit(
    participantSecret: string,
    participantPublic: string,
    leagueId: number | bigint
  ): Promise<InvocationResult> {
    return this.invoke(participantSecret, this.escrowContractId, "deposit", [
      SorobanContractClient.address(participantPublic),
      SorobanContractClient.u64(leagueId),
    ]);
  }

  /** Simulates a user's deposit without signing or submitting a transaction. */
  public async simulateDepositTransaction(
    participantPublic: string,
    leagueId: number | bigint | string
  ): Promise<DepositSimulationResult> {
    if (!StrKey.isValidEd25519PublicKey(participantPublic)) {
      return { success: false, error: "A valid Stellar public key is required." };
    }

    let contractLeagueId: bigint;
    try {
      contractLeagueId =
        typeof leagueId === "string" && !/^\d+$/.test(leagueId)
          ? toContractLeagueId(leagueId)
          : BigInt(leagueId);
    } catch {
      return { success: false, error: "A valid league ID is required." };
    }

    try {
      const account = await this.server.getAccount(participantPublic);
      const transaction = this.buildInvocation(account, this.escrowContractId, "deposit", [
        SorobanContractClient.address(participantPublic),
        SorobanContractClient.u64(contractLeagueId),
      ]);
      const simulation = await this.server.simulateTransaction(transaction);
      if (rpc.Api.isSimulationError(simulation)) {
        return { success: false, error: `Simulation failed: ${simulation.error}` };
      }

      const needsRestoration = rpc.Api.isSimulationRestore(simulation);
      const minResourceFee = BigInt(simulation.minResourceFee ?? "0");
      const restorationResourceFee = needsRestoration
        ? BigInt(simulation.restorePreamble.minResourceFee ?? "0")
        : 0n;
      const baseFees = BigInt(BASE_FEE) * (needsRestoration ? 2n : 1n);
      const totalFeeStroops = baseFees + minResourceFee + restorationResourceFee;
      const wholeXlm = totalFeeStroops / 10_000_000n;
      const fractionalXlm = (totalFeeStroops % 10_000_000n)
        .toString()
        .padStart(7, "0")
        .replace(/0+$/, "");

      return {
        success: true,
        minResourceFee: minResourceFee.toString(),
        needsRestoration,
        estimatedFeeXlm: fractionalXlm ? `${wholeXlm}.${fractionalXlm}` : wholeXlm.toString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Soroban RPC error";
      return { success: false, error: `Unable to simulate deposit: ${message}` };
    }
  }

  /** Publishes a commitment to a finalized gameweek's score set on Soroban. */
  public async publishGameweekResult(
    adminKey: string,
    gameweekId: number | bigint,
    proofHash: string
  ): Promise<InvocationResult> {
    if (!/^[0-9a-f]{64}$/i.test(proofHash)) {
      return this.failure("Gameweek result proof must be a 32-byte hexadecimal hash");
    }
    return this.invoke(adminKey, this.escrowContractId, "publish_gameweek_result", [
      SorobanContractClient.address(await this.signer.publicKey(adminKey)),
      SorobanContractClient.u64(gameweekId),
      nativeToScVal(Buffer.from(proofHash, "hex"), { type: "bytes" }),
    ]);
  }

  /**
   * Admin settles the league with winner payouts and platform treasury fee.
   */
  public async settle(
    adminSecret: string,
    adminPublic: string,
    leagueId: number | bigint,
    winners: WinnerPayoutParam[],
    platformTreasury: string,
    platformFeeStroops: bigint,
    beforeSubmit?: (hash: string, envelope: string) => Promise<void>
  ): Promise<InvocationResult> {
    const winnersScVal = SorobanContractClient.winnersScVal(winners);

    return this.invoke(adminSecret, this.escrowContractId, "settle", [
      SorobanContractClient.address(adminPublic),
      SorobanContractClient.u64(leagueId),
      winnersScVal,
      SorobanContractClient.address(platformTreasury),
      SorobanContractClient.i128(platformFeeStroops),
    ], beforeSubmit);
  }

  /** Settles with a required 32-byte commitment to the off-chain calculation. */
  public async settleWithProof(
    adminSecret: string,
    adminPublic: string,
    leagueId: number | bigint,
    winners: WinnerPayoutParam[],
    platformTreasury: string,
    platformFeeStroops: bigint,
    proofHash: string
  ): Promise<InvocationResult> {
    if (!/^[0-9a-f]{64}$/i.test(proofHash)) {
      return this.failure("Settlement proof must be a 32-byte hexadecimal hash");
    }
    const winnersScVal = SorobanContractClient.winnersScVal(winners);
    return this.invoke(adminSecret, this.escrowContractId, "settle_with_proof", [
      SorobanContractClient.address(adminPublic),
      SorobanContractClient.u64(leagueId),
      winnersScVal,
      SorobanContractClient.address(platformTreasury),
      SorobanContractClient.i128(platformFeeStroops),
      nativeToScVal(Buffer.from(proofHash, "hex"), { type: "bytes" }),
    ]);
  }

  /**
   * Settles a league and routes the platform fee to the treasury through the
   * contract's M-of-N multi-sig gate (`settle_with_multisig`), instead of the
   * single-admin-secret `settle` path.
   *
   * Every address in `approverSecrets` is required to authorize the invocation
   * (the contract itself calls `require_auth()` per approved signer, see
   * `authorize_signers` in contracts/src/lib.rs), so this method collects a
   * signed Soroban authorization entry per configured signer before the
   * transaction is assembled and submitted. `requiredThreshold` mirrors the
   * on-chain `AdminConfig.threshold` and is checked locally first so an
   * under-signed withdrawal never reaches the network - the contract enforces
   * the same rule independently as the source of truth.
   *
   * The first entry in `approverSecrets` also pays the transaction fee and
   * submits it (one of the M signers proposes the withdrawal once every
   * required approval has been collected out of band).
   */
  public async settleWithMultisig(
    approverSecrets: string[],
    leagueId: number | bigint,
    winners: WinnerPayoutParam[],
    platformTreasury: string,
    platformFeeStroops: bigint,
    requiredThreshold: number
  ): Promise<InvocationResult> {
    if (requiredThreshold < 1) {
      return this.failure("Treasury multisig threshold must be at least 1");
    }
    if (approverSecrets.length < requiredThreshold) {
      return this.failure(
        `Insufficient signatures for treasury withdrawal: ${approverSecrets.length} of ${requiredThreshold} required signer(s) provided`
      );
    }

    try {
      const approverKeypairs = approverSecrets.map((secret) => Keypair.fromSecret(secret));
      const submitterKeypair = approverKeypairs[0];
      const approvalsScVal = xdr.ScVal.scvVec(
        approverKeypairs.map((kp) => SorobanContractClient.address(kp.publicKey()))
      );
      const winnersScVal = SorobanContractClient.winnersScVal(winners);
      const args = [
        approvalsScVal,
        SorobanContractClient.u64(leagueId),
        winnersScVal,
        SorobanContractClient.address(platformTreasury),
        SorobanContractClient.i128(platformFeeStroops),
      ];

      let account = await this.server.getAccount(submitterKeypair.publicKey());
      let tx = this.buildInvocation(account, this.escrowContractId, "settle_with_multisig", args);
      let simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        return this.failure(`Simulation failed: ${simulation.error}`);
      }

      if (rpc.Api.isSimulationRestore(simulation)) {
        const restored = await this.restoreFootprint(approverSecrets[0], simulation.restorePreamble);
        if (!restored.success) {
          return this.failure(`Footprint restoration failed: ${restored.error}`, restored.txHash);
        }
        account = await this.server.getAccount(submitterKeypair.publicKey());
        tx = this.buildInvocation(account, this.escrowContractId, "settle_with_multisig", args);
        simulation = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simulation)) {
          return this.failure(`Simulation failed: ${simulation.error}`);
        }
      }

      const successSim = simulation as rpc.Api.SimulateTransactionSuccessResponse;
      const rawAuthEntries = successSim.result?.auth ?? [];
      const latestLedger = await this.server.getLatestLedger();
      const validUntilLedgerSeq = latestLedger.sequence + 100;

      const signedAuthEntries = await Promise.all(
        rawAuthEntries.map(async (entry) => {
          const info = inspectAuthEntry(entry);
          if (!info.address) {
            // Source-account credentials carry no separate signature.
            return entry;
          }
          const keypair = approverKeypairs.find((kp) => kp.publicKey() === info.address);
          if (!keypair) {
            throw new Error(
              `No approving signer secret was supplied for required treasury signer ${info.address}`
            );
          }
          return authorizeEntry(entry, keypair, validUntilLedgerSeq, this.networkPassphrase);
        })
      );

      const invokeOp = tx.operations[0] as Operation.InvokeHostFunction;
      const freshAccount = await this.server.getAccount(submitterKeypair.publicKey());
      const rebuiltTx = new TransactionBuilder(freshAccount, {
        fee: tx.fee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: invokeOp.func,
            auth: signedAuthEntries,
          })
        )
        .setTimeout(30)
        .build();

      const resimulated = await this.server.simulateTransaction(rebuiltTx);
      if (rpc.Api.isSimulationError(resimulated)) {
        return this.failure(`Simulation failed after attaching signatures: ${resimulated.error}`);
      }

      const prepared = rpc.assembleTransaction(rebuiltTx, resimulated).build();
      prepared.sign(submitterKeypair);
      return await this.sendAndPoll(prepared);
    } catch (error) {
      return this.failure((error as Error).message);
    }
  }

  /**
   * Admin refunds deposits for cancelled league.
   */
  public async refund(
    adminSecret: string,
    adminPublic: string,
    leagueId: number | bigint,
    participants: string[]
  ): Promise<InvocationResult> {
    return this.invoke(adminSecret, this.escrowContractId, "refund", [
      SorobanContractClient.address(adminPublic),
      SorobanContractClient.u64(leagueId),
      xdr.ScVal.scvVec(participants.map((p) => SorobanContractClient.address(p))),
    ]);
  }

  /**
   * Query on-chain league state.
   */
  public async getLeague(
    leagueId: number | bigint
  ): Promise<OnChainLeagueState | null> {
    const result = await this.simulateView(this.escrowContractId, "get_league", [
      SorobanContractClient.u64(leagueId),
    ]);
    if (!result.success || !result.returnValue) {
      return null;
    }

    const state = result.returnValue as Record<string, unknown>;
    return {
      creator: String(state.creator),
      entry_fee: BigInt(state.entry_fee as bigint),
      participant_count: Number(state.participant_count),
      status: Number(state.status),
      total_deposited: BigInt(state.total_deposited as bigint),
      token_address: state.token_address ? String(state.token_address) : (state.asset ? String(state.asset) : undefined),
      asset: state.asset ? String(state.asset) : (state.token_address ? String(state.token_address) : undefined),
    };
  }

  /**
   * Query on-chain participant deposit amount.
   */
  public async getDeposit(
    leagueId: number | bigint,
    participantPublic: string
  ): Promise<bigint> {
    const result = await this.simulateView(this.escrowContractId, "get_deposit", [
      SorobanContractClient.u64(leagueId),
      SorobanContractClient.address(participantPublic),
    ]);
    return result.success ? BigInt((result.returnValue as bigint) ?? 0) : 0n;
  }

  /**
   * Query USDC SAC balance for any account (or contract ID).
   */
  public async getTokenBalance(addressOrContractId: string): Promise<bigint> {
    const result = await this.simulateView(this.usdcContractId, "balance", [
      SorobanContractClient.address(addressOrContractId),
    ]);
    return result.success ? BigInt((result.returnValue as bigint) ?? 0) : 0n;
  }
}
