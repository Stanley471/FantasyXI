import { SorobanContractClient, type InvocationResult } from "../services/financial/sorobanContractClient.js";

/** Soroban ledger constants matching `contracts/src/lib.rs` */
export const DAY_IN_LEDGERS = 17_280;
export const FIVE_DAYS_TTL_SAFETY_THRESHOLD_LEDGERS = 5 * DAY_IN_LEDGERS; // 86,400 ledgers (~5 days)
export const CONTRACT_LIFETIME_THRESHOLD_LEDGERS = 14 * DAY_IN_LEDGERS; // 241,920 ledgers (~14 days)
export const CONTRACT_BUMP_TARGET_LEDGERS = 30 * DAY_IN_LEDGERS; // 518,400 ledgers (~30 days)

export interface ManagedLeagueRecord {
  id: string;
  onChainLeagueId: number | bigint;
  status: "UPCOMING" | "ACTIVE" | "SETTLED" | "CANCELLED";
  participantCount?: number;
}

export interface TtlAlertPayload {
  severity: "WARNING" | "CRITICAL";
  leagueId: string;
  onChainLeagueId: string;
  remainingLedgers?: number;
  message: string;
  txHash?: string;
}

export interface SorobanTtlWorkerMetrics {
  scansCompleted: number;
  leaguesInspected: number;
  ttlBumpsTriggered: number;
  restorationsTriggered: number;
  participantPagesBumped: number;
  rpcErrors: number;
  lastRunAt: Date | null;
}

export interface SorobanTtlScanReport {
  inspectedCount: number;
  bumpedLeagues: string[];
  restoredLeagues: string[];
  failedLeagues: Array<{ leagueId: string; error: string }>;
  alerts: TtlAlertPayload[];
}

export interface SorobanTtlManagerOptions {
  contractClient: Pick<
    SorobanContractClient,
    "inspectLeagueTtl" | "extendLeagueTtl" | "extendParticipantPageTtl"
  >;
  signerSecret: string;
  fetchActiveLeagues: () => Promise<ManagedLeagueRecord[]>;
  safetyThresholdLedgers?: number;
  bumpTargetLedgers?: number;
  intervalMs?: number;
  participantsPerPage?: number;
  onAlert?: (alert: TtlAlertPayload) => void | Promise<void>;
}

/**
 * Background daemon that periodically scans all UPCOMING and ACTIVE leagues,
 * inspects their Soroban ledger entry TTLs via RPC simulation, and automatically
 * restores archived footprints or extends TTLs when within the 5-day safety threshold.
 */
export class SorobanTtlManagerWorker {
  private readonly client: SorobanTtlManagerOptions["contractClient"];
  private readonly signerSecret: string;
  private readonly fetchActiveLeagues: () => Promise<ManagedLeagueRecord[]>;
  private readonly safetyThresholdLedgers: number;
  private readonly bumpTargetLedgers: number;
  private readonly intervalMs: number;
  private readonly participantsPerPage: number;
  private readonly onAlert?: (alert: TtlAlertPayload) => void | Promise<void>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunningCycle = false;

  private metrics: SorobanTtlWorkerMetrics = {
    scansCompleted: 0,
    leaguesInspected: 0,
    ttlBumpsTriggered: 0,
    restorationsTriggered: 0,
    participantPagesBumped: 0,
    rpcErrors: 0,
    lastRunAt: null,
  };

  constructor(options: SorobanTtlManagerOptions) {
    this.client = options.contractClient;
    this.signerSecret = options.signerSecret;
    this.fetchActiveLeagues = options.fetchActiveLeagues;
    this.safetyThresholdLedgers =
      options.safetyThresholdLedgers ?? FIVE_DAYS_TTL_SAFETY_THRESHOLD_LEDGERS;
    this.bumpTargetLedgers = options.bumpTargetLedgers ?? CONTRACT_BUMP_TARGET_LEDGERS;
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000; // Default: hourly
    this.participantsPerPage = options.participantsPerPage ?? 50;
    this.onAlert = options.onAlert;
  }

  public getMetrics(): SorobanTtlWorkerMetrics {
    return { ...this.metrics };
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async emitAlert(alert: TtlAlertPayload, bucket: TtlAlertPayload[]): Promise<void> {
    bucket.push(alert);
    if (this.onAlert) {
      await this.onAlert(alert);
    }
  }

  /**
   * Executes a single inspection and TTL bump pass across all UPCOMING and ACTIVE leagues.
   */
  public async runOnce(): Promise<SorobanTtlScanReport> {
    if (this.isRunningCycle) {
      return {
        inspectedCount: 0,
        bumpedLeagues: [],
        restoredLeagues: [],
        failedLeagues: [],
        alerts: [],
      };
    }

    this.isRunningCycle = true;
    const report: SorobanTtlScanReport = {
      inspectedCount: 0,
      bumpedLeagues: [],
      restoredLeagues: [],
      failedLeagues: [],
      alerts: [],
    };

    try {
      const leagues = await this.fetchActiveLeagues();
      const eligible = leagues.filter(
        (lg) => lg.status === "UPCOMING" || lg.status === "ACTIVE"
      );

      for (const league of eligible) {
        report.inspectedCount += 1;
        this.metrics.leaguesInspected += 1;

        try {
          const ttlInfo = await this.client.inspectLeagueTtl(league.onChainLeagueId);

          if (ttlInfo.error) {
            this.metrics.rpcErrors += 1;
            report.failedLeagues.push({ leagueId: league.id, error: ttlInfo.error });
            await this.emitAlert(
              {
                severity: "CRITICAL",
                leagueId: league.id,
                onChainLeagueId: String(league.onChainLeagueId),
                message: `Soroban RPC TTL inspection failed for league ${league.id}: ${ttlInfo.error}`,
              },
              report.alerts
            );
            continue;
          }

          const isBelowSafetyMargin =
            ttlInfo.needsRestore ||
            (ttlInfo.remainingLedgers !== undefined &&
              ttlInfo.remainingLedgers <= this.safetyThresholdLedgers);

          if (!isBelowSafetyMargin) {
            continue;
          }

          await this.emitAlert(
            {
              severity: ttlInfo.needsRestore ? "CRITICAL" : "WARNING",
              leagueId: league.id,
              onChainLeagueId: String(league.onChainLeagueId),
              remainingLedgers: ttlInfo.remainingLedgers,
              message: ttlInfo.needsRestore
                ? `League ${league.id} Soroban state is archived; initiating footprint restoration and TTL extension`
                : `League ${league.id} Soroban TTL (${ttlInfo.remainingLedgers} ledgers) is within safety threshold (${this.safetyThresholdLedgers}); bumping to ${this.bumpTargetLedgers}`,
            },
            report.alerts
          );

          const bumpRes: InvocationResult = await this.client.extendLeagueTtl(
            this.signerSecret,
            league.onChainLeagueId,
             CONTRACT_LIFETIME_THRESHOLD_LEDGERS,
            this.bumpTargetLedgers
          );

          if (!bumpRes.success) {
            this.metrics.rpcErrors += 1;
            const errMsg = bumpRes.error || "Unknown TTL extension failure";
            report.failedLeagues.push({ leagueId: league.id, error: errMsg });
            await this.emitAlert(
              {
                severity: "CRITICAL",
                leagueId: league.id,
                onChainLeagueId: String(league.onChainLeagueId),
                remainingLedgers: ttlInfo.remainingLedgers,
                message: `Failed to extend Soroban TTL for league ${league.id}: ${errMsg}`,
              },
              report.alerts
            );
            continue;
          }

          this.metrics.ttlBumpsTriggered += 1;
          report.bumpedLeagues.push(league.id);
          if (ttlInfo.needsRestore) {
            this.metrics.restorationsTriggered += 1;
            report.restoredLeagues.push(league.id);
          }

          // Also bump any allocated participant pages for this league
          const participantCount = league.participantCount ?? 0;
          if (participantCount > 0) {
            const pageCount = Math.floor((participantCount - 1) / this.participantsPerPage) + 1;
            for (let page = 0; page < pageCount; page++) {
              const pageRes = await this.client.extendParticipantPageTtl(
                this.signerSecret,
                league.onChainLeagueId,
                page,
                CONTRACT_LIFETIME_THRESHOLD_LEDGERS,
                this.bumpTargetLedgers
              );
              if (pageRes.success) {
                this.metrics.participantPagesBumped += 1;
              }
            }
          }
        } catch (err) {
          this.metrics.rpcErrors += 1;
          const message = err instanceof Error ? err.message : String(err);
          report.failedLeagues.push({ leagueId: league.id, error: message });
          await this.emitAlert(
            {
              severity: "CRITICAL",
              leagueId: league.id,
              onChainLeagueId: String(league.onChainLeagueId),
              message: `Unexpected error bumping TTL for league ${league.id}: ${message}`,
            },
            report.alerts
          );
        }
      }

      this.metrics.scansCompleted += 1;
      this.metrics.lastRunAt = new Date();
      return report;
    } finally {
      this.isRunningCycle = false;
    }
  }
}
