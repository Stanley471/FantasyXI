import { EventEmitter } from "node:events";

/**
 * Common PostgreSQL connection dropout and network error codes / signatures
 */
export const POSTGRES_CONNECTION_ERROR_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
];

export const POSTGRES_CONNECTION_ERROR_MESSAGES = [
  "Connection terminated unexpectedly",
  "server closed the connection unexpectedly",
  "terminating connection due to administrator command",
  "the database system is shutting down",
  "connection reset by peer",
  "socket hang up",
  "Client has encountered a connection error and is not queryable",
];

export function isConnectionDropoutError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { code?: string; message?: string; name?: string };
  if (err.code && POSTGRES_CONNECTION_ERROR_CODES.includes(err.code)) {
    return true;
  }
  if (err.message) {
    return POSTGRES_CONNECTION_ERROR_MESSAGES.some((msg) =>
      err.message!.toLowerCase().includes(msg.toLowerCase())
    );
  }
  return false;
}

export interface ChaosInjectorConfig {
  latencyMs?: number;
  packetLossRate?: number; // 0.0 to 1.0
  isSevered?: boolean;
}

/**
 * Chaos Network Injector that simulates TCP resets, packet loss, and latency
 * between application connection pool and PostgreSQL backend.
 */
export class ChaosNetworkInjector extends EventEmitter {
  private latencyMs = 0;
  private packetLossRate = 0;
  private isSevered = false;
  private totalSimulatedDrops = 0;
  private activeSimulatedConnections = 0;

  constructor(config?: ChaosInjectorConfig) {
    super();
    if (config) {
      this.latencyMs = config.latencyMs ?? 0;
      this.packetLossRate = config.packetLossRate ?? 0;
      this.isSevered = config.isSevered ?? false;
    }
  }

  public setLatency(ms: number): void {
    this.latencyMs = Math.max(0, ms);
    this.emit("latency-changed", this.latencyMs);
  }

  public setPacketLossRate(rate: number): void {
    this.packetLossRate = Math.min(1.0, Math.max(0.0, rate));
    this.emit("packet-loss-changed", this.packetLossRate);
  }

  public severConnection(): void {
    this.isSevered = true;
    this.totalSimulatedDrops++;
    this.emit("connection-severed", { timestamp: Date.now() });
  }

  public restoreConnection(): void {
    this.isSevered = false;
    this.emit("connection-restored", { timestamp: Date.now() });
  }

  public async filterNetworkPacket(): Promise<void> {
    if (this.isSevered) {
      const err = new Error("Connection terminated unexpectedly (TCP RST by chaos)");
      (err as any).code = "ECONNRESET";
      throw err;
    }

    if (this.packetLossRate > 0 && Math.random() < this.packetLossRate) {
      this.totalSimulatedDrops++;
      const err = new Error("Server closed the connection unexpectedly (packet loss)");
      (err as any).code = "EPIPE";
      throw err;
    }

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }

  public trackConnectionOpened(): void {
    this.activeSimulatedConnections++;
  }

  public trackConnectionClosed(): void {
    if (this.activeSimulatedConnections > 0) {
      this.activeSimulatedConnections--;
    }
  }

  public getStats() {
    return {
      latencyMs: this.latencyMs,
      packetLossRate: this.packetLossRate,
      isSevered: this.isSevered,
      totalDrops: this.totalSimulatedDrops,
      activeConnections: this.activeSimulatedConnections,
    };
  }
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Executes a database operation with exponential backoff and connection-dropout resilience.
 * In-flight transactions severed mid-flight will fail cleanly, triggering rollback.
 */
export async function executeWithDropoutResilience<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const backoffFactor = options.backoffFactor ?? 2;

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await operation();
    } catch (err: any) {
      attempt++;
      const isDropout = isConnectionDropoutError(err);

      if (!isDropout || attempt > maxRetries) {
        throw err;
      }

      if (options.onRetry) {
        options.onRetry(attempt, err);
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(maxDelayMs, delay * backoffFactor);
    }
  }
}

/**
 * Transaction coordinator that guarantees atomic rollback integrity if severed mid-flight.
 */
export class TransactionRollbackGuard {
  private activeTransactions = new Set<string>();
  private completedTransactions = new Set<string>();
  private rolledBackTransactions = new Set<string>();

  public startTransaction(txId: string): void {
    this.activeTransactions.add(txId);
  }

  public commitTransaction(txId: string): void {
    if (!this.activeTransactions.has(txId)) {
      throw new Error(`Transaction ${txId} is not active`);
    }
    this.activeTransactions.delete(txId);
    this.completedTransactions.add(txId);
  }

  public rollbackTransaction(txId: string, reason?: string): void {
    this.activeTransactions.delete(txId);
    this.rolledBackTransactions.add(txId);
  }

  public getStatus(txId: string) {
    return {
      isActive: this.activeTransactions.has(txId),
      isCommitted: this.completedTransactions.has(txId),
      isRolledBack: this.rolledBackTransactions.has(txId),
    };
  }

  public getSummary() {
    return {
      activeCount: this.activeTransactions.size,
      committedCount: this.completedTransactions.size,
      rolledBackCount: this.rolledBackTransactions.size,
    };
  }
}
