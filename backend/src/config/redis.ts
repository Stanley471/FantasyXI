import Redis, { Redis as RedisType } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

/**
 * Common cache client interface for Redis or mock implementations.
 */
export interface IRedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: any, duration?: any): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
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

/**
 * Creates a configured ioredis client instance.
 * Gracefully handles connection failures by preventing unhandled errors.
 */
export function createRedisClient(configOverride?: Partial<RedisConfig>): RedisType | null {
  const config = { ...getRedisConfig(), ...configOverride };

  if (!config.enabled) {
    return null;
  }

  const clientOptions: import("ioredis").RedisOptions = {
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
      if (!hasLoggedConnectionError) {
        console.warn(
          `[Redis] Connection warning: ${err.message}. Cache operations will gracefully fall back.`
        );
        hasLoggedConnectionError = true;
      }
    });

    client.on("connect", () => {
      hasLoggedConnectionError = false;
      console.log(
        `[Redis] Connected successfully to ${config.url || `${config.host}:${config.port}`}`
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
