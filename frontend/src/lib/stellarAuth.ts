/**
 * SEP-0010 Stellar Web Authentication from the browser (issue #562).
 *
 * The server issues a challenge transaction (sequence 0, so it can never be
 * submitted to the network); the connected wallet signs it, and the server
 * verifies the signature and issues the session. No secret leaves the wallet.
 */

import { api, ApiError } from "@/lib/api";
import type { WalletTransactionSigner } from "@/lib/stellar/sorobanDeposit";
import type { User } from "@/types";

export interface StellarSession {
  token: string;
  user: User;
}

interface StellarChallenge {
  transaction: string;
  networkPassphrase: string;
  expiresAt: string;
}

/** Requests a challenge, has the wallet sign it and exchanges it for a session. */
export async function authenticateWithStellar(
  address: string,
  signTransaction: WalletTransactionSigner
): Promise<StellarSession> {
  const { data: challenge } = await api.get<{ data: StellarChallenge }>(
    `/api/v1/auth/stellar/challenge?account=${encodeURIComponent(address)}`
  );
  const { signedTxXdr } = await signTransaction(challenge.transaction, {
    networkPassphrase: challenge.networkPassphrase,
    address,
  });
  const result = await api.post<{ data: StellarSession }>("/api/v1/auth/stellar/verify", {
    transaction: signedTxXdr,
  });
  return result.data;
}

/** User-facing text for a failed Stellar sign-in. */
export function describeStellarAuthError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return err.message || "The wallet signature could not be verified. Please try again.";
    if (err.status === 503) return "Wallet sign-in is not available right now.";
    return err.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
