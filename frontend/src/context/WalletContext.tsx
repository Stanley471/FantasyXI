"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import {
  WalletConnectModule,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import {
  Networks as WalletKitNetworks,
  KitEventType,
  type ISupportedWallet,
} from "@creit.tech/stellar-wallets-kit/types";
import type { WalletAdapter, WalletTransactionSigner } from "@/lib/stellar/sorobanDeposit";
import { createSupportedWalletModules } from "@/lib/stellar/walletModal";
import {
  classifyWalletError,
  connectionTypeFor,
  type WalletConnectionErrorCode,
  type WalletConnectionType,
} from "@/lib/stellar/walletConnect";
import { ConnectWalletModal } from "@/components/wallet/ConnectWalletModal";

export type WalletProviderId = "freighter" | "albedo" | "xbull" | "hana" | "wallet_connect";

export interface SupportedWallet extends ISupportedWallet {
  id: WalletProviderId;
}

interface WalletContextValue {
  wallets: SupportedWallet[];
  selectedWallet: WalletProviderId | null;
  /** How the active wallet is reached: extension, web popup, or mobile (WalletConnect). */
  connectionType: WalletConnectionType | null;
  publicKey: string | null;
  isConnecting: boolean;
  /** Wallet currently awaiting approval, if any. */
  connectingWalletId: WalletProviderId | null;
  isReady: boolean;
  error: string | null;
  errorCode: WalletConnectionErrorCode | null;
  isConnectModalOpen: boolean;
  openConnectModal: () => void;
  closeConnectModal: () => void;
  connect: (walletId: WalletProviderId) => Promise<void>;
  disconnect: () => Promise<void>;
  signTransaction: WalletTransactionSigner;
  adapter: WalletAdapter | null;
}

const WalletContext = createContext<WalletContextValue | null>(null);
const WALLET_STORAGE_KEY = "fantasyxi.selected-wallet";
const WALLET_IDS = new Set<WalletProviderId>([
  "freighter",
  "albedo",
  "xbull",
  "hana",
  "wallet_connect",
]);

/** Extension wallets expose the active account silently, so account switches can be polled. */
const WATCHABLE_WALLETS = new Set<WalletProviderId>(["freighter", "xbull", "hana"]);
const ACCOUNT_POLL_INTERVAL_MS = 2500;

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

function createModules() {
  const modules = createSupportedWalletModules();
  if (walletConnectProjectId) {
    modules.push(
      new WalletConnectModule({
        projectId: walletConnectProjectId,
        metadata: {
          name: "FantasyXI",
          description: "Fantasy football leagues with Soroban escrow.",
          url: typeof window === "undefined" ? "https://fantasyxi.app" : window.location.origin,
          icons: ["/manifest.json"],
        },
        allowedChains: [WalletConnectTargetChain.TESTNET],
      })
    );
  }
  return modules.filter((module) => WALLET_IDS.has(module.productId as WalletProviderId));
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallets, setWallets] = useState<SupportedWallet[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<WalletProviderId | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<WalletConnectionErrorCode | null>(null);
  const [connectingWalletId, setConnectingWalletId] = useState<WalletProviderId | null>(null);
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const publicKeyRef = useRef<string | null>(null);

  useEffect(() => {
    publicKeyRef.current = publicKey;
  }, [publicKey]);

  const openConnectModal = useCallback(() => {
    setError(null);
    setErrorCode(null);
    setIsConnectModalOpen(true);
  }, []);
  const closeConnectModal = useCallback(() => setIsConnectModalOpen(false), []);

  // Reflect account switches made inside the wallet extension without a reload.
  useEffect(() => {
    if (!selectedWallet || !WATCHABLE_WALLETS.has(selectedWallet)) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const { address } = await StellarWalletsKit.getAddress();
        if (!cancelled && address && address !== publicKeyRef.current) setPublicKey(address);
      } catch {
        // Wallet locked or temporarily unavailable: keep the last known account.
      }
    };
    const timer = setInterval(sync, ACCOUNT_POLL_INTERVAL_MS);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [selectedWallet]);

  useEffect(() => {
    const modules = createModules();
    StellarWalletsKit.init({
      modules,
      network: WalletKitNetworks.TESTNET,
      authModal: { showInstallLabel: true },
    });

    let unsubscribe: (() => void) | undefined;
    const initialize = async () => {
      const supported = await StellarWalletsKit.refreshSupportedWallets();
      setWallets(
        supported.filter((wallet): wallet is SupportedWallet => WALLET_IDS.has(wallet.id as WalletProviderId))
      );

      const savedWallet = localStorage.getItem(WALLET_STORAGE_KEY) as WalletProviderId | null;
      if (savedWallet && WALLET_IDS.has(savedWallet) && modules.some((module) => module.productId === savedWallet)) {
        try {
          StellarWalletsKit.setWallet(savedWallet);
          const restored = await StellarWalletsKit.fetchAddress();
          setSelectedWallet(savedWallet);
          setPublicKey(restored.address);
        } catch {
          localStorage.removeItem(WALLET_STORAGE_KEY);
        }
      }

      unsubscribe = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
        setPublicKey(null);
        setSelectedWallet(null);
        localStorage.removeItem(WALLET_STORAGE_KEY);
      });
      setIsReady(true);
    };

    initialize().catch((initializationError: unknown) => {
      setError(initializationError instanceof Error ? initializationError.message : "Wallet services are unavailable.");
      setIsReady(true);
    });

    return () => unsubscribe?.();
  }, []);

  const connect = async (walletId: WalletProviderId) => {
    setIsConnecting(true);
    setConnectingWalletId(walletId);
    setError(null);
    setErrorCode(null);
    try {
      StellarWalletsKit.setWallet(walletId);
      const result = await StellarWalletsKit.fetchAddress();
      setSelectedWallet(walletId);
      setPublicKey(result.address);
      localStorage.setItem(WALLET_STORAGE_KEY, walletId);
    } catch (connectionError: unknown) {
      const classified = classifyWalletError(connectionError, walletId);
      setError(classified.message);
      setErrorCode(classified.code);
      throw classified;
    } finally {
      setIsConnecting(false);
      setConnectingWalletId(null);
    }
  };

  const disconnect = async () => {
    await StellarWalletsKit.disconnect();
    setPublicKey(null);
    setSelectedWallet(null);
    localStorage.removeItem(WALLET_STORAGE_KEY);
  };

  const signTransaction: WalletTransactionSigner = async (xdr, options) => {
    if (!selectedWallet || !publicKey) throw new Error("Connect a wallet before signing.");
    const result = await StellarWalletsKit.signTransaction(xdr, options);
    return { signedTxXdr: result.signedTxXdr };
  };

  const adapter: WalletAdapter | null = selectedWallet
    ? {
        id: selectedWallet,
        connect: async () => connect(selectedWallet),
        disconnect,
        getPublicKey: async () => {
          if (!publicKey) throw new Error("Wallet is not connected.");
          return publicKey;
        },
        signTransaction,
      }
    : null;

  return (
    <WalletContext.Provider
      value={{
        wallets,
        selectedWallet,
        connectionType: selectedWallet ? connectionTypeFor(selectedWallet) : null,
        publicKey,
        isConnecting,
        connectingWalletId,
        isReady,
        error,
        errorCode,
        isConnectModalOpen,
        openConnectModal,
        closeConnectModal,
        connect,
        disconnect,
        signTransaction,
        adapter,
      }}
    >
      {children}
      <ConnectWalletModal />
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used within WalletProvider");
  return context;
}
