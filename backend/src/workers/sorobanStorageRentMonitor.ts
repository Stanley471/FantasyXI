/**
 * Background Storage Rent Monitor & Automated Archival Recovery Daemon
 *
 * Periodically invokes SorobanStateArchivalRecoveryService to:
 * 1. Inspect entry TTLs and prevent state archival.
 * 2. Execute automated footprint extension and restoration.
 * 3. Alert platform maintainers when rent reserves drop below safe bounds.
 */

import {
  SorobanStateArchivalRecoveryService,
  ArchivalRecoveryReport,
} from "../services/financial/sorobanStateArchivalRecovery.js";

export class SorobanStorageRentMonitorDaemon {
  private service: SorobanStateArchivalRecoveryService;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private adminSecretKey: string;
  private monitoredContractIds: string[];
  private lastReport: ArchivalRecoveryReport | null = null;

  constructor(options?: {
    service?: SorobanStateArchivalRecoveryService;
    intervalMs?: number;
    adminSecretKey?: string;
    monitoredContractIds?: string[];
  }) {
    this.service = options?.service || new SorobanStateArchivalRecoveryService();
    this.intervalMs =
      options?.intervalMs ??
      Number(process.env.SOROBAN_RENT_MONITOR_INTERVAL_MS || "60000");
    this.adminSecretKey =
      options?.adminSecretKey ||
      process.env.STELLAR_ADMIN_SECRET ||
      "";
    this.monitoredContractIds = options?.monitoredContractIds || [];
  }

  public getLastReport(): ArchivalRecoveryReport | null {
    return this.lastReport;
  }

  public async tick(): Promise<ArchivalRecoveryReport | null> {
    if (this.isProcessing) return null;
    this.isProcessing = true;

    try {
      if (!this.adminSecretKey) {
        console.warn(
          "[soroban-rent-monitor] STELLAR_ADMIN_SECRET not set, performing read-only inspection."
        );
        const { currentLedger, entries } =
          await this.service.inspectContractEntries(this.monitoredContractIds);
        const reserves = await this.service.inspectRentReserves(
          this.monitoredContractIds
        );
        const report: ArchivalRecoveryReport = {
          timestamp: new Date(),
          currentLedger,
          inspectedEntries: entries,
          entriesNeedingExtend: entries.filter((e) => e.status === "NEEDS_EXTEND"),
          entriesNeedingRestore: entries.filter((e) => e.status === "ARCHIVED"),
          extendedCount: 0,
          restoredCount: 0,
          extendTxHashes: [],
          restoreTxHashes: [],
          rentReserveStatuses: reserves,
          errors: ["No admin secret key configured for automated transaction execution."],
        };
        this.lastReport = report;
        return report;
      }

      const report = await this.service.runRecoveryCycle(
        this.adminSecretKey,
        this.monitoredContractIds
      );
      this.lastReport = report;

      if (report.extendedCount > 0 || report.restoredCount > 0) {
        console.info(
          `[soroban-rent-monitor] Recovery cycle completed: extended ${report.extendedCount} entries, restored ${report.restoredCount} entries.`
        );
      }

      return report;
    } catch (error) {
      console.error("[soroban-rent-monitor] Error during monitor tick:", error);
      return null;
    } finally {
      this.isProcessing = false;
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.info(
      `[soroban-rent-monitor] Started background rent monitor (interval: ${this.intervalMs}ms)`
    );

    // Initial tick
    void this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.info("[soroban-rent-monitor] Stopped background rent monitor.");
  }
}
