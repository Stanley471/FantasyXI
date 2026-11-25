/**
 * Wallet metadata and connection error classification for the unified Stellar
 * connect modal (Issue #552). Pure and dependency free so it can be unit tested.
 */

export type WalletConnectionType = "extension" | "web" | "mobile";

export type WalletConnectionErrorCode = "not_installed" | "rejected" | "unavailable" | "unknown";

export interface WalletMeta {
  name: string;
  connectionType: WalletConnectionType;
  description: string;
  /** Where to install the wallet when it is not detected. */
  installUrl?: string;
}

/** Wallets the modal always lists, in display order. */
export const PRIMARY_WALLET_IDS = ["freighter", "albedo", "xbull", "wallet_connect"] as const;

export const WALLET_META: Record<string, WalletMeta> = {
  freighter: {
    name: "Freighter",
    connectionType: "extension",
    description: "Browser extension",
    installUrl: "https://www.freighter.app/",
  },
  albedo: {
    name: "Albedo",
    connectionType: "web",
    description: "Web popup, no install needed",
  },
  xbull: {
    name: "xBull",
    connectionType: "extension",
    description: "Browser extension or web app",
    installUrl: "https://xbull.app/",
  },
  hana: {
    name: "Hana",
    connectionType: "extension",
    description: "Browser extension",
    installUrl: "https://hanawallet.io/",
  },
  wallet_connect: {
    name: "WalletConnect / LOBSTR",
    connectionType: "mobile",
    description: "Scan with a mobile wallet such as LOBSTR",
  },
};

export function connectionTypeFor(walletId: string): WalletConnectionType {
  return WALLET_META[walletId]?.connectionType ?? "extension";
}

export class WalletConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: WalletConnectionErrorCode
  ) {
    super(message);
    this.name = "WalletConnectionError";
  }
}

/** Turns whatever a wallet module throws into a user-facing, recoverable error. */
export function classifyWalletError(err: unknown, walletId?: string): WalletConnectionError {
  if (err instanceof WalletConnectionError) return err;
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err ?? "");
  const lower = raw.toLowerCase();
  const name = (walletId && WALLET_META[walletId]?.name) || "The wallet";

  if (
    /not (installed|detected|found)|is not available|no (wallet|provider|extension)|extension.*(missing|not)|undefined|install/.test(
      lower
    )
  ) {
    return new WalletConnectionError(
      `${name} was not detected. Install it and reload this page, or choose another wallet.`,
      "not_installed"
    );
  }
  if (/reject|declin|denied|cancel|closed|dismiss|user refused|permission not granted/.test(lower)) {
    return new WalletConnectionError(
      `${name} connection was cancelled. Approve the request in your wallet to continue.`,
      "rejected"
    );
  }
  if (/project ?id|walletconnect.*(config|not)/.test(lower)) {
    return new WalletConnectionError(
      "WalletConnect is not configured for this deployment.",
      "unavailable"
    );
  }
  return new WalletConnectionError(raw || `Could not connect to ${name}. Please try again.`, "unknown");
}
