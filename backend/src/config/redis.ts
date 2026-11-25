import { Redis, type Redis as RedisType, type RedisOptions } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

/**
 * Common cache client interface for Redis or mock implementations.
 */
export interface IRedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  eval?(...args: any[]): Promise<unknown>;
  status?: string;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface RedisConfig {
  url?: string;
  host: string;
  port: number;
  password?: string;
  enabled: boolean;
}

export function getRedisConfig(): RedisConfig {
  const url = process.env.REDIS_URL;
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const port = parseInt(process.env.REDIS_PORT || "6379", 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const enabled = process.env.REDIS_ENABLED !== "false";

  return { url, host, port, password, enabled };
}

let redisInstance: RedisType | null = null;
let hasLoggedConnectionError = false;

// ─── Circuit breaker (#432) ───────────────────────────────────────────────────

type CircuitState = "closed" | "open" | "half-open";

const circuit = {
  state: "closed" as CircuitState,
  failures: 0,
  lastFailureAt: 0,
  /** Consecutive failures before opening the circuit. */
  threshold: Number(process.env.REDIS_CB_THRESHOLD ?? 5),
  /** Milliseconds the circuit stays open before moving to half-open. */
  resetMs: Number(process.env.REDIS_CB_RESET_MS ?? 10_000),
};

/** True when the circuit is open and callers should use the in-memory fallback. */
export function isRedisCircuitOpen(): boolean {
  if (circuit.state === "closed") return false;
  if (circuit.state === "open") {
    if (Date.now() - circuit.lastFailureAt >= circuit.resetMs) {
      circuit.state = "half-open";
      return false; // allow one probe
    }
    return true;
  }
  return false; // half-open: allow probe
}

export function recordRedisSuccess(): void {
  circuit.failures = 0;
  circuit.state = "closed";
}

export function recordRedisFailure(): void {
  circuit.failures += 1;
  circuit.lastFailureAt = Date.now();
  if (circuit.failures >= circuit.threshold) {
    if (circuit.state !== "open") {
      console.warn(
        `[Redis] Circuit breaker OPEN after ${circuit.failures} failures (#432)`,
      );
    }
    circuit.state = "open";
  }
}

export function getRedisCircuitState(): CircuitState {
  return circuit.state;
}

/**
 * Creates a configured ioredis client instance.
 * Gracefully handles connection failures by preventing unhandled errors.
 */
export function createRedisClient(
  configOverride?: Partial<RedisConfig>,
): RedisType | null {
  const config = { ...getRedisConfig(), ...configOverride };

  if (!config.enabled) {
    return null;
  }

  const clientOptions: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 3) {
        return null; // Stop retrying after 3 attempts
      }
      return Math.min(times * 500, 2000);
    },
  };

  try {
    const client = config.url
      ? new Redis(config.url, clientOptions)
      : new Redis({
          host: config.host,
          port: config.port,
          password: config.password,
          ...clientOptions,
        });

    client.on("error", (err: Error) => {
      recordRedisFailure();
      if (!hasLoggedConnectionError) {
        console.warn(
          `[Redis] Connection warning: ${err.message}. Cache operations will gracefully fall back.`,
        );
        hasLoggedConnectionError = true;
      }
    });

    client.on("connect", () => {
      recordRedisSuccess();
      hasLoggedConnectionError = false;
      console.log(
        `[Redis] Connected successfully to ${config.url || `${config.host}:${config.port}`}`,
      );
    });

    return client;
  } catch (err) {
    console.warn("[Redis] Failed to initialize client:", err);
    return null;
  }
}

/**
 * Returns the singleton Redis client instance or null if Redis is disabled.
 */
export function getRedisClient(): RedisType | null {
  if (!redisInstance) {
    redisInstance = createRedisClient();
  }
  return redisInstance;
}

/**
 * Safely closes the singleton Redis client instance.
 */
export async function closeRedisClient(): Promise<void> {
  if (redisInstance) {
    try {
      await redisInstance.quit();
    } catch {
      redisInstance.disconnect();
    } finally {
      redisInstance = null;
      hasLoggedConnectionError = false;
    }
  }
}

export type { RedisType as RedisClient };
