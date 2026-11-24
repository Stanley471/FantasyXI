"use client";

import React, { useEffect, useRef } from "react";
import { useWallet, type WalletProviderId } from "@/context/WalletContext";
import { IconAlertCircle, IconCheck, IconClose } from "@/components/ui/Icons";
import {
  PRIMARY_WALLET_IDS,
  WALLET_META,
  type WalletConnectionErrorCode,
} from "@/lib/stellar/walletConnect";

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  isAvailable: boolean;
}

export interface ConnectWalletModalViewProps {
  /** Wallets reported by the kit (availability is detected by the kit). */
  wallets: WalletOption[];
  selectedWallet: string | null;
  publicKey: string | null;
  connectingId: string | null;
  error: string | null;
  errorCode: WalletConnectionErrorCode | null;
  onConnect: (walletId: WalletProviderId) => void;
  onDisconnect: () => void;
  onClose: () => void;
}

function shorten(key: string) {
  return key.length > 14 ? `${key.slice(0, 6)}...${key.slice(-6)}` : key;
}

/** Presentational modal body; stateless so it can be rendered in tests. */
export const ConnectWalletModalView: React.FC<ConnectWalletModalViewProps> = ({
  wallets,
  selectedWallet,
  publicKey,
  connectingId,
  error,
  errorCode,
  onConnect,
  onDisconnect,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("button:not([disabled]), a[href]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const ids = [
    ...PRIMARY_WALLET_IDS,
    ...wallets.map((wallet) => wallet.id).filter((id) => !(PRIMARY_WALLET_IDS as readonly string[]).includes(id)),
  ];
  const isBusy = connectingId !== null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-wallet-title"
        className="w-full max-w-sm rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="connect-wallet-title" className="text-base font-bold text-white">
              Connect a Stellar wallet
            </h2>
            <p className="text-xs text-slate-400 mt-1">Choose how you want to sign transactions.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wallet modal"
            className="p-1.5 text-slate-400 hover:text-white"
          >
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        {publicKey && selectedWallet && (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/30">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold">
                {WALLET_META[selectedWallet]?.name ?? selectedWallet} connected
              </div>
              <div className="truncate text-[11px] font-mono text-slate-300 mt-1" title={publicKey}>
                {shorten(publicKey)}
              </div>
            </div>
            <button
              type="button"
              onClick={onDisconnect}
              className="shrink-0 text-[11px] text-slate-400 hover:text-white underline"
            >
              Disconnect
            </button>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs flex items-start gap-2"
          >
            <IconAlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <ul className="space-y-2">
          {ids.map((id) => {
            const meta = WALLET_META[id];
            const wallet = byId.get(id);
            if (!meta) return null;
            const isConfigured = Boolean(wallet);
            const needsInstall = isConfigured && !wallet!.isAvailable && meta.connectionType === "extension";
            const isActive = selectedWallet === id && Boolean(publicKey);
            const isConnecting = connectingId === id;
            const unconfigured = !isConfigured;

            let status = meta.description;
            if (unconfigured) status = "Not configured for this deployment";
            else if (needsInstall) status = "Not detected. Install the extension to use it.";
            else if (isConnecting) status = "Waiting for approval in your wallet...";

            return (
              <li key={id}>
                <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/70 border border-slate-700">
                  {wallet?.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={wallet.icon} alt="" className="w-8 h-8 rounded-lg" />
                  ) : (
                    <span className="w-8 h-8 rounded-lg bg-slate-700" aria-hidden="true" />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-white">{meta.name}</span>
                    <span className="block text-[11px] text-slate-400">{status}</span>
                  </span>
                  {isActive && <IconCheck className="w-4 h-4 text-emerald-400" aria-label="Connected" />}
                  {needsInstall && meta.installUrl ? (
                    <a
                      href={meta.installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-xs font-semibold text-emerald-400 hover:underline"
                    >
                      Install
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy || unconfigured}
                      onClick={() => onConnect(id as WalletProviderId)}
                      className="shrink-0 px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isConnecting ? "Connecting..." : isActive ? "Reconnect" : "Connect"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {errorCode === "not_installed" && (
          <p className="text-[11px] text-slate-500">
            Tip: Albedo works in any browser without an extension.
          </p>
        )}
      </div>
    </div>
  );
};

/** Context-bound modal. Rendered once by WalletProvider. */
export const ConnectWalletModal: React.FC = () => {
  const {
    wallets,
    selectedWallet,
    publicKey,
    connectingWalletId,
    error,
    errorCode,
    connect,
    disconnect,
    isConnectModalOpen,
    closeConnectModal,
  } = useWallet();

  if (!isConnectModalOpen) return null;

  return (
    <ConnectWalletModalView
      wallets={wallets}
      selectedWallet={selectedWallet}
      publicKey={publicKey}
      connectingId={connectingWalletId}
      error={error}
      errorCode={errorCode}
      onConnect={(walletId) => {
        // Failures are surfaced inside the modal through `error`.
        connect(walletId)
          .then(closeConnectModal)
          .catch(() => undefined);
      }}
      onDisconnect={() => {
        void disconnect();
      }}
      onClose={closeConnectModal}
    />
  );
};
