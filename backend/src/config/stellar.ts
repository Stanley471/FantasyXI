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

import {
  StellarNodeFailoverPool,
  parseEndpointList,
} from "../services/financial/horizonFailoverPool.js";

/**
 * Lazy-initialized Horizon Server client (backed by failover pool when multiple endpoints are configured).
 */
let _horizonServer: Horizon.Server | null = null;
let _horizonPool: StellarNodeFailoverPool<Horizon.Server> | null = null;

export function getHorizonFailoverPool(): StellarNodeFailoverPool<Horizon.Server> {
  if (!_horizonPool) {
    const urls = parseEndpointList(
      process.env.STELLAR_HORIZON_URLS,
      stellarConfig.horizonUrl
    );
    _horizonPool = new StellarNodeFailoverPool<Horizon.Server>({
      nodes: urls,
      createClient: (url) => new Horizon.Server(url),
      probe: async (client) => {
        const page = await client.ledgers().order("desc").limit(1).call();
        const sequence = Number(page.records?.[0]?.sequence ?? 0);
        return { ledgerSequence: sequence };
      },
    });
  }
  return _horizonPool;
}

export function getHorizonServer(): Horizon.Server {
  if (_horizonPool) {
    return _horizonPool.selectHealthyNode().client;
  }
  if (!_horizonServer) {
    _horizonServer = new Horizon.Server(stellarConfig.horizonUrl);
  }
  return _horizonServer;
}

/**
 * Lazy-initialized Soroban RPC Server client.
 */
let _sorobanRpcServer: rpc.Server | null = null;
let _sorobanRpcPool: StellarNodeFailoverPool<rpc.Server> | null = null;

export function getSorobanRpcFailoverPool(): StellarNodeFailoverPool<rpc.Server> {
  if (!_sorobanRpcPool) {
    const urls = parseEndpointList(
      process.env.STELLAR_SOROBAN_RPC_URLS,
      stellarConfig.sorobanRpcUrl
    );
    _sorobanRpcPool = new StellarNodeFailoverPool<rpc.Server>({
      nodes: urls,
      createClient: (url) => new rpc.Server(url),
      probe: async (client) => {
        const latest = await client.getLatestLedger();
        return { ledgerSequence: Number(latest.sequence ?? 0) };
      },
    });
  }
  return _sorobanRpcPool;
}

export function getSorobanRpcServer(): rpc.Server {
  if (_sorobanRpcPool) {
    return _sorobanRpcPool.selectHealthyNode().client;
  }
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
