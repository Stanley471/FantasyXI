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

export interface StellarConfig {
  network: "TESTNET" | "PUBLIC";
  horizonUrl: string;
  horizonUrls: string[];
  sorobanRpcUrl: string;
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

export interface HorizonHealthSnapshot {
  url: string;
  healthy: boolean;
  latencyMs: number | null;
  requestCount: number;
  errorCount: number;
  errorRate: number;
}

interface HorizonNode {
  url: string;
  server: Horizon.Server;
  healthy: boolean;
  latencyMs: number | null;
  requestCount: number;
  errorCount: number;
  consecutiveErrors: number;
}

interface HorizonConnectionPoolOptions {
  urls?: string[];
  timeoutMs?: number;
  healthCheckIntervalMs?: number;
  createServer?: (url: string) => Horizon.Server;
  probe?: (url: string, timeoutMs: number) => Promise<number>;
  warn?: (message: string) => void;
}

const HORIZON_TIMEOUT_MS = 5_000;
const HORIZON_HEALTH_CHECK_INTERVAL_MS = 30_000;

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

function safeHorizonUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "configured Horizon endpoint";
  }
}

async function probeHorizon(url: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/fee_stats`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Horizon health check returned HTTP ${response.status}`), {
        status: response.status,
      });
    }
    return Date.now() - startedAt;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Health-ranked Horizon endpoints with request-level failover for rate limits,
 * server errors, and timeouts. Each client enforces the same request timeout.
 */
export class HorizonConnectionPool {
  private readonly nodes: HorizonNode[];
  private readonly timeoutMs: number;
  private readonly probe: (url: string, timeoutMs: number) => Promise<number>;
  private readonly warn: (message: string) => void;
  private hasCheckedHealth = false;
  private healthTimer?: NodeJS.Timeout;

  constructor(options: HorizonConnectionPoolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? HORIZON_TIMEOUT_MS;
    this.probe = options.probe ?? probeHorizon;
    this.warn = options.warn ?? ((message) => console.warn(message));
    const urls = [...new Set((options.urls ?? stellarConfig.horizonUrls).filter(Boolean))];
    if (urls.length === 0) {
      throw new Error("At least one Horizon endpoint must be configured");
    }
    const createServer = options.createServer ?? ((url) =>
      new Horizon.Server(url, { allowHttp: url.startsWith("http://") })
    );
    this.nodes = urls.map((url) => {
      const server = createServer(url);
      server.httpClient.defaults.timeout = this.timeoutMs;
      return {
        url,
        server,
        healthy: false,
        latencyMs: null,
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
      url: safeHorizonUrl(node.url),
      healthy: node.healthy,
      latencyMs: node.latencyMs,
      requestCount: node.requestCount,
      errorCount: node.errorCount,
      errorRate: node.requestCount === 0 ? 0 : node.errorCount / node.requestCount,
    }));
  }

  public getPreferredServer(): Horizon.Server {
    return this.orderedNodes()[0].server;
  }

  public async checkHealth(): Promise<void> {
    await Promise.all(this.nodes.map(async (node) => {
      node.requestCount += 1;
      try {
        const latencyMs = await this.probe(node.url, this.timeoutMs);
        node.healthy = true;
        node.latencyMs = latencyMs;
        node.consecutiveErrors = 0;
      } catch {
        node.healthy = false;
        node.errorCount += 1;
        node.consecutiveErrors += 1;
      }
    }));
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
        node.latencyMs = Date.now() - startedAt;
        node.healthy = true;
        node.consecutiveErrors = 0;
        return result;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        node.latencyMs = latencyMs;
        node.errorCount += 1;
        node.consecutiveErrors += 1;
        lastError = error;
        if (!isRetryableHorizonError(error)) throw error;

        node.healthy = false;
        if (index < candidates.length - 1) {
          const status = (error as { response?: { status?: number }; status?: number })
            ?.response?.status ?? (error as { status?: number })?.status;
          this.warn(
            `[stellar] Horizon failover from ${safeHorizonUrl(node.url)} after ${latencyMs}ms` +
              (status ? ` (HTTP ${status})` : " (request timeout or network error)")
          );
        }
      }
    }

    throw lastError ?? new Error("No Horizon endpoint is available");
  }

  private orderedNodes(): HorizonNode[] {
    return [...this.nodes].sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      if (a.latencyMs !== null && b.latencyMs !== null && a.latencyMs !== b.latencyMs) {
        return a.latencyMs - b.latencyMs;
      }
      if (a.latencyMs !== null) return -1;
      if (b.latencyMs !== null) return 1;
      return a.consecutiveErrors - b.consecutiveErrors;
    });
  }
}

const horizonConnectionPool = new HorizonConnectionPool();

/** Runs one Horizon operation through the shared health-ranked failover pool. */
export function withHorizonFailover<T>(
  operation: (server: Horizon.Server) => Promise<T>
): Promise<T> {
  return horizonConnectionPool.run(operation);
}

/** Returns the currently preferred Horizon client for legacy callers. */
export function getHorizonServer(): Horizon.Server {
  return horizonConnectionPool.getPreferredServer();
}

/**
 * Lazy-initialized Soroban RPC Server client.
 */
let _sorobanRpcServer: rpc.Server | null = null;
export function getSorobanRpcServer(): rpc.Server {
  if (!_sorobanRpcServer) {
    _sorobanRpcServer = new rpc.Server(stellarConfig.sorobanRpcUrl);
  }
  return _sorobanRpcServer;
}

/**
 * Returns the Stellar Asset instance for USDC.
 */
export function getUsdcAsset(): Asset {
  return new Asset(stellarConfig.usdcAssetCode, stellarConfig.usdcIssuer);
}
