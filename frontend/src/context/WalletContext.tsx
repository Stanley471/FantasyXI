"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
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

export type WalletProviderId = "freighter" | "albedo" | "xbull" | "wallet_connect";

export interface SupportedWallet extends ISupportedWallet {
  id: WalletProviderId;
}

interface WalletContextValue {
  wallets: SupportedWallet[];
  selectedWallet: WalletProviderId | null;
  publicKey: string | null;
  isConnecting: boolean;
  isReady: boolean;
  error: string | null;
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
  "wallet_connect",
]);

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

function createModules() {
  const modules = defaultModules();
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
    setError(null);
    try {
      StellarWalletsKit.setWallet(walletId);
      const result = await StellarWalletsKit.fetchAddress();
      setSelectedWallet(walletId);
      setPublicKey(result.address);
      localStorage.setItem(WALLET_STORAGE_KEY, walletId);
    } catch (connectionError: unknown) {
      setError(connectionError instanceof Error ? connectionError.message : "Wallet connection was rejected.");
      throw connectionError;
    } finally {
      setIsConnecting(false);
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
        publicKey,
        isConnecting,
        isReady,
        error,
        connect,
        disconnect,
        signTransaction,
        adapter,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used within WalletProvider");
  return context;
}
