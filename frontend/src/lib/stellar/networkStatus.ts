/**
 * Stellar network health sampling (Issue #554)
 *
 * Probes Soroban RPC `getHealth` (with round-trip latency) and Horizon
 * `/fee_stats` + the latest ledger, then classifies the result. All network
 * access is injectable for tests.
 */

import { Networks } from "@stellar/stellar-sdk";

export const NETWORK_POLL_INTERVAL_MS = 60_000;
/** Latency above which the badge turns amber. */
export const DEGRADED_LATENCY_MS = 1500;
/** Latency above which the badge turns red. */
export const CRITICAL_LATENCY_MS = 4000;
/** Seconds since the last ledger closed above which the network is flagged. */
export const MAX_LEDGER_AGE_SECONDS = 15;
const REQUEST_TIMEOUT_MS = 8000;

export type NetworkHealth = "healthy" | "degraded" | "offline";

export interface NetworkSample {
  rpcHealthy: boolean;
  /** RPC round-trip latency in ms; null if the RPC could not be reached. */
  latencyMs: number | null;
  latestLedger: number | null;
  /** Seconds since the latest ledger closed; null if unknown. */
  ledgerAgeSeconds: number | null;
  /** Median fee charged, in stroops. */
  feeP50Stroops: number | null;
  sampledAt: number;
}

export interface NetworkStatusSnapshot extends NetworkSample {
  health: NetworkHealth;
  /** Human-readable advisories explaining a non-healthy state. */
  advisories: string[];
  /** True when the prominent alert banner should be shown. */
  showBanner: boolean;
}

export interface NetworkProbeOptions {
  rpcUrl?: string;
  horizonUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const NETWORK_LABEL =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET) === Networks.PUBLIC
    ? "Stellar Mainnet"
    : "Stellar Testnet";

const DEFAULT_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const DEFAULT_HORIZON_URL =
  process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";

async function timedFetch(fetchImpl: typeof fetch, url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Takes one health sample. Never throws: failures become an offline sample. */
export async function sampleNetwork(options: NetworkProbeOptions = {}): Promise<NetworkSample> {
  const {
    rpcUrl = DEFAULT_RPC_URL,
    horizonUrl = DEFAULT_HORIZON_URL,
    fetchImpl = fetch,
    now = Date.now,
  } = options;
  const horizon = horizonUrl.replace(/\/+$/, "");

  const sample: NetworkSample = {
    rpcHealthy: false,
    latencyMs: null,
    latestLedger: null,
    ledgerAgeSeconds: null,
    feeP50Stroops: null,
    sampledAt: now(),
  };

  const probeRpc = async () => {
    const started = now();
    try {
      const res = await timedFetch(fetchImpl, rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      sample.latencyMs = Math.max(0, now() - started);
      if (!res.ok) return;
      const body = (await res.json()) as {
        result?: { status?: string; latestLedger?: number };
        error?: unknown;
      };
      sample.rpcHealthy = !body.error && body.result?.status === "healthy";
      if (typeof body.result?.latestLedger === "number") sample.latestLedger = body.result.latestLedger;
    } catch {
      sample.latencyMs = null;
      sample.rpcHealthy = false;
    }
  };

  const probeFees = async () => {
    try {
      const res = await timedFetch(fetchImpl, `${horizon}/fee_stats`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        last_ledger?: string;
        fee_charged?: { p50?: string };
      };
      const p50 = Number(body.fee_charged?.p50);
      if (Number.isFinite(p50)) sample.feeP50Stroops = p50;
      const ledger = Number(body.last_ledger);
      if (sample.latestLedger === null && Number.isFinite(ledger)) sample.latestLedger = ledger;
    } catch {
      // Fee stats are advisory only.
    }
  };

  const probeLedgerAge = async () => {
    try {
      const res = await timedFetch(fetchImpl, `${horizon}/ledgers?order=desc&limit=1`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        _embedded?: { records?: Array<{ closed_at?: string }> };
      };
      const closedAt = body._embedded?.records?.[0]?.closed_at;
      const parsed = closedAt ? Date.parse(closedAt) : NaN;
      if (Number.isFinite(parsed)) sample.ledgerAgeSeconds = Math.max(0, (now() - parsed) / 1000);
    } catch {
      // Ledger age is advisory; RPC health is the primary signal.
    }
  };

  await Promise.all([probeRpc(), probeFees(), probeLedgerAge()]);
  sample.sampledAt = now();
  return sample;
}

/** Pure classification of a sample into a badge/banner state. */
export function classifyNetwork(sample: NetworkSample): NetworkStatusSnapshot {
  const advisories: string[] = [];
  let health: NetworkHealth = "healthy";
  let showBanner = false;

  if (!sample.rpcHealthy) {
    health = "offline";
    showBanner = true;
    advisories.push("Soroban RPC is unreachable or reporting unhealthy. Transactions may fail.");
  } else if (sample.latencyMs !== null && sample.latencyMs >= CRITICAL_LATENCY_MS) {
    health = "degraded";
    advisories.push(`RPC latency is very high (${Math.round(sample.latencyMs)}ms). Expect slow confirmations.`);
  } else if (sample.latencyMs !== null && sample.latencyMs >= DEGRADED_LATENCY_MS) {
    health = "degraded";
    advisories.push(`RPC latency is elevated (${Math.round(sample.latencyMs)}ms).`);
  }

  if (sample.ledgerAgeSeconds !== null && sample.ledgerAgeSeconds > MAX_LEDGER_AGE_SECONDS) {
    if (health === "healthy") health = "degraded";
    showBanner = true;
    advisories.push(
      `The latest ledger closed ${Math.round(sample.ledgerAgeSeconds)}s ago (expected about 5s). The network may be stalled.`
    );
  }

  return { ...sample, health, advisories, showBanner };
}

export async function fetchNetworkStatus(options: NetworkProbeOptions = {}): Promise<NetworkStatusSnapshot> {
  return classifyNetwork(await sampleNetwork(options));
}

/** Badge severity: amber for slow/stale, red for unhealthy or very slow. */
export function badgeTone(snapshot: NetworkStatusSnapshot): "green" | "amber" | "red" {
  if (snapshot.health === "offline") return "red";
  if (snapshot.latencyMs !== null && snapshot.latencyMs >= CRITICAL_LATENCY_MS) return "red";
  if (snapshot.health === "degraded") return "amber";
  return "green";
}
