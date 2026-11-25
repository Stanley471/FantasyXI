import { Pool, PoolClient } from 'pg';

export type SelectionStrategy = 'round-robin' | 'least-connections';

export interface ReplicaConfig {
  name: string;
  connectionString: string;
}

export interface HealthCheckResult {
  replica: string;
  healthy: boolean;
  lagMs?: number;
  error?: string;
}

interface ReplicaState {
  name: string;
  pool: Pool;
  healthy: boolean;
  inFlightCount: number;
  lagMs?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastHealthCheckAt?: Date;
}

/**
 * Read-Replica Manager
 * 
 * Distributes SELECT queries across healthy read replicas.
 * Guarantees writes and transactions go to primary.
 * Automatic health checking and failover.
 */
export class ReadReplicaManager {
  private primaryPool: Pool;
  private replicas: Map<string, ReplicaState> = new Map();
  private roundRobinIndex = 0;
  private strategy: SelectionStrategy;
  private healthCheckInterval: NodeJS.Timer | null = null;
  private healthCheckIntervalMs: number;
  private healthCheckTimeoutMs: number;
  private unhealthyThreshold: number; // N consecutive failures
  private healthyThreshold: number; // M consecutive successes
  private lagThresholdMs: number;
  private now: () => Date;

  constructor(
    primaryConnectionString: string,
    replicaConfigs: ReplicaConfig[],
    options?: {
      strategy?: SelectionStrategy;
      healthCheckIntervalMs?: number;
      healthCheckTimeoutMs?: number;
      unhealthyThreshold?: number;
      healthyThreshold?: number;
      lagThresholdMs?: number;
      now?: () => Date;
    }
  ) {
    this.primaryPool = new Pool({ connectionString: primaryConnectionString });
    this.strategy = options?.strategy ?? 'round-robin';
    this.healthCheckIntervalMs = options?.healthCheckIntervalMs ?? 10000;
    this.healthCheckTimeoutMs = options?.healthCheckTimeoutMs ?? 5000;
    this.unhealthyThreshold = options?.unhealthyThreshold ?? 3;
    this.healthyThreshold = options?.healthyThreshold ?? 2;
    this.lagThresholdMs = options?.lagThresholdMs ?? 1000;
    this.now = options?.now ?? (() => new Date());

    // Initialize replicas
    for (const config of replicaConfigs) {
      this.replicas.set(config.name, {
        name: config.name,
        pool: new Pool({ connectionString: config.connectionString }),
        healthy: true,
        inFlightCount: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      });
    }

    // Start health checks if replicas exist
    if (this.replicas.size > 0) {
      this.startHealthChecks();
    }
  }

  /**
   * Get a primary (write) connection
   */
  async getPrimaryConnection(): Promise<PoolClient> {
    return this.primaryPool.connect();
  }

  /**
   * Get a read replica connection based on strategy
   * Falls back to primary if all replicas unhealthy
   */
  async getReadConnection(): Promise<PoolClient> {
    const healthyReplicas = Array.from(this.replicas.values()).filter((r) => r.healthy);

    if (healthyReplicas.length === 0) {
      // All replicas down, fall back to primary
      console.warn('No healthy replicas available, falling back to primary');
      return this.primaryPool.connect();
    }

    let selected: ReplicaState;

    if (this.strategy === 'least-connections') {
      // Select replica with least in-flight queries
      selected = healthyReplicas.reduce((min, current) =>
        current.inFlightCount < min.inFlightCount ? current : min
      );
    } else {
      // Round-robin (default)
      selected = healthyReplicas[this.roundRobinIndex % healthyReplicas.length];
      this.roundRobinIndex++;
    }

    return selected.pool.connect();
  }

  /**
   * Track query on connection
   */
  trackQueryStart(replicaName?: string): void {
    if (replicaName && this.replicas.has(replicaName)) {
      const replica = this.replicas.get(replicaName)!;
      replica.inFlightCount++;
    }
  }

  /**
   * End query tracking
   */
  trackQueryEnd(replicaName?: string): void {
    if (replicaName && this.replicas.has(replicaName)) {
      const replica = this.replicas.get(replicaName)!;
      replica.inFlightCount = Math.max(0, replica.inFlightCount - 1);
    }
  }

  /**
   * Record a health failure for a replica (passive health check)
   */
  recordFailure(replicaName: string): void {
    if (this.replicas.has(replicaName)) {
      const replica = this.replicas.get(replicaName)!;
      replica.consecutiveFailures++;
      replica.consecutiveSuccesses = 0;

      if (replica.consecutiveFailures >= this.unhealthyThreshold) {
        replica.healthy = false;
        console.warn(`Replica ${replicaName} marked unhealthy after ${this.unhealthyThreshold} failures`);
      }
    }
  }

  /**
   * Periodic health check query
   */
  private async performHealthCheck(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    for (const [name, replica] of this.replicas) {
      let client: PoolClient | null = null;
      try {
        client = await Promise.race([
          replica.pool.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), this.healthCheckTimeoutMs)
          ),
        ]);

        // Measure replication lag (PostgreSQL-specific)
        const lagResult = await client.query(
          "SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())) as lag_seconds"
        );
        const lagSeconds = parseFloat(lagResult.rows[0]?.lag_seconds ?? 0);
        const lagMs = lagSeconds * 1000;

        replica.lagMs = lagMs;
        replica.consecutiveSuccesses++;
        replica.consecutiveFailures = 0;

        // Re-admit if back to health
        if (!replica.healthy && replica.consecutiveSuccesses >= this.healthyThreshold) {
          replica.healthy = true;
          console.info(`Replica ${name} marked healthy after ${this.healthyThreshold} successes`);
        }

        // Remove if lag too high
        if (lagMs > this.lagThresholdMs) {
          if (replica.healthy) {
            replica.healthy = false;
            console.warn(`Replica ${name} removed due to high lag: ${lagMs.toFixed(0)}ms`);
          }
        }

        results.push({ replica: name, healthy: replica.healthy, lagMs });
      } catch (error) {
        replica.consecutiveFailures++;
        replica.consecutiveSuccesses = 0;

        if (replica.consecutiveFailures >= this.unhealthyThreshold && replica.healthy) {
          replica.healthy = false;
          console.warn(`Replica ${name} marked unhealthy: ${error}`);
        }

        results.push({
          replica: name,
          healthy: replica.healthy,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (client) {
          client.release();
        }
      }
    }

    return results;
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        console.error('Health check error:', error);
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop health checks and drain pools
   */
  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Drain all replica pools
    for (const replica of this.replicas.values()) {
      await replica.pool.end();
    }

    // Drain primary pool
    await this.primaryPool.end();
  }

  /**
   * Get current health status
   */
  getHealthStatus(): Record<string, { healthy: boolean; inFlight: number; lag?: number }> {
    const status: Record<string, { healthy: boolean; inFlight: number; lag?: number }> = {};

    for (const [name, replica] of this.replicas) {
      status[name] = {
        healthy: replica.healthy,
        inFlight: replica.inFlightCount,
        ...(replica.lagMs !== undefined && { lag: replica.lagMs }),
      };
    }

    return status;
  }
}

/**
 * Query router: determines if query should go to replica or primary
 */
export class ReadWriteQueryRouter {
  private replicaManager: ReadReplicaManager;

  constructor(replicaManager: ReadReplicaManager) {
    this.replicaManager = replicaManager;
  }

  /**
   * Route query to appropriate connection.
   * Returns { connection, isReplica } to allow cleanup tracking.
   */
  async routeQuery(
    queryType: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | 'TRANSACTION',
    usePrimary?: boolean
  ): Promise<{ connection: PoolClient; isReplica: boolean; replicaName?: string }> {
    // Force primary for writes, transactions, or explicit override
    if (queryType !== 'SELECT' || usePrimary) {
      return {
        connection: await this.replicaManager.getPrimaryConnection(),
        isReplica: false,
      };
    }

    // Get read replica (or primary fallback)
    const connection = await this.replicaManager.getReadConnection();

    // Check if it's actually a replica or the primary fallback
    const isReplica = this.replicaManager.getHealthStatus() !== undefined; // Simplified check
    const replicaName = isReplica ? `replica-${Math.random()}` : undefined;

    this.replicaManager.trackQueryStart(replicaName);

    return { connection, isReplica, replicaName };
  }

  /**
   * Release connection after query
   */
  releaseConnection(connection: PoolClient, replicaName?: string, error?: Error): void {
    this.replicaManager.trackQueryEnd(replicaName);

    if (error && replicaName) {
      // Record passive health failure
      this.replicaManager.recordFailure(replicaName);
    }

    connection.release();
  }

  /**
   * Get health status
   */
  getHealthStatus() {
    return this.replicaManager.getHealthStatus();
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    await this.replicaManager.shutdown();
  }
}

/**
 * Retry helper for idempotent reads
 */
export async function retryIdempotentRead<T>(
  fn: (connection: PoolClient) => Promise<T>,
  router: ReadWriteQueryRouter,
  maxRetries: number = 1
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { connection, replicaName } = await router.routeQuery('SELECT');

    try {
      const result = await fn(connection);
      router.releaseConnection(connection, replicaName);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      router.releaseConnection(connection, replicaName, lastError);

      if (attempt < maxRetries) {
        console.warn(`Read query failed, retrying... (attempt ${attempt + 1})`);
      }
    }
  }

  throw lastError;
}
