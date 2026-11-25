"use client";

import React, { useState } from "react";
import { useWallet } from "@/context/WalletContext";
import { claimPrizeFromSorobanEscrow } from "@/lib/stellar/sorobanClaim";
import {
  IconTrophy,
  IconCheck,
  IconAlertCircle,
  IconLoader,
  IconClose,
} from "@/components/ui/Icons";

export interface ClaimPrizeModalProps {
  isOpen: boolean;
  onClose: () => void;
  leagueId: string | number;
  leagueName: string;
  rank?: number;
  prizeAmount: number; // in USDC
  escrowContractId?: string;
  onClaimSuccess?: (txHash: string) => void;
}

export const ClaimPrizeModal: React.FC<ClaimPrizeModalProps> = ({
  isOpen,
  onClose,
  leagueId,
  leagueName,
  rank = 1,
  prizeAmount,
  escrowContractId = process.env.NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID || "",
  onClaimSuccess,
}) => {
  const { publicKey, signTransaction, connect, openConnectModal } = useWallet();
  const [step, setStep] = useState<"idle" | "processing" | "success" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [txHash, setTxHash] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");

  if (!isOpen) return null;

  const handleClaim = async () => {
    if (!publicKey) {
      openConnectModal();
      return;
    }

    setStep("processing");
    setErrorMessage("");

    try {
      const result = await claimPrizeFromSorobanEscrow({
        escrowContractId,
        leagueId,
        winnerPublicKey: publicKey,
        signTransaction,
        onProgress: (status) => setStatusMessage(status),
      });

      setTxHash(result.txHash);
      setStep("success");
      onClaimSuccess?.(result.txHash);
    } catch (err: unknown) {
      setStep("error");
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    }
  };

  const getRankLabel = (r: number) => {
    if (r === 1) return { title: "1st Place Champion", share: "60%", badgeColor: "bg-amber-500 text-slate-950" };
    if (r === 2) return { title: "2nd Place Runner-up", share: "30%", badgeColor: "bg-slate-300 text-slate-950" };
    if (r === 3) return { title: "3rd Place Podium", share: "10%", badgeColor: "bg-amber-700 text-amber-100" };
    return { title: `Rank ${r} Winner`, share: "Prize Share", badgeColor: "bg-purple-600 text-white" };
  };

  const rankInfo = getRankLabel(rank);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl p-6 sm:p-7 text-white space-y-6">
        <button
          onClick={onClose}
          disabled={step === "processing"}
          className="absolute top-5 right-5 text-slate-400 hover:text-white p-1 rounded-full transition-colors disabled:opacity-50"
          aria-label="Close"
        >
          <IconClose className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3">
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-amber-400">
            <IconTrophy className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-black tracking-tight text-white">Claim Escrow Prize</h3>
            <p className="text-xs text-slate-400 truncate max-w-[240px]">{leagueName}</p>
          </div>
        </div>

        {step === "idle" && (
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className={`text-[11px] font-black uppercase px-2 py-0.5 rounded-full ${rankInfo.badgeColor}`}>
                  {rankInfo.title}
                </span>
                <span className="text-xs font-mono font-bold text-slate-400">{rankInfo.share} Pool</span>
              </div>
              <div className="flex items-baseline justify-between pt-1">
                <span className="text-xs text-slate-400 font-medium">Allocated Payout</span>
                <span className="text-2xl font-black font-mono text-emerald-400">
                  {prizeAmount.toFixed(2)} USDC
                </span>
              </div>
            </div>

            <div className="text-xs text-slate-400 space-y-1">
              <p>• Payout is distributed trustlessly from the non-custodial Soroban escrow contract.</p>
              <p>• USDC is transferred directly to your connected wallet address.</p>
            </div>

            {!publicKey ? (
              <button
                type="button"
                onClick={openConnectModal}
                className="w-full py-3.5 px-4 rounded-xl font-bold uppercase tracking-wider text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 transition-colors"
              >
                Connect Wallet to Claim
              </button>
            ) : (
              <button
                type="button"
                onClick={handleClaim}
                className="w-full py-3.5 px-4 rounded-xl font-bold uppercase tracking-wider text-xs bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors"
              >
                Claim {prizeAmount.toFixed(2)} USDC Now
              </button>
            )}
          </div>
        )}

        {step === "processing" && (
          <div className="py-8 text-center space-y-4">
            <IconLoader className="w-10 h-10 animate-spin text-amber-400 mx-auto" />
            <div className="space-y-1">
              <h4 className="text-sm font-bold text-white">Withdrawing Prize Allocation</h4>
              <p className="text-xs text-slate-400">{statusMessage || "Preparing on-chain transaction..."}</p>
            </div>
          </div>
        )}

        {step === "success" && (
          <div className="py-6 text-center space-y-4">
            <div className="w-12 h-12 bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 rounded-full flex items-center justify-center mx-auto">
              <IconCheck className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h4 className="text-base font-black text-white">Prize Claimed Successfully!</h4>
              <p className="text-xs text-slate-300">
                {prizeAmount.toFixed(2)} USDC has been transferred to your wallet.
              </p>
              {txHash && (
                <p className="text-[11px] font-mono text-slate-500 break-all pt-2">
                  Tx: {txHash}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-3 px-4 rounded-xl font-bold uppercase tracking-wider text-xs bg-slate-800 hover:bg-slate-700 text-white transition-colors"
            >
              Done
            </button>
          </div>
        )}

        {step === "error" && (
          <div className="py-6 text-center space-y-4">
            <div className="w-12 h-12 bg-rose-500/20 text-rose-400 border border-rose-500/40 rounded-full flex items-center justify-center mx-auto">
              <IconAlertCircle className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-black text-white">Claim Failed</h4>
              <p className="text-xs text-rose-300">{errorMessage}</p>
            </div>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 px-4 rounded-xl font-bold uppercase tracking-wider text-xs bg-slate-800 hover:bg-slate-700 text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClaim}
                className="flex-1 py-2.5 px-4 rounded-xl font-bold uppercase tracking-wider text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
