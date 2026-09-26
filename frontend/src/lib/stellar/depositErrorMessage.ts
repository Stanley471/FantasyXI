/**
 * Translates the various error shapes that can come out of a Freighter/Soroban
 * deposit attempt (wallet rejection, RPC/network failure, contract simulation
 * failure, or an arbitrary thrown value) into a single user-friendly message.
 *
 * Kept as a pure function so PaymentModal's error handling can be unit tested
 * without needing to drive an actual wallet or Soroban RPC call.
 */
export function mapDepositErrorToMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (
    msg.includes("User declined") ||
    msg.includes("rejected") ||
    msg.includes("Permission not granted") ||
    msg.includes("declined access")
  ) {
    return "Signature request was rejected in the selected wallet.";
  }

  if (msg.includes("trustline") || msg.includes("balance")) {
    return "Insufficient Testnet USDC balance or missing trustline in Freighter.";
  }

  if (
    msg.includes("Failed to load account") ||
    msg.includes("NetworkError") ||
    msg.includes("fetch failed") ||
    msg.includes("Load failed")
  ) {
    return "Could not reach the Stellar network. Check your connection and retry.";
  }

  return msg;
}
