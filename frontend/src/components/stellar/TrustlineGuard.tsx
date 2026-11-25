"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconAlertCircle, IconCheck } from "@/components/ui/Icons";
import {
  checkUsdcTrustline,
  enableUsdcTrustline,
  type TrustlineStatus,
} from "@/lib/stellar/trustline";
import type { WalletTransactionSigner } from "@/lib/stellar/sorobanDeposit";

export type TrustlineViewState = TrustlineStatus | "checking" | "enabling" | "error";

export interface TrustlinePromptProps {
  state: TrustlineViewState;
  error?: string | null;
  onEnable?: () => void;
}

/** Presentational prompt; pure so it can be rendered in tests. */
export const TrustlinePrompt: React.FC<TrustlinePromptProps> = ({ state, error, onEnable }) => {
  if (state === "checking") {
    return (
      <p role="status" className="text-[11px] text-slate-400">
        Checking USDC trustline...
      </p>
    );
  }
  if (state === "active") {
    return (
      <p role="status" className="flex items-center gap-1.5 text-[11px] text-emerald-400">
        <IconCheck className="w-3.5 h-3.5" /> USDC trustline active
      </p>
    );
  }

  if (state === "error") {
    return (
      <p role="status" className="text-[11px] text-amber-300">
        Could not verify your USDC trustline{error ? `: ${error}` : "."} The deposit simulation will still check it.
      </p>
    );
  }

  const unfunded = state === "unfunded";
  return (
    <div
      role="alert"
      className="p-3.5 rounded-lg bg-amber-950/30 border border-amber-500/30 text-amber-200 text-xs space-y-2.5"
    >
      <div className="flex items-start gap-2.5">
        <IconAlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <span className="font-medium">
          {unfunded
            ? "Your Stellar account is not funded yet. Add some XLM, then enable USDC."
            : "Your account has no USDC trustline. Enable USDC before depositing."}
        </span>
      </div>
      {error && <p className="text-red-300">{error}</p>}
      {!unfunded && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onEnable}
          isLoading={state === "enabling"}
          disabled={state === "enabling"}
          className="w-full justify-center text-xs font-semibold"
        >
          Enable USDC
        </Button>
      )}
    </div>
  );
};

export function useUsdcTrustline(publicKey: string | null, signTransaction: WalletTransactionSigner) {
  const [state, setState] = useState<TrustlineViewState>("checking");
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    const id = ++requestId.current;
    setState("checking");
    try {
      const result = await checkUsdcTrustline(publicKey);
      if (id === requestId.current) setState(result.status);
    } catch (err: unknown) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : "Could not check your USDC trustline.");
      setState("error");
    }
  }, [publicKey]);

  useEffect(() => {
    // Re-check whenever the connected account changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!publicKey) return;
    const id = ++requestId.current;
    setError(null);
    setState("enabling");
    try {
      await enableUsdcTrustline({ publicKey, signTransaction });
      if (id === requestId.current) setState("active");
    } catch (err: unknown) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : "Could not enable the USDC trustline.");
      setState("missing");
    }
  }, [publicKey, signTransaction]);

  return { state, error, enable, refresh };
}

interface TrustlineGuardProps {
  publicKey: string | null;
  signTransaction: WalletTransactionSigner;
  /** Notifies the parent whether deposits may proceed. */
  onStatusChange?: (canDeposit: boolean) => void;
}

/** Detects a missing USDC trustline and offers a one-click activation. */
export const TrustlineGuard: React.FC<TrustlineGuardProps> = ({ publicKey, signTransaction, onStatusChange }) => {
  const { state, error, enable } = useUsdcTrustline(publicKey, signTransaction);

  useEffect(() => {
    // "error" (Horizon unreachable) must not hard-block: simulation still catches real problems.
    onStatusChange?.(state === "active" || state === "error");
  }, [state, onStatusChange]);

  if (!publicKey) return null;
  return <TrustlinePrompt state={state} error={error} onEnable={enable} />;
};
