/**
 * USDC trustline verification and activation (Issue #553)
 *
 * A Stellar account can only hold or send USDC after it has established a
 * trustline to the USDC issuing account. This module:
 *  1. Detects a missing trustline via Horizon account balances.
 *  2. Builds a `change_trust` transaction (maximum limit) for the wallet to sign.
 *  3. Submits it to Horizon and waits until the trustline is visible.
 *
 * Network access goes through an injectable `fetchImpl` so the logic is unit
 * testable without a live network.
 */

import { Asset, Networks, Operation, TransactionBuilder, Account } from "@stellar/stellar-sdk";
import type { WalletTransactionSigner } from "./sorobanDeposit";

export const USDC_ASSET_CODE = "USDC";

/** Circle's Stellar Testnet USDC issuer. Override for other networks. */
const DEFAULT_TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const DEFAULT_HORIZON_URL =
  process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
export const USDC_ISSUER =
  process.env.NEXT_PUBLIC_STELLAR_USDC_ISSUER || DEFAULT_TESTNET_USDC_ISSUER;
const DEFAULT_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

export type TrustlineStatus =
  /** Trustline exists. */
  | "active"
  /** Account exists but has no USDC trustline. */
  | "missing"
  /** Account does not exist on the ledger (no XLM reserve yet). */
  | "unfunded";

export interface TrustlineCheckResult {
  status: TrustlineStatus;
  /** USDC balance as a decimal string, when the trustline exists. */
  balance?: string;
  limit?: string;
}

export interface TrustlineOptions {
  horizonUrl?: string;
  issuer?: string;
  fetchImpl?: typeof fetch;
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
}

export class TrustlineError extends Error {
  constructor(
    message: string,
    public readonly code: "unfunded" | "network" | "rejected" | "submit_failed" | "timeout"
  ) {
    super(message);
    this.name = "TrustlineError";
  }
}

function trimUrl(url: string) {
  return url.replace(/\/+$/, "");
}

async function fetchHorizonAccount(
  publicKey: string,
  { horizonUrl = DEFAULT_HORIZON_URL, fetchImpl = fetch }: TrustlineOptions
): Promise<{ balances: HorizonBalance[]; sequence: string } | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${trimUrl(horizonUrl)}/accounts/${encodeURIComponent(publicKey)}`);
  } catch {
    throw new TrustlineError("Could not reach the Stellar network. Check your connection and retry.", "network");
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TrustlineError(`Horizon returned HTTP ${res.status} while loading your account.`, "network");
  }
  const body = (await res.json()) as { balances?: HorizonBalance[]; sequence?: string };
  return { balances: body.balances ?? [], sequence: String(body.sequence ?? "0") };
}

/** Checks whether `publicKey` holds an authorized-or-pending USDC trustline. */
export async function checkUsdcTrustline(
  publicKey: string,
  options: TrustlineOptions = {}
): Promise<TrustlineCheckResult> {
  const issuer = options.issuer ?? USDC_ISSUER;
  const account = await fetchHorizonAccount(publicKey, options);
  if (!account) return { status: "unfunded" };

  const line = account.balances.find(
    (b) => b.asset_code === USDC_ASSET_CODE && b.asset_issuer === issuer
  );
  if (!line) return { status: "missing" };
  return { status: "active", balance: line.balance, limit: line.limit };
}

/** Builds an unsigned `change_trust` transaction XDR with the maximum limit. */
export async function buildUsdcTrustlineXdr(
  publicKey: string,
  options: TrustlineOptions & { networkPassphrase?: string } = {}
): Promise<string> {
  const issuer = options.issuer ?? USDC_ISSUER;
  const account = await fetchHorizonAccount(publicKey, options);
  if (!account) {
    throw new TrustlineError(
      "Your Stellar account is not funded yet. Send some XLM to it, then enable USDC.",
      "unfunded"
    );
  }

  const tx = new TransactionBuilder(new Account(publicKey, account.sequence), {
    fee: "100000",
    networkPassphrase: options.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
  })
    // Omitting `limit` makes the SDK use the maximum trust limit.
    .addOperation(Operation.changeTrust({ asset: new Asset(USDC_ASSET_CODE, issuer) }))
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

async function submitToHorizon(
  signedXdr: string,
  { horizonUrl = DEFAULT_HORIZON_URL, fetchImpl = fetch }: TrustlineOptions
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${trimUrl(horizonUrl)}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: signedXdr }).toString(),
    });
  } catch {
    throw new TrustlineError("Could not reach the Stellar network. Check your connection and retry.", "network");
  }
  if (!res.ok) {
    throw new TrustlineError(
      res.status === 400
        ? "The network rejected the trustline transaction. Make sure your account holds enough XLM for the reserve."
        : `Horizon returned HTTP ${res.status} while submitting the trustline transaction.`,
      "submit_failed"
    );
  }
}

export interface EnableTrustlineParams extends TrustlineOptions {
  publicKey: string;
  signTransaction: WalletTransactionSigner;
  networkPassphrase?: string;
  /** Poll settings for confirmation; exposed for tests. */
  pollIntervalMs?: number;
  maxPolls?: number;
}

/**
 * Builds, signs (via the connected wallet), submits and confirms the USDC
 * trustline. Resolves once Horizon reports the trustline as active.
 */
export async function enableUsdcTrustline(params: EnableTrustlineParams): Promise<TrustlineCheckResult> {
  const { publicKey, signTransaction, pollIntervalMs = 2000, maxPolls = 15 } = params;
  const networkPassphrase = params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE;

  const xdr = await buildUsdcTrustlineXdr(publicKey, params);

  let signedTxXdr: string;
  try {
    ({ signedTxXdr } = await signTransaction(xdr, { networkPassphrase, address: publicKey }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TrustlineError(message || "The trustline request was rejected in your wallet.", "rejected");
  }
  if (!signedTxXdr) {
    throw new TrustlineError("The wallet did not return a signed transaction.", "rejected");
  }

  await submitToHorizon(signedTxXdr, params);

  for (let i = 0; i < maxPolls; i++) {
    const result = await checkUsdcTrustline(publicKey, params);
    if (result.status === "active") return result;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new TrustlineError(
    "The trustline transaction was submitted but is not confirmed yet. Refresh in a few seconds.",
    "timeout"
  );
}
