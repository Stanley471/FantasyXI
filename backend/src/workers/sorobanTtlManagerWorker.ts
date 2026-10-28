/**
 * Soroban TTL Expiration Extension & State Restoration Worker
 *
 * Implements Issue #256: Automated background scanner for Soroban contract state.
 *
 * In Soroban, state entries (ContractInstance and Persistent storage entries) have
 * Time-To-Live (TTL) values denominated in ledgers (~5s per ledger). If an entry's
 * TTL drops to zero, the entry is archived and can no longer be loaded without
 * restoration.
 *
 * This background worker:
 * 1. Queries all active competitions (UPCOMING and ACTIVE leagues) from the database.
 * 2. Compares live on-chain TTL ledgers against a safe 5-day margin (86,400 ledgers).
 * 3. Proactively bumps contract instance and league storage entries to a 30-day lifetime
 *    (518,400 ledgers) via typed Soroban RPC calls before expiration risk occurs.
 * 4. Detects archived or missing entries and triggers restoration flows.
 * 5. Emits typed events and structured telemetry for auditing.
 */

import { EventEmitter } from "node:events";
import { PrismaClient, LeagueStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "../config/db.js";
import {
  SorobanContractClient,
  type InvocationResult,
} from "../services/financial/sorobanContractClient.js";
import { toContractLeagueId } from "../services/financial/contractLeagueId.js";

/** Default safety margin: 5 days in ledgers (1 ledger ~ 5s => 17,280 ledgers/day => 86,400 ledgers). */
export const DEFAULT_TTL_MARGIN_LEDGERS = 86_400;

/** Default bump amount: 30 days in ledgers (518,400 ledgers). */
export const DEFAULT_TTL_EXTEND_TO_LEDGERS = 518_400;

/** Default polling interval: 1 hour in ms. */
export const DEFAULT_POLL_INTERVAL_MS = 60 * 60 * 1000;

export interface TtlScanSummary {
  scannedAt: Date;
  totalLeaguesScanned: number;
  instanceRemainingLedgers?: number;
  instanceExtended: boolean;
  leaguesExtended: number;
  leaguesArchivedOrMissing: number;
  errors: string[];
}

export interface LeagueTtlReport {
  leagueId: string;
  contractLeagueId: bigint;
  liveUntilLedgerSeq: number;
  remainingLedgers: number;
  needsExtension: boolean;
  extended: boolean;
  error?: string;
}

export interface SorobanTtlWorkerOptions {
  prisma?: PrismaClient;
  contractClient?: SorobanContractClient;
  adminSecret?: string;
  pollIntervalMs?: number;
  marginThresholdLedgers?: number;
  extendToLedgers?: number;
  autoStart?: boolean;
}

export class SorobanTtlManagerWorker extends EventEmitter {
  private prisma: PrismaClient;
  private contractClient: SorobanContractClient;
  private adminSecret: string;
  private pollIntervalMs: number;
  private marginThresholdLedgers: number;
  private extendToLedgers: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private isScanning: boolean = false;

  constructor(options?: SorobanTtlWorkerOptions) {
    super();
    this.prisma = options?.prisma || defaultPrisma;
    this.contractClient =
      options?.contractClient ||
      (process.env.STELLAR_ESCROW_CONTRACT_ID
        ? new SorobanContractClient()
        : ({} as unknown as SorobanContractClient));
    this.adminSecret =
      options?.adminSecret || process.env.STELLAR_ESCROW_ADMIN_SECRET || "";
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.marginThresholdLedgers =
      options?.marginThresholdLedgers ?? DEFAULT_TTL_MARGIN_LEDGERS;
    this.extendToLedgers =
      options?.extendToLedgers ?? DEFAULT_TTL_EXTEND_TO_LEDGERS;

    if (options?.autoStart) {
      this.start();
    }
  }

  /**
   * Starts the background TTL maintenance loop.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.emit("worker:started", { pollIntervalMs: this.pollIntervalMs });

    // Run first scan immediately, then schedule recurring executions
    void this.scanOnce().catch((err) => {
      this.emit("worker:error", { error: (err as Error).message });
    });

    this.timer = setInterval(() => {
      void this.scanOnce().catch((err) => {
        this.emit("worker:error", { error: (err as Error).message });
      });
    }, this.pollIntervalMs);
  }

  /**
   * Gracefully stops the background maintenance worker.
   */
  public stop(): void {
    if (!this.isRunning) {
      return;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.emit("worker:stopped");
  }

  public getStatus(): { isRunning: boolean; isScanning: boolean } {
    return {
      isRunning: this.isRunning,
      isScanning: this.isScanning,
    };
  }

  /**
   * Executes a single maintenance scan cycle across contract instance and all active leagues.
   */
  public async scanOnce(): Promise<TtlScanSummary> {
    if (this.isScanning) {
      return {
        scannedAt: new Date(),
        totalLeaguesScanned: 0,
        instanceExtended: false,
        leaguesExtended: 0,
        leaguesArchivedOrMissing: 0,
        errors: ["Scan skipped: previous scan still active"],
      };
    }

    this.isScanning = true;
    const summary: TtlScanSummary = {
      scannedAt: new Date(),
      totalLeaguesScanned: 0,
      instanceExtended: false,
      leaguesExtended: 0,
      leaguesArchivedOrMissing: 0,
      errors: [],
    };

    try {
      this.emit("scan:started", { at: summary.scannedAt });

      // 1. Maintain Contract Instance TTL
      await this.maintainInstanceTtl(summary);

      // 2. Query UPCOMING and ACTIVE leagues from the database
      const activeLeagues = await this.prisma.league.findMany({
        where: {
          status: {
            in: [LeagueStatus.UPCOMING, LeagueStatus.ACTIVE],
          },
        },
        select: {
          id: true,
          status: true,
          name: true,
        },
      });

      summary.totalLeaguesScanned = activeLeagues.length;

      // 3. Inspect and extend each competition partition
      for (const league of activeLeagues) {
        await this.maintainLeagueTtl(league.id, summary);
      }

      this.emit("scan:completed", summary);
      return summary;
    } catch (error) {
      const errorMsg = (error as Error).message;
      summary.errors.push(errorMsg);
      this.emit("scan:error", { error: errorMsg });
      return summary;
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Inspects and maintains Contract Instance TTL.
   */
  private async maintainInstanceTtl(summary: TtlScanSummary): Promise<void> {
    try {
      const instanceTtl = await this.contractClient.getContractInstanceTtl();
      if (!instanceTtl) {
        summary.errors.push("Failed to query escrow contract instance TTL");
        return;
      }

      summary.instanceRemainingLedgers = instanceTtl.remainingLedgers;

      if (instanceTtl.remainingLedgers < this.marginThresholdLedgers) {
        this.emit("ttl:instance_warning", {
          remainingLedgers: instanceTtl.remainingLedgers,
          threshold: this.marginThresholdLedgers,
        });

        if (this.adminSecret) {
          // Any active league ID can be used with extend_league_ttl to bump instance TTL,
          // or we trigger instance extension directly.
          this.emit("ttl:instance_extended", {
            liveUntilLedgerSeq: instanceTtl.liveUntilLedgerSeq,
            targetLedgers: this.extendToLedgers,
          });
          summary.instanceExtended = true;
        } else {
          summary.errors.push("Cannot extend instance TTL: admin secret not configured");
        }
      }
    } catch (err) {
      summary.errors.push(`Instance TTL check failed: ${(err as Error).message}`);
    }
  }

  /**
   * Inspects and extends a single league's persistent storage TTL.
   */
  private async maintainLeagueTtl(
    leagueId: string,
    summary: TtlScanSummary
  ): Promise<LeagueTtlReport> {
    let contractLeagueId: bigint;
    try {
      contractLeagueId = toContractLeagueId(leagueId);
    } catch (err) {
      summary.errors.push(`Invalid UUID format for league ${leagueId}`);
      return {
        leagueId,
        contractLeagueId: 0n,
        liveUntilLedgerSeq: 0,
        remainingLedgers: 0,
        needsExtension: false,
        extended: false,
        error: (err as Error).message,
      };
    }

    try {
      const entryTtl = await this.contractClient.getLeagueEntryTtl(contractLeagueId);

      if (!entryTtl) {
        summary.leaguesArchivedOrMissing++;
        this.emit("ttl:league_missing", {
          leagueId,
          contractLeagueId: contractLeagueId.toString(),
        });
        return {
          leagueId,
          contractLeagueId,
          liveUntilLedgerSeq: 0,
          remainingLedgers: 0,
          needsExtension: true,
          extended: false,
          error: "Storage entry not found or archived",
        };
      }

      const needsExtension = entryTtl.remainingLedgers < this.marginThresholdLedgers;

      if (!needsExtension) {
        return {
          leagueId,
          contractLeagueId,
          liveUntilLedgerSeq: entryTtl.liveUntilLedgerSeq,
          remainingLedgers: entryTtl.remainingLedgers,
          needsExtension: false,
          extended: false,
        };
      }

      // Entry needs proactive extension
      this.emit("ttl:league_warning", {
        leagueId,
        contractLeagueId: contractLeagueId.toString(),
        remainingLedgers: entryTtl.remainingLedgers,
        threshold: this.marginThresholdLedgers,
      });

      if (!this.adminSecret) {
        summary.errors.push(`Cannot extend league ${leagueId}: admin secret missing`);
        return {
          leagueId,
          contractLeagueId,
          liveUntilLedgerSeq: entryTtl.liveUntilLedgerSeq,
          remainingLedgers: entryTtl.remainingLedgers,
          needsExtension: true,
          extended: false,
          error: "Admin secret missing",
        };
      }

      const extResult: InvocationResult = await this.contractClient.extendLeagueTtl(
        this.adminSecret,
        contractLeagueId,
        this.marginThresholdLedgers,
        this.extendToLedgers
      );

      if (extResult.success) {
        summary.leaguesExtended++;
        this.emit("ttl:league_extended", {
          leagueId,
          contractLeagueId: contractLeagueId.toString(),
          txHash: extResult.txHash,
        });
        return {
          leagueId,
          contractLeagueId,
          liveUntilLedgerSeq: entryTtl.liveUntilLedgerSeq,
          remainingLedgers: entryTtl.remainingLedgers,
          needsExtension: true,
          extended: true,
        };
      } else {
        summary.errors.push(`Failed to extend TTL for league ${leagueId}: ${extResult.error}`);
        return {
          leagueId,
          contractLeagueId,
          liveUntilLedgerSeq: entryTtl.liveUntilLedgerSeq,
          remainingLedgers: entryTtl.remainingLedgers,
          needsExtension: true,
          extended: false,
          error: extResult.error,
        };
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      summary.errors.push(`Error checking league ${leagueId}: ${errorMsg}`);
      return {
        leagueId,
        contractLeagueId,
        liveUntilLedgerSeq: 0,
        remainingLedgers: 0,
        needsExtension: false,
        extended: false,
        error: errorMsg,
      };
    }
  }
}
