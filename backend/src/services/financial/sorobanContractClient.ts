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
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

// Load testnet deployment configuration
const envTestnetPath = path.resolve(process.cwd(), ".env.testnet.local");
if (fs.existsSync(envTestnetPath)) {
  dotenv.config({ path: envTestnetPath });
}

/** Well-known empty account used as the source of read-only simulations. */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface OnChainLeagueState {
  creator: string;
  entry_fee: bigint;
  participant_count: number;
  status: number; // 0 = Upcoming, 1 = Active, 2 = Settled, 3 = Cancelled
  total_deposited: bigint;
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
}

export class SorobanContractClient {
  private server: rpc.Server;
  private networkPassphrase: string;
  private escrowContractId: string;
  private usdcContractId: string;
  private pollIntervalMs: number;
  private maxPollAttempts: number;

  constructor(options?: {
    rpcUrl?: string;
    networkPassphrase?: string;
    escrowContractId?: string;
    usdcContractId?: string;
    server?: rpc.Server;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
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

    if (!this.escrowContractId) {
      throw new Error("STELLAR_ESCROW_CONTRACT_ID not provided or set in environment.");
    }
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
    return {
      success: false,
      txHash,
      error,
      contractErrorCode: SorobanContractClient.parseContractErrorCode(error),
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
  private async sendAndPoll(tx: Transaction): Promise<InvocationResult> {
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR" || sent.status === "DUPLICATE") {
      return this.failure(
        `Transaction rejected (${sent.status}): ${sent.errorResult?.toXDR("base64") ?? "unknown"}`,
        sent.hash
      );
    }

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      const result = await this.server.getTransaction(sent.hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          success: true,
          txHash: sent.hash,
          ledgerSeq: result.ledger,
          returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined,
        };
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        return this.failure(
          `Transaction failed: ${result.resultXdr.toXDR("base64")}`,
          sent.hash
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    return this.failure(`Transaction ${sent.hash} not confirmed in time`, sent.hash);
  }

  /**
   * Restores archived ledger entries reported by a simulation (Operation.restoreFootprint).
   */
  private async restoreFootprint(
    keypair: Keypair,
    restorePreamble: { minResourceFee: string; transactionData: { build(): xdr.SorobanTransactionData } }
  ): Promise<InvocationResult> {
    const account = await this.server.getAccount(keypair.publicKey());
    const restoreTx = new TransactionBuilder(account, {
      fee: (Number(BASE_FEE) + Number(restorePreamble.minResourceFee)).toString(),
      networkPassphrase: this.networkPassphrase,
    })
      .setSorobanData(restorePreamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(30)
      .build();
    restoreTx.sign(keypair);
    return this.sendAndPoll(restoreTx);
  }

  /**
   * Full RPC pipeline for a state-changing contract call.
   */
  public async invoke(
    sourceSecret: string,
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<InvocationResult> {
    try {
      const keypair = Keypair.fromSecret(sourceSecret);

      let account = await this.server.getAccount(keypair.publicKey());
      let tx = this.buildInvocation(account, contractId, method, args);
      let simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        return this.failure(`Simulation failed: ${simulation.error}`);
      }

      if (rpc.Api.isSimulationRestore(simulation)) {
        const restored = await this.restoreFootprint(keypair, simulation.restorePreamble);
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
      return await this.sendAndPoll(prepared);
    } catch (error) {
      return this.failure((error as Error).message);
    }
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

  /**
   * Admin settles the league with winner payouts and platform treasury fee.
   */
  public async settle(
    adminSecret: string,
    adminPublic: string,
    leagueId: number | bigint,
    winners: WinnerPayoutParam[],
    platformTreasury: string,
    platformFeeStroops: bigint
  ): Promise<InvocationResult> {
    // WinnerPayout struct -> ScMap with keys in lexicographic order
    const winnersScVal = xdr.ScVal.scvVec(
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

    return this.invoke(adminSecret, this.escrowContractId, "settle", [
      SorobanContractClient.address(adminPublic),
      SorobanContractClient.u64(leagueId),
      winnersScVal,
      SorobanContractClient.address(platformTreasury),
      SorobanContractClient.i128(platformFeeStroops),
    ]);
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
