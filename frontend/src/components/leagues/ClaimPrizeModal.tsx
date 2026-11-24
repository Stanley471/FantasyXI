"use client";

import React, { useState } from "react";
import { IconTrophy, IconShield } from "@/components/ui/Icons";
import { claimEscrowPrize, mapClaimErrorToMessage } from "@/lib/stellar/sorobanClaim";

export interface ClaimPrizeModalProps {
  isOpen: boolean;
  onClose: () => void;
  leagueId: number | string;
  leagueTitle: string;
  winnerAddress: string;
  prizeAmount: number;
  rank: 1 | 2 | 3;
  escrowContractId: string;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  onClaimSuccess?: (txHash: string) => void;
}

export const ClaimPrizeModal: React.FC<ClaimPrizeModalProps> = ({
  isOpen,
  onClose,
  leagueId,
  leagueTitle,
  winnerAddress,
  prizeAmount,
  rank,
  escrowContractId,
  signTransaction,
  onClaimSuccess,
}) => {
  const [status, setStatus] = useState<"idle" | "in_progress" | "success" | "error">("idle");
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [confirmedTxHash, setConfirmedTxHash] = useState<string>("");

  if (!isOpen) return null;

  const rankBadgeText = rank === 1 ? "1st Place (60%)" : rank === 2 ? "2nd Place (30%)" : "3rd Place (10%)";
  const rankBadgeColor =
    rank === 1
      ? "bg-amber-100 text-amber-900 border-amber-300"
      : rank === 2
      ? "bg-slate-100 text-slate-800 border-slate-300"
      : "bg-orange-100 text-orange-900 border-orange-300";

  const handleClaim = async () => {
    setStatus("in_progress");
    setErrorMsg("");
    setProgressMsg("Connecting to Soroban RPC...");

    try {
      const result = await claimEscrowPrize({
        escrowContractId,
        leagueId,
        winnerPublicKey: winnerAddress,
        signTransaction,
        onProgress: (msg) => setProgressMsg(msg),
      });

      setStatus("success");
      setConfirmedTxHash(result.txHash);
      if (onClaimSuccess) onClaimSuccess(result.txHash);
    } catch (err) {
      setStatus("error");
      setErrorMsg(mapClaimErrorToMessage(err));
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
    >
      <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-5 animate-in fade-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
              <IconTrophy className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Claim Escrow Prize</h2>
              <p className="text-xs text-slate-500">{leagueTitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={status === "in_progress"}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-full hover:bg-slate-100 transition-colors"
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Prize Summary Card */}
        <div className="p-4 rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50/50 border border-amber-200/60 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-600">Finishing Rank</span>
            <span className={`px-2 py-0.5 rounded-full font-bold text-[11px] border ${rankBadgeColor}`}>
              {rankBadgeText}
            </span>
          </div>
          <div className="flex items-baseline justify-between pt-1">
            <span className="text-xs text-slate-500 font-medium">Allocated Prize</span>
            <span className="font-mono text-2xl font-black text-slate-950">
              ${prizeAmount.toFixed(2)} <span className="text-xs font-bold text-slate-500">USDC</span>
            </span>
          </div>
        </div>

        {/* Trustless Settlement Notice */}
        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
          <IconShield className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          <p>
            Non-custodial claim: Tokens are transferred directly from the Soroban escrow contract into your Freighter wallet. Platform takes no intermediary custody.
          </p>
        </div>

        {/* Progress or Error Alerts */}
        {status === "in_progress" && (
          <div className="p-3.5 rounded-xl bg-purple-50 border border-purple-200 text-xs text-purple-900 flex items-center gap-2.5">
            <div className="w-3.5 h-3.5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="font-medium">{progressMsg}</span>
          </div>
        )}

        {status === "error" && (
          <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 space-y-1">
            <span className="font-bold">Claim Failed</span>
            <p>{errorMsg}</p>
          </div>
        )}

        {status === "success" && (
          <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1.5">
            <div className="font-bold flex items-center gap-1.5">
              <span>🎉 Prize Claimed Successfully!</span>
            </div>
            <p className="font-mono text-[11px] break-all text-slate-600">Tx: {confirmedTxHash}</p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={status === "in_progress"}
            className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-colors"
          >
            {status === "success" ? "Done" : "Cancel"}
          </button>

          {status !== "success" && (
            <button
              type="button"
              onClick={handleClaim}
              disabled={status === "in_progress"}
              className="px-5 py-2.5 text-xs font-bold text-white bg-[#37003c] hover:bg-[#28002c] disabled:opacity-50 rounded-xl shadow-sm transition-all"
            >
              {status === "in_progress" ? "Claiming..." : "Confirm & Claim Prize"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
