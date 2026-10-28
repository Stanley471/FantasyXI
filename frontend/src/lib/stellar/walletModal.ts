/**
 * Stellar Multi-Wallet Connect Support (Issue #223 & Issue #355)
 *
 * Configures @creit.tech/stellar-wallets-kit to provide a seamless modal
 * and wallet adapter abstraction supporting:
 * - Freighter (browser extension)
 * - Albedo (web popup — no browser extension required)
 * - xBull (extension and web)
 * - Hana (multi-chain / Stellar extension)
 * - Ledger (hardware wallet via WebUSB/WebHID with on-device verification)
 *
 * Features:
 * - Persists selected wallet provider in localStorage
 * - Unified signTransaction abstraction invoking active wallet transparently
 * - Hardware wallet signing with on-device confirmation for treasury/escrow safety
 * - Proper error handling for user signature rejection and modal close
 */

import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import {
  Networks as WalletKitNetworks,
  type ISupportedWallet,
  type ModuleInterface,
} from "@creit.tech/stellar-wallets-kit/types";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import type { WalletAdapter, WalletTransactionSigner } from "./sorobanDeposit";
import {
  LedgerWalletAdapter,
  LedgerError,
  LedgerUserRejectedError,
  LedgerDeviceLockedError,
  LedgerAppNotOpenError,
  LedgerDeviceDisconnectedError,
} from "./ledgerAdapter";

export type SupportedSoftwareWalletId = "freighter" | "albedo" | "xbull" | "hana";
export type SupportedHardwareWalletId = "ledger";
export type SupportedWalletId = SupportedSoftwareWalletId | SupportedHardwareWalletId;

export const SUPPORTED_WALLET_IDS: readonly SupportedSoftwareWalletId[] = [
  "freighter",
  "albedo",
  "xbull",
  "hana",
] as const;

export const SUPPORTED_HARDWARE_WALLET_IDS: readonly SupportedHardwareWalletId[] = [
  "ledger",
] as const;

export const ALL_SUPPORTED_WALLET_IDS: readonly SupportedWalletId[] = [
  "freighter",
  "albedo",
  "xbull",
  "hana",
  "ledger",
] as const;

export const WALLET_STORAGE_KEY = "fantasyxi.selected-wallet";

export interface WalletInfo {
  id: SupportedWalletId;
  name: string;
  type: "extension" | "web" | "hardware";
  description: string;
  isAvailable: boolean;
  requiresExtension: boolean;
}

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export class WalletUserRejectedError extends WalletError {
  constructor(action: "connection" | "signature" = "connection") {
    super(
      action === "signature"
        ? "User rejected transaction signature"
        : "User rejected wallet connection",
      action === "signature" ? "SIGNATURE_REJECTED" : "CONNECTION_REJECTED"
    );
    this.name = "WalletUserRejectedError";
  }
}

export class WalletModalClosedError extends WalletError {
  constructor() {
    super("Wallet selection modal was closed without connecting", "MODAL_CLOSED");
    this.name = "WalletModalClosedError";
  }
}

export interface WalletConnectionResult {
  address: string;
  walletId: SupportedWalletId;
}

export interface WalletModalOptions {
  network?: WalletKitNetworks;
  container?: HTMLElement;
  onWalletSelected?: (walletId: SupportedWalletId) => void;
  onClosed?: () => void;
}

/**
 * Creates module instances for the supported software Stellar wallets.
 */
export function createSupportedWalletModules(): ModuleInterface[] {
  return [
    new FreighterModule(),
    new AlbedoModule(),
    new xBullModule(),
    new HanaModule(),
  ];
}

/**
 * Persisted wallet helper functions.
 */
export function getPersistedWallet(): SupportedWalletId | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  const item = window.localStorage.getItem(WALLET_STORAGE_KEY) as SupportedWalletId | null;
  if (item && ALL_SUPPORTED_WALLET_IDS.includes(item)) {
    return item;
  }
  return null;
}

export function setPersistedWallet(walletId: SupportedWalletId | null): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  if (walletId) {
    window.localStorage.setItem(WALLET_STORAGE_KEY, walletId);
  } else {
    window.localStorage.removeItem(WALLET_STORAGE_KEY);
  }
}

export class WalletModalManager {
  private static instance: WalletModalManager | null = null;
  private kitInitialized = false;
  private activeWallet: SupportedWalletId | null = null;
  private activeAddress: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private kitInstance: any = StellarWalletsKit;
  private ledgerAdapter: LedgerWalletAdapter;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(customKit?: any, customLedger?: LedgerWalletAdapter) {
    if (customKit) {
      this.kitInstance = customKit;
    }
    this.ledgerAdapter = customLedger ?? new LedgerWalletAdapter();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static getInstance(customKit?: any, customLedger?: LedgerWalletAdapter): WalletModalManager {
    if (!WalletModalManager.instance || customKit || customLedger) {
      WalletModalManager.instance = new WalletModalManager(customKit, customLedger);
    }
    return WalletModalManager.instance;
  }

  public getLedgerAdapter(): LedgerWalletAdapter {
    return this.ledgerAdapter;
  }

  public init(network: WalletKitNetworks = WalletKitNetworks.TESTNET): void {
    if (this.kitInitialized) return;
    const modules = createSupportedWalletModules();
    this.kitInstance.init({
      modules,
      network,
      authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
    });
    this.kitInitialized = true;

    const saved = getPersistedWallet();
    if (saved) {
      this.activeWallet = saved;
    }
  }

  public getPersistedWallet(): SupportedWalletId | null {
    return getPersistedWallet();
  }

  public setPersistedWallet(walletId: SupportedWalletId | null): void {
    setPersistedWallet(walletId);
  }

  public async getSupportedWallets(): Promise<WalletInfo[]> {
    this.init();
    const modules = createSupportedWalletModules();
    const results: WalletInfo[] = [];

    for (const mod of modules) {
      const id = mod.productId as SupportedWalletId;
      const isAvailable = await mod.isAvailable();
      const isWeb = id === "albedo";
      results.push({
        id,
        name: mod.productName || id,
        type: isWeb ? "web" : "extension",
        description: isWeb
          ? "Web popup wallet — no browser extension required"
          : `${mod.productName || id} wallet adapter`,
        isAvailable,
        requiresExtension: !isWeb,
      });
    }

    // Ledger Hardware Wallet
    results.push({
      id: "ledger",
      name: "Ledger",
      type: "hardware",
      description: "Hardware wallet via WebUSB/WebHID with on-device signature verification",
      isAvailable: true,
      requiresExtension: false,
    });

    return results;
  }

  public async openModal(options?: WalletModalOptions): Promise<WalletConnectionResult> {
    this.init(options?.network);

    try {
      const result = await this.kitInstance.authModal({ container: options?.container });
      if (!result || !result.address) {
        options?.onClosed?.();
        throw new WalletModalClosedError();
      }

      const selectedId =
        (this.kitInstance.selectedModule?.productId as SupportedWalletId) ||
        this.activeWallet ||
        "freighter";
      this.activeWallet = selectedId;
      this.activeAddress = result.address;
      setPersistedWallet(selectedId);
      options?.onWalletSelected?.(selectedId);

      return {
        address: result.address,
        walletId: selectedId,
      };
    } catch (err: unknown) {
      if (err instanceof WalletError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes("reject") ||
        msg.toLowerCase().includes("cancel") ||
        msg.toLowerCase().includes("declined")
      ) {
        throw new WalletUserRejectedError("connection");
      }
      if (
        msg.toLowerCase().includes("closed") ||
        msg.toLowerCase().includes("dismiss") ||
        msg.toLowerCase().includes("modal was closed")
      ) {
        throw new WalletModalClosedError();
      }
      throw new WalletError(msg, "CONNECTION_FAILED");
    }
  }

  public async connect(walletId: SupportedWalletId): Promise<WalletConnectionResult> {
    if (walletId === "ledger") {
      try {
        const res = await this.ledgerAdapter.connect();
        this.activeWallet = "ledger";
        this.activeAddress = res.address;
        setPersistedWallet("ledger");
        return {
          address: res.address,
          walletId: "ledger",
        };
      } catch (err: unknown) {
        if (err instanceof LedgerUserRejectedError) {
          throw new WalletUserRejectedError("connection");
        }
        if (err instanceof LedgerError) {
          throw new WalletError(err.message, err.code);
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new WalletError(`Failed to connect to Ledger: ${msg}`, "CONNECTION_FAILED");
      }
    }

    this.init();
    try {
      this.kitInstance.setWallet(walletId);
      const res = await this.kitInstance.fetchAddress();
      this.activeWallet = walletId;
      this.activeAddress = res.address;
      setPersistedWallet(walletId);
      return {
        address: res.address,
        walletId,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes("reject") ||
        msg.toLowerCase().includes("cancel") ||
        msg.toLowerCase().includes("declined")
      ) {
        throw new WalletUserRejectedError("connection");
      }
      throw new WalletError(`Failed to connect to ${walletId}: ${msg}`, "CONNECTION_FAILED");
    }
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.activeWallet === "ledger") {
        await this.ledgerAdapter.disconnect();
      } else {
        await this.kitInstance.disconnect();
      }
    } finally {
      this.activeWallet = null;
      this.activeAddress = null;
      setPersistedWallet(null);
    }
  }

  public async signTransaction(
    xdr: string,
    options?: { networkPassphrase?: string; address?: string }
  ): Promise<{ signedTxXdr: string }> {
    if (!this.activeWallet) {
      const saved = getPersistedWallet();
      if (saved) {
        this.activeWallet = saved;
        if (saved !== "ledger") {
          this.kitInstance.setWallet(saved);
        }
      } else {
        throw new WalletError(
          "No active wallet connected. Please connect a wallet before signing.",
          "NOT_CONNECTED"
        );
      }
    }

    if (this.activeWallet === "ledger") {
      try {
        return await this.ledgerAdapter.signTransaction(xdr, options);
      } catch (err: unknown) {
        if (err instanceof LedgerUserRejectedError) {
          throw new WalletUserRejectedError("signature");
        }
        if (err instanceof LedgerError) {
          throw new WalletError(err.message, err.code);
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new WalletError(`Ledger transaction signing failed: ${msg}`, "SIGNING_FAILED");
      }
    }

    try {
      const result = await this.kitInstance.signTransaction(xdr, options);
      return { signedTxXdr: result.signedTxXdr };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes("reject") ||
        msg.toLowerCase().includes("cancel") ||
        msg.toLowerCase().includes("declined")
      ) {
        throw new WalletUserRejectedError("signature");
      }
      throw new WalletError(`Transaction signing failed: ${msg}`, "SIGNING_FAILED");
    }
  }

  public createWalletAdapter(walletId?: SupportedWalletId): WalletAdapter {
    const targetWallet = walletId || this.activeWallet || "freighter";

    if (targetWallet === "ledger") {
      return {
        id: "ledger",
        connect: async () => {
          await this.connect("ledger");
        },
        disconnect: async () => {
          await this.disconnect();
        },
        getPublicKey: async () => {
          if (this.activeAddress) return this.activeAddress;
          const res = await this.ledgerAdapter.getPublicKey();
          this.activeAddress = res.address;
          return res.address;
        },
        signTransaction: async (xdr, options) => {
          return this.signTransaction(xdr, options);
        },
      };
    }

    return {
      id: targetWallet,
      connect: async () => {
        await this.connect(targetWallet);
      },
      disconnect: async () => {
        await this.disconnect();
      },
      getPublicKey: async () => {
        if (this.activeAddress) return this.activeAddress;
        const res = await this.kitInstance.getAddress();
        this.activeAddress = res.address;
        return res.address;
      },
      signTransaction: async (xdr, options) => {
        return this.signTransaction(xdr, options);
      },
    };
  }

  public getActiveWallet(): SupportedWalletId | null {
    return this.activeWallet;
  }

  public getActiveAddress(): string | null {
    return this.activeAddress;
  }
}

export const walletModalManager = WalletModalManager.getInstance();

export const openWalletModal = (options?: WalletModalOptions) =>
  walletModalManager.openModal(options);

export const connectWallet = (walletId: SupportedWalletId) =>
  walletModalManager.connect(walletId);

export const disconnectWallet = () => walletModalManager.disconnect();

export const signTransaction: WalletTransactionSigner = (xdr, options) =>
  walletModalManager.signTransaction(xdr, options);

export const createWalletAdapter = (walletId?: SupportedWalletId) =>
  walletModalManager.createWalletAdapter(walletId);

export {
  LedgerWalletAdapter,
  LedgerError,
  LedgerUserRejectedError,
  LedgerDeviceLockedError,
  LedgerAppNotOpenError,
  LedgerDeviceDisconnectedError,
};
