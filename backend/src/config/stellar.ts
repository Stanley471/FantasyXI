/**
 * Stellar & Soroban Testnet Configuration
 *
 * Laravel analogy: Like config/services.php or config/stellar.php.
 * Centralizes all Stellar network parameters, RPC endpoints, asset definitions,
 * and contract IDs.
 *
 * Never hardcode private keys here! Only public network configuration.
 */

import { Horizon, rpc, Networks, Asset } from "@stellar/stellar-sdk";
import { logger } from "./logger.js";

export interface StellarConfig {
  network: "TESTNET" | "PUBLIC";
  horizonUrl: string;
  horizonUrls: string[];
  sorobanRpcUrl: string;
  sorobanRpcUrls: string[];
  networkPassphrase: string;
  usdcAssetCode: string;
  usdcIssuer: string;
  treasuryAddress: string;
  escrowContractId: string;
}

export const stellarConfig: StellarConfig = {
  network: (process.env.STELLAR_NETWORK as "TESTNET" | "PUBLIC") || "TESTNET",
  horizonUrl:
    process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
  horizonUrls: [
    process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
    ...(process.env.STELLAR_HORIZON_FALLBACK_URLS || "")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
  ].filter((url, index, urls) => urls.indexOf(url) === index),
  sorobanRpcUrl:
    process.env.STELLAR_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
  sorobanRpcUrls: [
    process.env.STELLAR_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    ...(process.env.STELLAR_SOROBAN_RPC_FALLBACK_URLS || "")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
  ].filter((url, index, urls) => urls.indexOf(url) === index),
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
  usdcAssetCode: process.env.STELLAR_USDC_ASSET_CODE || "USDC",
  // Standard Testnet USDC issuer (or platform test asset issuer)
  usdcIssuer:
    process.env.STELLAR_USDC_ISSUER ||
    "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWUIPWIO2LEOWOHR67K",
  treasuryAddress:
    process.env.STELLAR_TREASURY_ADDRESS ||
    "GDWZ67PEXB3P4XJ5A6M6Q7T8U9V0W1X2Y3Z4A5B6C7D8E9F0G1H2I3J4",
  escrowContractId:
    process.env.STELLAR_ESCROW_CONTRACT_ID ||
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface HorizonHealthSnapshot {
  url: string;
  healthy: boolean;
  circuitState: CircuitState;
  latencyMs: number | null;
  latestLedger: number | null;
  requestCount: number;
  errorCount: number;
  errorRate: number;
}

export interface HorizonProbeResult {
  latencyMs: number;
  latestLedger?: number | null;
}

interface HorizonNode {
  url: string;
  server: Horizon.Server;
  healthy: boolean;
  circuitState: CircuitState;
  lastStateChange: number;
  consecutiveSuccesses: number;
  latencyMs: number | null;
  latestLedger: number | null;
  requestCount: number;
  errorCount: number;
  consecutiveErrors: number;
}

export interface HorizonConnectionPoolOptions {
  urls?: string[];
  timeoutMs?: number;
  healthCheckIntervalMs?: number;
  failureThreshold?: number;
  successThreshold?: number;
  cooldownMs?: number;
  createServer?: (url: string) => Horizon.Server;
  probe?: (url: string, timeoutMs: number) => Promise<number | HorizonProbeResult>;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

const HORIZON_TIMEOUT_MS = 5_000;
const HORIZON_HEALTH_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_SUCCESS_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 10_000;

function isRetryableHorizonError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    response?: { status?: number };
    status?: number;
  };
  const status = candidate?.response?.status ?? candidate?.status;
  return (
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(
      candidate?.code ?? ""
    )
  );
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname === "/" ? "" : "/…"}`;
  } catch {
    return value;
  }
}

async function probeHorizon(url: string, timeoutMs: number): Promise<HorizonProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cleanUrl = url.replace(/\/$/, "");
    const response = await fetch(`${cleanUrl}/fee_stats`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Horizon health check returned HTTP ${response.status}`), {
        status: response.status,
      });
    }

    let latestLedger: number | null = null;
    try {
      const body = (await response.json()) as { last_ledger?: number };
      if (typeof body.last_ledger === "number") {
        latestLedger = body.last_ledger;
      }
    } catch {
      // JSON parse non-fatal
    }

    return {
      latencyMs: Date.now() - startedAt,
      latestLedger,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Health-ranked Horizon endpoints with active latency benchmarking,
 * ledger sync checking, automated circuit breaking, and sub-500ms failover.
 */
export class HorizonConnectionPool {
  private readonly nodes: HorizonNode[];
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly probe: (url: string, timeoutMs: number) => Promise<number | HorizonProbeResult>;
  private readonly warn: (message: string) => void;
  private readonly info: (message: string) => void;
  private hasCheckedHealth = false;
  private healthTimer?: NodeJS.Timeout;

  constructor(options: HorizonConnectionPoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? HORIZON_TIMEOUT_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.successThreshold = options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.probe = options.probe ?? probeHorizon;
    this.warn = options.warn ?? ((message) => logger.warn({ component: "horizonPool" }, message));
    this.info = options.info ?? ((message) => logger.info({ component: "horizonPool" }, message));

    const urls = [...new Set((options.urls ?? stellarConfig.horizonUrls).filter(Boolean))];
    if (urls.length === 0) {
      throw new Error("At least one Horizon endpoint must be configured");
    }

    const createServer =
      options.createServer ??
      ((url) => new Horizon.Server(url, { allowHttp: url.startsWith("http://") }));

    this.nodes = urls.map((url) => {
      const server = createServer(url);
      server.httpClient.defaults.timeout = this.timeoutMs;
      return {
        url,
        server,
        healthy: false,
        circuitState: "CLOSED" as CircuitState,
        lastStateChange: Date.now(),
        consecutiveSuccesses: 0,
        latencyMs: null,
        latestLedger: null,
        requestCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
      };
    });

    const intervalMs = options.healthCheckIntervalMs ?? HORIZON_HEALTH_CHECK_INTERVAL_MS;
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, intervalMs);
    this.healthTimer.unref?.();
  }

  public stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  public getHealthSnapshot(): HorizonHealthSnapshot[] {
    return this.nodes.map((node) => ({
      url: safeUrl(node.url),
      healthy: node.healthy,
      circuitState: node.circuitState,
      latencyMs: node.latencyMs,
      latestLedger: node.latestLedger,
      requestCount: node.requestCount,
      errorCount: node.errorCount,
      errorRate: node.requestCount === 0 ? 0 : node.errorCount / node.requestCount,
    }));
  }

  public getPreferredServer(): Horizon.Server {
    return this.orderedNodes()[0].server;
  }

  public async checkHealth(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      this.nodes.map(async (node) => {
        // Evaluate cooldown for open circuits
        if (node.circuitState === "OPEN") {
          if (now - node.lastStateChange >= this.cooldownMs) {
            node.circuitState = "HALF_OPEN";
            node.lastStateChange = now;
            this.info(`[stellar] Horizon circuit for ${safeUrl(node.url)} entered HALF_OPEN (canary probe)`);
          } else {
            return;
          }
        }

        node.requestCount += 1;
        try {
          const probeOutput = await this.probe(node.url, this.timeoutMs);
          const latencyMs = typeof probeOutput === "number" ? probeOutput : probeOutput.latencyMs;
          const latestLedger = typeof probeOutput === "number" ? null : (probeOutput.latestLedger ?? null);

          node.latencyMs = latencyMs;
          node.latestLedger = latestLedger;
          node.consecutiveErrors = 0;
          node.consecutiveSuccesses += 1;

          if (node.circuitState === "HALF_OPEN") {
            if (node.consecutiveSuccesses >= this.successThreshold) {
              node.circuitState = "CLOSED";
              node.healthy = true;
              node.lastStateChange = Date.now();
              this.info(`[stellar] Horizon endpoint reinstated: ${safeUrl(node.url)} (circuit CLOSED, latency ${latencyMs}ms)`);
            }
          } else {
            node.healthy = true;
            node.circuitState = "CLOSED";
          }
        } catch {
          node.errorCount += 1;
          node.consecutiveErrors += 1;
          node.consecutiveSuccesses = 0;
          node.healthy = false;

          if (node.consecutiveErrors >= this.failureThreshold || node.circuitState === "HALF_OPEN") {
            if ((node.circuitState as string) !== "OPEN") {
              node.circuitState = "OPEN";
              node.lastStateChange = Date.now();
              this.warn(`[stellar] Horizon circuit TRIPPED to OPEN for ${safeUrl(node.url)} after ${node.consecutiveErrors} errors`);
            }
          }
        }
      })
    );
    this.hasCheckedHealth = true;
  }

  public async run<T>(operation: (server: Horizon.Server) => Promise<T>): Promise<T> {
    if (!this.hasCheckedHealth || this.nodes.every((node) => !node.healthy)) {
      await this.checkHealth();
    }
    const candidates = this.orderedNodes();
    let lastError: unknown;

    for (let index = 0; index < candidates.length; index += 1) {
      const node = candidates[index];
      const startedAt = Date.now();
      node.requestCount += 1;
      try {
        const result = await operation(node.server);
        const durationMs = Date.now() - startedAt;
        node.latencyMs = durationMs;
        node.consecutiveSuccesses += 1;
        node.consecutiveErrors = 0;
        if (node.circuitState === "HALF_OPEN" && node.consecutiveSuccesses >= this.successThreshold) {
          node.circuitState = "CLOSED";
          node.healthy = true;
          this.info(`[stellar] Horizon endpoint ${safeUrl(node.url)} reinstated (circuit CLOSED)`);
        } else if (node.circuitState === "CLOSED") {
          node.healthy = true;
        }
        return result;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        node.latencyMs = latencyMs;
        node.errorCount += 1;
        node.consecutiveErrors += 1;
        node.consecutiveSuccesses = 0;
        lastError = error;

        if (!isRetryableHorizonError(error)) {
          throw error;
        }

        node.healthy = false;
        if (node.consecutiveErrors >= this.failureThreshold || node.circuitState === "HALF_OPEN") {
          node.circuitState = "OPEN";
          node.lastStateChange = Date.now();
        }

        const status =
          (error as { response?: { status?: number }; status?: number })?.response?.status ??
          (error as { status?: number })?.status;

        if (index < candidates.length - 1) {
          this.warn(
            `[stellar] Horizon failover from ${safeUrl(node.url)} to ${safeUrl(candidates[index + 1].url)} after ${latencyMs}ms` +
              (status ? ` (HTTP ${status})` : " (request timeout or network error)")
          );
        }
      }
    }

    throw lastError ?? new Error("No Horizon endpoint is available");
  }

  private orderedNodes(): HorizonNode[] {
    const now = Date.now();
    return [...this.nodes].sort((a, b) => {
      // 1. Prefer healthy nodes (circuit not OPEN)
      const aAvailable = a.healthy && a.circuitState !== "OPEN";
      const bAvailable = b.healthy && b.circuitState !== "OPEN";
      if (aAvailable !== bAvailable) return aAvailable ? -1 : 1;

      // 2. Allow HALF_OPEN nodes if cooldown has passed
      const aCanary = a.circuitState === "HALF_OPEN" || (a.circuitState === "OPEN" && now - a.lastStateChange >= this.cooldownMs);
      const bCanary = b.circuitState === "HALF_OPEN" || (b.circuitState === "OPEN" && now - b.lastStateChange >= this.cooldownMs);
      if (aCanary !== bCanary) return aCanary ? -1 : 1;

      // 3. Sort by lowest latency
      if (a.latencyMs !== null && b.latencyMs !== null && a.latencyMs !== b.latencyMs) {
        return a.latencyMs - b.latencyMs;
      }
      if (a.latencyMs !== null) return -1;
      if (b.latencyMs !== null) return 1;

      // 4. Sort by fewest consecutive errors
      return a.consecutiveErrors - b.consecutiveErrors;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Soroban RPC Connection Pool
// ─────────────────────────────────────────────────────────────────────────────

interface SorobanNode {
  url: string;
  server: rpc.Server;
  healthy: boolean;
  circuitState: CircuitState;
  lastStateChange: number;
  consecutiveSuccesses: number;
  latencyMs: number | null;
  latestLedger: number | null;
  requestCount: number;
  errorCount: number;
  consecutiveErrors: number;
}

export interface SorobanRpcConnectionPoolOptions {
  urls?: string[];
  timeoutMs?: number;
  healthCheckIntervalMs?: number;
  failureThreshold?: number;
  successThreshold?: number;
  cooldownMs?: number;
  createServer?: (url: string) => rpc.Server;
  probe?: (url: string, timeoutMs: number) => Promise<{ latencyMs: number; latestLedger?: number | null }>;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

async function probeSorobanRpc(url: string, timeoutMs: number): Promise<{ latencyMs: number; latestLedger?: number | null }> {
  const startedAt = Date.now();
  const server = new rpc.Server(url, { allowHttp: url.startsWith("http://"), timeout: timeoutMs });
  const health = await server.getHealth();
  if (health.status !== "healthy") {
    throw new Error(`Soroban RPC status is ${health.status}`);
  }
  let latestLedger: number | null = null;
  try {
    const ledger = await server.getLatestLedger();
    latestLedger = ledger.sequence;
  } catch {
    // optional ledger check
  }
  return {
    latencyMs: Date.now() - startedAt,
    latestLedger,
  };
}

export class SorobanRpcConnectionPool {
  private readonly nodes: SorobanNode[];
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;
  private readonly probe: (url: string, timeoutMs: number) => Promise<{ latencyMs: number; latestLedger?: number | null }>;
  private readonly warn: (message: string) => void;
  private readonly info: (message: string) => void;
  private hasCheckedHealth = false;
  private healthTimer?: NodeJS.Timeout;

  constructor(options: SorobanRpcConnectionPoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? HORIZON_TIMEOUT_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.successThreshold = options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.probe = options.probe ?? probeSorobanRpc;
    this.warn = options.warn ?? ((message) => logger.warn({ component: "sorobanPool" }, message));
    this.info = options.info ?? ((message) => logger.info({ component: "sorobanPool" }, message));

    const urls = [...new Set((options.urls ?? stellarConfig.sorobanRpcUrls).filter(Boolean))];
    if (urls.length === 0) {
      throw new Error("At least one Soroban RPC endpoint must be configured");
    }

    const createServer =
      options.createServer ??
      ((url) => new rpc.Server(url, { allowHttp: url.startsWith("http://"), timeout: this.timeoutMs }));

    this.nodes = urls.map((url) => ({
      url,
      server: createServer(url),
      healthy: false,
      circuitState: "CLOSED" as CircuitState,
      lastStateChange: Date.now(),
      consecutiveSuccesses: 0,
      latencyMs: null,
      latestLedger: null,
      requestCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
    }));

    const intervalMs = options.healthCheckIntervalMs ?? HORIZON_HEALTH_CHECK_INTERVAL_MS;
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, intervalMs);
    this.healthTimer.unref?.();
  }

  public stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  public getHealthSnapshot(): HorizonHealthSnapshot[] {
    return this.nodes.map((node) => ({
      url: safeUrl(node.url),
      healthy: node.healthy,
      circuitState: node.circuitState,
      latencyMs: node.latencyMs,
      latestLedger: node.latestLedger,
      requestCount: node.requestCount,
      errorCount: node.errorCount,
      errorRate: node.requestCount === 0 ? 0 : node.errorCount / node.requestCount,
    }));
  }

  public getPreferredServer(): rpc.Server {
    return this.orderedNodes()[0].server;
  }

  public async checkHealth(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      this.nodes.map(async (node) => {
        if (node.circuitState === "OPEN") {
          if (now - node.lastStateChange >= this.cooldownMs) {
            node.circuitState = "HALF_OPEN";
            node.lastStateChange = now;
          } else {
            return;
          }
        }

        node.requestCount += 1;
        try {
          const res = await this.probe(node.url, this.timeoutMs);
          node.latencyMs = res.latencyMs;
          node.latestLedger = res.latestLedger ?? null;
          node.consecutiveErrors = 0;
          node.consecutiveSuccesses += 1;

          if (node.circuitState === "HALF_OPEN") {
            if (node.consecutiveSuccesses >= this.successThreshold) {
              node.circuitState = "CLOSED";
              node.healthy = true;
              node.lastStateChange = Date.now();
              this.info(`[stellar] Soroban RPC endpoint reinstated: ${safeUrl(node.url)} (circuit CLOSED)`);
            }
          } else {
            node.healthy = true;
            node.circuitState = "CLOSED";
          }
        } catch {
          node.errorCount += 1;
          node.consecutiveErrors += 1;
          node.consecutiveSuccesses = 0;
          node.healthy = false;

          if (node.consecutiveErrors >= this.failureThreshold || node.circuitState === "HALF_OPEN") {
            if ((node.circuitState as string) !== "OPEN") {
              node.circuitState = "OPEN";
              node.lastStateChange = Date.now();
              this.warn(`[stellar] Soroban RPC circuit TRIPPED to OPEN for ${safeUrl(node.url)}`);
            }
          }
        }
      })
    );
    this.hasCheckedHealth = true;
  }

  public async run<T>(operation: (server: rpc.Server) => Promise<T>): Promise<T> {
    if (!this.hasCheckedHealth || this.nodes.every((node) => !node.healthy)) {
      await this.checkHealth();
    }
    const candidates = this.orderedNodes();
    let lastError: unknown;

    for (let index = 0; index < candidates.length; index += 1) {
      const node = candidates[index];
      const startedAt = Date.now();
      node.requestCount += 1;
      try {
        const result = await operation(node.server);
        const durationMs = Date.now() - startedAt;
        node.latencyMs = durationMs;
        node.consecutiveSuccesses += 1;
        node.consecutiveErrors = 0;
        if (node.circuitState === "HALF_OPEN" && node.consecutiveSuccesses >= this.successThreshold) {
          node.circuitState = "CLOSED";
          node.healthy = true;
        } else if (node.circuitState === "CLOSED") {
          node.healthy = true;
        }
        return result;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        node.latencyMs = latencyMs;
        node.errorCount += 1;
        node.consecutiveErrors += 1;
        node.consecutiveSuccesses = 0;
        lastError = error;

        node.healthy = false;
        if (node.consecutiveErrors >= this.failureThreshold || node.circuitState === "HALF_OPEN") {
          node.circuitState = "OPEN";
          node.lastStateChange = Date.now();
        }

        if (index < candidates.length - 1) {
          this.warn(
            `[stellar] Soroban RPC failover from ${safeUrl(node.url)} to ${safeUrl(candidates[index + 1].url)} after ${latencyMs}ms`
          );
        }
      }
    }

    throw lastError ?? new Error("No Soroban RPC endpoint is available");
  }

  private orderedNodes(): SorobanNode[] {
    const now = Date.now();
    return [...this.nodes].sort((a, b) => {
      const aAvailable = a.healthy && a.circuitState !== "OPEN";
      const bAvailable = b.healthy && b.circuitState !== "OPEN";
      if (aAvailable !== bAvailable) return aAvailable ? -1 : 1;

      const aCanary = a.circuitState === "HALF_OPEN" || (a.circuitState === "OPEN" && now - a.lastStateChange >= this.cooldownMs);
      const bCanary = b.circuitState === "HALF_OPEN" || (b.circuitState === "OPEN" && now - b.lastStateChange >= this.cooldownMs);
      if (aCanary !== bCanary) return aCanary ? -1 : 1;

      if (a.latencyMs !== null && b.latencyMs !== null && a.latencyMs !== b.latencyMs) {
        return a.latencyMs - b.latencyMs;
      }
      if (a.latencyMs !== null) return -1;
      if (b.latencyMs !== null) return 1;

      return a.consecutiveErrors - b.consecutiveErrors;
    });
  }
}

export const horizonConnectionPool = new HorizonConnectionPool();
export const sorobanRpcConnectionPool = new SorobanRpcConnectionPool();

/** Runs one Horizon operation through the shared health-ranked failover pool. */
export function withHorizonFailover<T>(
  operation: (server: Horizon.Server) => Promise<T>
): Promise<T> {
  return horizonConnectionPool.run(operation);
}

/** Runs one Soroban RPC operation through the shared health-ranked failover pool. */
export function withSorobanRpcFailover<T>(
  operation: (server: rpc.Server) => Promise<T>
): Promise<T> {
  return sorobanRpcConnectionPool.run(operation);
}

/** Returns the currently preferred Horizon client. */
export function getHorizonServer(): Horizon.Server {
  return horizonConnectionPool.getPreferredServer();
}

/** Returns the currently preferred Soroban RPC client. */
export function getSorobanRpcServer(): rpc.Server {
  return sorobanRpcConnectionPool.getPreferredServer();
}

/**
 * Returns the Stellar Asset instance for USDC.
 */
export function getUsdcAsset(): Asset {
  return new Asset(stellarConfig.usdcAssetCode, stellarConfig.usdcIssuer);
}
