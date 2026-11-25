import pg from "pg";
import logger from "../../config/logger.js";

export interface LeakedConnection {
  pid: number;
  idleSeconds: number;
  applicationName: string | null;
  clientAddress: string | null;
  query: string | null;
  transactionStartedAt: Date | null;
}

export class ConnectionLeakDetector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly thresholdSeconds = 30,
    private readonly intervalMs = 5_000,
  ) {}

  async sweep(): Promise<LeakedConnection[]> {
    const result = await this.pool.query<LeakedConnection>(`
      SELECT pid,
             EXTRACT(EPOCH FROM (clock_timestamp() - state_change))::float8 AS "idleSeconds",
             application_name AS "applicationName",
             client_addr::text AS "clientAddress",
             query,
             xact_start AS "transactionStartedAt"
        FROM pg_stat_activity
       WHERE state = 'idle in transaction'
         AND pid <> pg_backend_pid()
         AND clock_timestamp() - state_change > ($1 * interval '1 second')
    `, [this.thresholdSeconds]);

    for (const connection of result.rows) {
      const terminated = await this.pool.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1) AS terminated",
        [connection.pid],
      );
      logger.warn({
        event: "database_connection_leak_terminated",
        ...connection,
        terminated: terminated.rows[0]?.terminated ?? false,
        detectorStack: new Error("Idle transaction termination callsite").stack,
      }, "Terminated idle-in-transaction PostgreSQL backend");
    }
    return result.rows;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.sweep()
        .catch((error) => logger.error({ error }, "Database connection leak sweep failed"))
        .finally(() => { this.running = false; });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pool.end();
  }
}

export function createConnectionLeakDetector(): ConnectionLeakDetector | null {
  if (!process.env.DATABASE_URL || process.env.DB_LEAK_DETECTOR_ENABLED === "false") return null;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: "fantasyxi-leak-detector" });
  return new ConnectionLeakDetector(
    pool,
    Number(process.env.DB_IDLE_TRANSACTION_THRESHOLD_SECONDS ?? 30),
    Number(process.env.DB_LEAK_DETECTOR_INTERVAL_MS ?? 5_000),
  );
}
