/**
 * Stellar & Soroban Testnet Configuration & Horizon Failover Pool
 *
 * Centralizes all Stellar network parameters, RPC endpoints, asset definitions,
 * contract IDs, and the automated Horizon RPC endpoint failover pool with
 * latency routing (Issue #234).
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
  contractId: string;
}

const DEFAULT_TESTNET_HORIZON_URLS = [
  "https://horizon-testnet.stellar.org",
  "https://horizon-testnet-backup.stellar.org",
  "https://stellar-testnet.publicnode.com",
];

const DEFAULT_PUBLIC_HORIZON_URLS = [
  "https://horizon.stellar.org",
  "https://stellar.publicnode.com",
];

function resolveHorizonUrls(net: "TESTNET" | "PUBLIC"): string[] {
  const fromList = (process.env.STELLAR_HORIZON_URLS || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const singlePrimary = (process.env.STELLAR_HORIZON_URL || "").trim();
  const defaults =
    net === "PUBLIC" ? DEFAULT_PUBLIC_HORIZON_URLS : DEFAULT_TESTNET_HORIZON_URLS;

  return [...new Set([...(singlePrimary ? [singlePrimary] : []), ...fromList, ...defaults])];
}

const resolvedNetwork =
  ((process.env.STELLAR_NETWORK || "TESTNET").toUpperCase() as "TESTNET" | "PUBLIC");
const resolvedHorizonUrls = resolveHorizonUrls(resolvedNetwork);
const resolvedEscrowContractId =
  process.env.STELLAR_ESCROW_CONTRACT_ID ||
  process.env.SOROBAN_ESCROW_CONTRACT_ID ||
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const stellarConfig: StellarConfig = {
  network: resolvedNetwork,
  horizonUrl: resolvedHorizonUrls[0],
  horizonUrls: resolvedHorizonUrls,
  sorobanRpcUrl:
    process.env.STELLAR_SOROBAN_RPC_URL ||
    process.env.SOROBAN_RPC_URL ||
    "https://soroban-testnet.stellar.org",
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ||
    (resolvedNetwork === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET),
  usdcAssetCode: process.env.STELLAR_USDC_ASSET_CODE || "USDC",
  usdcIssuer:
    process.env.STELLAR_USDC_ISSUER ||
    "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWUIPWIO2LEOWOHR67K",
  treasuryAddress:
    process.env.STELLAR_TREASURY_ADDRESS ||
    "GDWZ67PEXB3P4XJ5A6M6Q7T8U9V0W1X2Y3Z4A5B6C7D8E9F0G1H2I3J4",
  escrowContractId: resolvedEscrowContractId,
  contractId: resolvedEscrowContractId,
};

export interface HorizonNodeHealth {
  url: string;
  healthy: boolean;
  latencyMs: number;
  totalChecks: number;
  failedChecks: number;
  consecutiveFailures: number;
  errorRate: number;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export interface HorizonPoolOptions {
  urls?: string[];
  timeoutMs?: number;
  healthCheckIntervalMs?: number;
  probeEndpoint?: "/fee_stats" | "/ledgers";
  fetchFn?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
  serverFactory?: (url: string) => Horizon.Server;
  logger?: Pick<Console, "warn" | "info" | "error">;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;

/**
 * Multi-endpoint Horizon RPC Connection Pool with latency-based routing and automatic failover.
 */
export class HorizonConnectionPool {
  private readonly nodes = new Map<string, HorizonNodeHealth>();
  private readonly servers = new Map<string, Horizon.Server>();
  private readonly timeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly probeEndpoint: "/fee_stats" | "/ledgers";
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
  private readonly serverFactory: (url: string) => Horizon.Server;
  private readonly logger: Pick<Console, "warn" | "info" | "error">;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HorizonPoolOptions = {}) {
    const rawUrls =
      options.urls && options.urls.length > 0
        ? options.urls
        : stellarConfig.horizonUrls;
    const uniqueUrls = [
      ...new Set(rawUrls.map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean)),
    ];
    if (uniqueUrls.length === 0) {
      throw new Error("HorizonConnectionPool requires at least one Horizon RPC URL");
    }

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.healthCheckIntervalMs =
      options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.probeEndpoint = options.probeEndpoint ?? "/fee_stats";
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.serverFactory =
      options.serverFactory ??
      ((url) =>
        new Horizon.Server(url, {
          allowHttp: url.startsWith("http://"),
        }));
    this.logger = options.logger ?? console;

    uniqueUrls.forEach((url, index) => {
      this.nodes.set(url, {
        url,
        healthy: true,
        latencyMs: 50 + index * 10,
        totalChecks: 0,
        failedChecks: 0,
        consecutiveFailures: 0,
        errorRate: 0,
        lastCheckedAt: null,
        lastError: null,
      });
    });
  }

  public getNodesStatus(): HorizonNodeHealth[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n }));
  }

  public getPrioritizedNodes(): HorizonNodeHealth[] {
    const all = Array.from(this.nodes.values());
    const healthy = all.filter((n) => n.healthy);
    if (healthy.length > 0) {
      return [...healthy].sort(
        (a, b) => a.latencyMs - b.latencyMs || a.errorRate - b.errorRate
      );
    }
    return [...all].sort(
      (a, b) =>
        a.consecutiveFailures - b.consecutiveFailures || a.latencyMs - b.latencyMs
    );
  }

  public getOptimalNodeUrl(): string {
    return this.getPrioritizedNodes()[0].url;
  }

  public getServer(urlOverride?: string): Horizon.Server {
    const targetUrl = urlOverride
      ? urlOverride.trim().replace(/\/+$/, "")
      : this.getOptimalNodeUrl();
    let srv = this.servers.get(targetUrl);
    if (!srv) {
      srv = this.serverFactory(targetUrl);
      this.servers.set(targetUrl, srv);
    }
    return srv;
  }

  public async checkNodeHealth(url: string): Promise<HorizonNodeHealth> {
    const normalizedUrl = url.trim().replace(/\/+$/, "");
    const state = this.nodes.get(normalizedUrl);
    if (!state) {
      throw new Error(`Unknown Horizon node URL: ${normalizedUrl}`);
    }

    const start = Date.now();
    const probeUrl = `${normalizedUrl}${this.probeEndpoint}`;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new Error(`Timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.fetchFn(probeUrl, { signal: controller.signal }),
        timeoutPromise,
      ]);
      const elapsed = Math.max(1, Date.now() - start);
      state.totalChecks += 1;
      state.lastCheckedAt = new Date();

      if (!response.ok || response.status >= 500 || elapsed > this.timeoutMs) {
        state.failedChecks += 1;
        state.consecutiveFailures += 1;
        state.healthy = false;
        state.latencyMs = elapsed;
        state.lastError = `HTTP ${response.status}`;
        state.errorRate = Number((state.failedChecks / state.totalChecks).toFixed(4));
        this.logger.warn(
          `[HorizonConnectionPool] Node ${normalizedUrl} health check failed (${state.lastError}) with latency ${elapsed}ms`
        );
      } else {
        state.consecutiveFailures = 0;
        state.healthy = true;
        state.latencyMs = elapsed;
        state.lastError = null;
        state.errorRate = Number((state.failedChecks / state.totalChecks).toFixed(4));
      }
    } catch (err: any) {
      const elapsed = Math.max(1, Date.now() - start);
      state.totalChecks += 1;
      state.failedChecks += 1;
      state.consecutiveFailures += 1;
      state.healthy = false;
      state.latencyMs = elapsed;
      state.lastCheckedAt = new Date();
      state.lastError = err?.message || "Network error";
      state.errorRate = Number((state.failedChecks / state.totalChecks).toFixed(4));
      this.logger.warn(
        `[HorizonConnectionPool] Node ${normalizedUrl} unreachable (${state.lastError}) after ${elapsed}ms`
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    return { ...state };
  }

  public async runHealthChecks(): Promise<HorizonNodeHealth[]> {
    const urls = Array.from(this.nodes.keys());
    return Promise.all(urls.map((u) => this.checkNodeHealth(u)));
  }

  public async executeWithFailover<T>(
    operation: (server: Horizon.Server, nodeUrl: string) => Promise<T>
  ): Promise<T> {
    const candidates = this.getPrioritizedNodes();
    let lastError: unknown = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const server = this.getServer(candidate.url);
      const start = Date.now();
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const timeoutErr: any = new Error(
              `Horizon request to ${candidate.url} timed out after ${this.timeoutMs}ms`
            );
            timeoutErr.isTimeout = true;
            reject(timeoutErr);
          }, this.timeoutMs);
        });

        const result = await Promise.race([
          operation(server, candidate.url),
          timeoutPromise,
        ]);

        const elapsed = Math.max(1, Date.now() - start);
        const state = this.nodes.get(candidate.url);
        if (state) {
          state.totalChecks += 1;
          state.consecutiveFailures = 0;
          state.healthy = true;
          state.latencyMs = elapsed;
          state.lastCheckedAt = new Date();
          state.lastError = null;
          state.errorRate = Number((state.failedChecks / state.totalChecks).toFixed(4));
        }

        return result;
      } catch (err: any) {
        const elapsed = Math.max(1, Date.now() - start);
        const status =
          err?.response?.status ?? err?.status ?? err?.statusCode ?? err?.httpStatus;

        const isClient4xx =
          typeof status === "number" && status >= 400 && status < 500 && status !== 429;
        if (isClient4xx) {
          throw err;
        }

        lastError = err;
        const state = this.nodes.get(candidate.url);
        if (state) {
          state.totalChecks += 1;
          state.failedChecks += 1;
          state.consecutiveFailures += 1;
          state.healthy = false;
          state.latencyMs = elapsed;
          state.lastCheckedAt = new Date();
          state.lastError = err?.message || `HTTP ${status ?? "error"}`;
          state.errorRate = Number((state.failedChecks / state.totalChecks).toFixed(4));
        }

        const nextNode = candidates[i + 1]?.url ?? "none";
        this.logger.warn(
          `[HorizonConnectionPool] Failover triggered: node ${candidate.url} failed (${
            err?.message || `status ${status}`
          }) with latency ${elapsed}ms. Switching to ${nextNode}.`
        );
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("All Horizon RPC endpoints in the failover pool failed");
  }

  public startHealthChecks(intervalMs: number = this.healthCheckIntervalMs): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      void this.runHealthChecks();
    }, intervalMs);
    if (typeof (this.healthCheckTimer as any).unref === "function") {
      (this.healthCheckTimer as any).unref();
    }
  }

  public stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

export const horizonConnectionPool = new HorizonConnectionPool();

/**
 * Returns a Horizon Server client routed to the fastest healthy node in the pool.
 */
export function getHorizonServer(): Horizon.Server {
  return horizonConnectionPool.getServer();
}

/**
 * Lazy-initialized Soroban RPC Server client.
 */
let _sorobanRpcServer: rpc.Server | null = null;
export function getSorobanRpcServer(): rpc.Server {
  if (!_sorobanRpcServer) {
    _sorobanRpcServer = new rpc.Server(stellarConfig.sorobanRpcUrl, {
      allowHttp: stellarConfig.sorobanRpcUrl.startsWith("http://"),
    });
  }
  return _sorobanRpcServer;
}

export const getSorobanServer = getSorobanRpcServer;

/**
 * Returns the Stellar Asset instance for USDC.
 */
export function getUsdcAsset(): Asset {
  return new Asset(stellarConfig.usdcAssetCode, stellarConfig.usdcIssuer);
}
