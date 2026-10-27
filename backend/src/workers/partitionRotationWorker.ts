import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { prisma } from "../config/db.js";
import { logger } from "../config/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 32 * DAY_MS;
const TABLE = "contract_events";
const PARENT = `public.${TABLE}`;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export interface PartitionRotationOptions {
  db?: any;
  now?: () => Date;
  archiveDirectory?: string;
  archiveAfterDays?: number;
  precreateDays?: number;
  pollIntervalMs?: number;
}

/** Maintains monthly contract event partitions and compressed historical dumps. */
export class PartitionRotationWorker {
  private readonly db: any;
  private readonly now: () => Date;
  private readonly archiveDirectory: string | undefined;
  private readonly archiveAfterDays: number;
  private readonly precreateDays: number;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;

  constructor(options: PartitionRotationOptions = {}) {
    this.db = options.db ?? prisma;
    this.now = options.now ?? (() => new Date());
    this.archiveDirectory = options.archiveDirectory ?? process.env.PARTITION_ARCHIVE_DIR;
    this.archiveAfterDays = options.archiveAfterDays ?? 90;
    this.precreateDays = options.precreateDays ?? 14;
    this.pollIntervalMs = options.pollIntervalMs ?? 6 * 60 * 60 * 1000;
  }

  /** Creates all monthly ranges that begin within the preallocation window. */
  public async precreateUpcomingPartitions(): Promise<string[]> {
    const start = this.monthStart(this.now());
    const limit = new Date(this.now().getTime() + this.precreateDays * DAY_MS);
    const created: string[] = [];
    for (let month = start; month <= limit; month = this.addMonth(month)) {
      const next = this.addMonth(month);
      const name = this.partitionName(month);
      await this.db.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS public.${name} PARTITION OF ${PARENT} FOR VALUES FROM ('${this.date(month)}') TO ('${this.date(next)}')`
      );
      created.push(name);
    }
    return created;
  }

  /**
   * Archives fully expired monthly partitions. pg_dump -Fc produces a compressed,
   * portable archive; detach happens only after the dump has completed successfully.
   */
  public async archiveExpiredPartitions(): Promise<string[]> {
    if (!this.archiveDirectory) return [];
    const cutoff = new Date(this.now().getTime() - this.archiveAfterDays * DAY_MS);
    const partitions = await this.db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT child.relname AS name
       FROM pg_inherits i JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_namespace n ON n.oid = parent.relnamespace
       WHERE n.nspname = 'public' AND parent.relname = $1 AND child.relname <> $2
       ORDER BY child.relname`,
      TABLE,
      `${TABLE}_default`
    );
    const archived: string[] = [];
    await mkdir(this.archiveDirectory, { recursive: true });
    for (const { name } of partitions) {
      const match = new RegExp(`^${TABLE}_(\\d{4})_(\\d{2})$`).exec(name);
      if (!match || !IDENTIFIER.test(name)) continue;
      const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
      if (this.addMonth(month) > cutoff) continue;
      const path = join(this.archiveDirectory, `${name}.dump`);
      await this.dumpPartition(name, path);
      await this.db.$executeRawUnsafe(`ALTER TABLE ${PARENT} DETACH PARTITION public.${name} CONCURRENTLY`);
      archived.push(name);
    }
    return archived;
  }

  public async runOnce(): Promise<{ partitions: string[]; archived: string[] }> {
    if (this.inFlight) return { partitions: [], archived: [] };
    this.inFlight = true;
    try {
      const partitions = await this.precreateUpcomingPartitions();
      const archived = await this.archiveExpiredPartitions();
      return { partitions, archived };
    } finally {
      this.inFlight = false;
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      try {
        const result = await this.runOnce();
        logger.info({ ...result }, "Partition rotation completed");
      } catch (error) {
        logger.error({ err: error }, "Partition rotation failed");
      } finally {
        if (this.running) this.timer = setTimeout(tick, this.pollIntervalMs);
      }
    };
    void tick();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async dumpPartition(name: string, path: string): Promise<void> {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new Error("DATABASE_URL is required to archive partitions");
    await promisify((command: string, args: string[], callback: (error: Error | null) => void) => {
      const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
      child.once("error", callback);
      child.once("exit", (code) => callback(code === 0 ? null : new Error(`pg_dump exited with code ${code}`)));
    })(process.env.PG_DUMP_PATH || "pg_dump", ["--dbname", connection, "--format=custom", "--compress=9", "--table", `public.${name}`, "--file", path]);
  }

  private monthStart(date: Date): Date { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
  private addMonth(date: Date): Date { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)); }
  private date(date: Date): string { return date.toISOString().slice(0, 10); }
  private partitionName(date: Date): string { return `${TABLE}_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
}

export const partitionRotationWorker = new PartitionRotationWorker();
