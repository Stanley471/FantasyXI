/**
 * Soroban Contract & Storage State Archival TTL Extension Worker (Issue #548)
 *
 * Automatically monitors Time-To-Live (TTL) ledger boundaries for active Soroban
 * smart contracts (escrow instances and persistent storage entries).
 *
 * When remaining TTL drops below 100,000 ledgers (safe boundary), it generates
 * and broadcasts an `Operation.extendFootprintTtl` transaction sponsored by the
 * platform maintenance keypair, bumping TTL up to the maximum boundary (~518,400 ledgers).
 *
 * Logs all TTL extension operations, transaction hashes, and gas consumption.
 */

import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { logger } from "../config/logger.js";
import { prisma } from "../config/db.js";
import { stellarConfig } from "../config/stellar.js";

export const SOROBAN_TTL_EXTENSION_JOB_NAME = "soroban-ttl-extension";
/** Runs twice daily (every 12 hours) to proactively prevent archival. */
export const SOROBAN_TTL_EXTENSION_CRON = "0 */12 * * *";

/** Critical threshold: < 100,000 ledgers triggers automated bump (approx. 5.8 days at 5s/ledger) */
export const CRITICAL_TTL_THRESHOLD_LEDGERS = 100_000;
/** Default extension boundary: 518,400 ledgers (approx. 30 days) */
export const DEFAULT_EXTEND_TO_LEDGERS = 518_400;

export interface TtlInspectionEntry {
  contractId: string;
  keyXdr: string;
  currentLedgerSeq: number;
  liveUntilLedgerSeq: number;
  remainingTtlLedgers: number;
  needsBump: boolean;
}

export interface TtlBumpLog {
  contractId: string;
  keyXdr: string;
  previousRemainingTtl: number;
  extendedByLedgers: number;
  txHash: string;
  gasFeeStroops: number;
  timestamp: string;
}

export interface TtlWorkerSummary {
  inspectedCount: number;
  bumpedCount: number;
  skippedCount: number;
  operations: TtlBumpLog[];
  errors: string[];
}

export interface TtlWorkerDependencies {
  db?: any;
  server?: any;
  maintenanceKeypair?: Keypair;
  networkPassphrase?: string;
  ttlThreshold?: number;
  extendToLedgers?: number;
}

export class SorobanTtlExtensionWorker {
  private readonly db: any;
  private readonly server: any;
  private readonly maintenanceKeypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly ttlThreshold: number;
  private readonly extendToLedgers: number;

  constructor(deps: TtlWorkerDependencies = {}) {
    this.db = deps.db ?? prisma;
    this.networkPassphrase = deps.networkPassphrase ?? stellarConfig.networkPassphrase ?? Networks.TESTNET;
    this.ttlThreshold = deps.ttlThreshold ?? CRITICAL_TTL_THRESHOLD_LEDGERS;
    this.extendToLedgers = deps.extendToLedgers ?? DEFAULT_EXTEND_TO_LEDGERS;

    if (deps.maintenanceKeypair) {
      this.maintenanceKeypair = deps.maintenanceKeypair;
    } else {
      const secret =
        process.env.STELLAR_MAINTENANCE_SECRET ||
        process.env.STELLAR_SPONSOR_SECRET ||
        process.env.STELLAR_ISSUER_SECRET ||
        Keypair.random().secret();
      this.maintenanceKeypair = Keypair.fromSecret(secret);
    }

    if (deps.server) {
      this.server = deps.server;
    } else {
      const rpcUrl =
        process.env.STELLAR_SOROBAN_RPC_URL ||
        process.env.SOROBAN_RPC_URL ||
        "https://soroban-testnet.stellar.org";
      this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    }
  }

  /**
   * Derives persistent contract instance LedgerKey.
   */
  public getContractInstanceLedgerKey(contractId: string): xdr.LedgerKey {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      })
    );
  }

  /**
   * Retrieves target contract addresses from active leagues and configuration.
   */
  public async getTargetContractAddresses(): Promise<string[]> {
    const contracts = new Set<string>();

    if (process.env.STELLAR_ESCROW_CONTRACT_ID) {
      contracts.add(process.env.STELLAR_ESCROW_CONTRACT_ID);
    }

    try {
      if (this.db?.league?.findMany) {
        const activeLeagues = await this.db.league.findMany({
          where: {
            status: { in: ["UPCOMING", "ACTIVE"] },
            contractAddress: { not: null },
          },
          select: { contractAddress: true },
        });
        for (const l of activeLeagues) {
          if (l.contractAddress) contracts.add(l.contractAddress);
        }
      }
    } catch (err) {
      logger.warn(`[ttl-extension] Could not query active leagues from db: ${(err as Error).message}`);
    }

    return Array.from(contracts);
  }

  /**
   * Inspects TTL of a specific contract key via Soroban RPC.
   */
  public async inspectEntryTtl(
    contractId: string,
    key: xdr.LedgerKey
  ): Promise<TtlInspectionEntry> {
    const keyXdr = key.toXDR("base64");
    const latestLedger = await this.server.getLatestLedger();
    const currentLedgerSeq = latestLedger.sequence;

    const response = await this.server.getLedgerEntries(key);
    const entries = response.entries || [];

    if (entries.length === 0) {
      return {
        contractId,
        keyXdr,
        currentLedgerSeq,
        liveUntilLedgerSeq: 0,
        remainingTtlLedgers: 0,
        needsBump: true,
      };
    }

    const entry = entries[0];
    const liveUntil = entry.liveUntilLedgerSeq ?? currentLedgerSeq;
    const remaining = Math.max(0, liveUntil - currentLedgerSeq);

    return {
      contractId,
      keyXdr,
      currentLedgerSeq,
      liveUntilLedgerSeq: liveUntil,
      remainingTtlLedgers: remaining,
      needsBump: remaining < this.ttlThreshold,
    };
  }

  /**
   * Builds, signs, and executes extendFootprintTtl transaction.
   */
  public async executeExtendTtl(
    keys: xdr.LedgerKey[],
    extendByLedgers: number
  ): Promise<{ success: boolean; txHash?: string; gasFeeStroops: number; error?: string }> {
    try {
      const sourceAccount = await this.server.getAccount(this.maintenanceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: (100 * parseInt(BASE_FEE, 10)).toString(),
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.extendFootprintTtl({
            extendTo: extendByLedgers,
            source: this.maintenanceKeypair.publicKey(),
          })
        )
        .setTimeout(30)
        .build();

      tx.sign(this.maintenanceKeypair);
      const sendResponse = await this.server.sendTransaction(tx);

      if (sendResponse.status === "ERROR") {
        return {
          success: false,
          gasFeeStroops: 0,
          error: `RPC rejected extend TTL transaction: ${JSON.stringify(sendResponse.errorResult)}`,
        };
      }

      const txHash = sendResponse.hash;
      const gasFeeStroops = parseInt(tx.fee, 10) || 10000;

      return {
        success: true,
        txHash,
        gasFeeStroops,
      };
    } catch (err) {
      return {
        success: false,
        gasFeeStroops: 0,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Executes the automated scan and extension cycle.
   */
  public async run(): Promise<TtlWorkerSummary> {
    const summary: TtlWorkerSummary = {
      inspectedCount: 0,
      bumpedCount: 0,
      skippedCount: 0,
      operations: [],
      errors: [],
    };

    const contracts = await this.getTargetContractAddresses();
    if (contracts.length === 0) {
      logger.info("[ttl-extension] No contract addresses configured or active to inspect.");
      return summary;
    }

    for (const contractId of contracts) {
      try {
        summary.inspectedCount++;
        const key = this.getContractInstanceLedgerKey(contractId);
        const inspection = await this.inspectEntryTtl(contractId, key);

        if (inspection.needsBump) {
          logger.info(
            `[ttl-extension] Contract ${contractId} has ${inspection.remainingTtlLedgers} ledgers remaining (< ${this.ttlThreshold}). Executing TTL bump...`
          );

          const bumpResult = await this.executeExtendTtl([key], this.extendToLedgers);

          if (bumpResult.success && bumpResult.txHash) {
            summary.bumpedCount++;
            const logEntry: TtlBumpLog = {
              contractId,
              keyXdr: inspection.keyXdr,
              previousRemainingTtl: inspection.remainingTtlLedgers,
              extendedByLedgers: this.extendToLedgers,
              txHash: bumpResult.txHash,
              gasFeeStroops: bumpResult.gasFeeStroops,
              timestamp: new Date().toISOString(),
            };
            summary.operations.push(logEntry);
            logger.info(
              `[ttl-extension] Successfully bumped TTL for ${contractId}. Tx: ${bumpResult.txHash}, Gas: ${bumpResult.gasFeeStroops} stroops`
            );
          } else {
            const err = `Failed to bump TTL for contract ${contractId}: ${bumpResult.error}`;
            summary.errors.push(err);
            logger.error(`[ttl-extension] ${err}`);
          }
        } else {
          summary.skippedCount++;
          logger.debug(
            `[ttl-extension] Contract ${contractId} is healthy with ${inspection.remainingTtlLedgers} ledgers remaining.`
          );
        }
      } catch (err) {
        const errMsg = `Error inspecting contract ${contractId}: ${(err as Error).message}`;
        summary.errors.push(errMsg);
        logger.error(`[ttl-extension] ${errMsg}`);
      }
    }

    return summary;
  }
}

/** Singleton instance */
export const sorobanTtlExtensionWorker = new SorobanTtlExtensionWorker();

/** pg-boss job handler entry point */
export async function runSorobanTtlExtensionJob(): Promise<TtlWorkerSummary> {
  return sorobanTtlExtensionWorker.run();
}
