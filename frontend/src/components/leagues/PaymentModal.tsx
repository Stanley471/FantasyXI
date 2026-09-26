"use client";

import React, { useState, useEffect } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { useWallet, type WalletProviderId } from "@/context/WalletContext";
import {
  IconClose,
  IconCopy,
  IconCheck,
  IconAlertCircle,
  IconShield,
  IconWallet,
  IconChevronDown,
  IconChevronUp,
} from "@/components/ui/Icons";
import { depositToSorobanEscrow, SorobanDepositTimeoutError } from "@/lib/stellar/sorobanDeposit";
import { mapDepositErrorToMessage } from "@/lib/stellar/depositErrorMessage";

export interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  leagueId: string;
  leagueName: string;
  squadId: string;
  entryFee: number;
  onPaymentSuccess?: (deposit: { txHash: string; ledgerSeq?: number }) => void;
}

interface PaymentRequirementData {
  leagueId: string;
  leagueName: string;
  entryFee: number;
  assetCode: string;
  assetIssuer?: string;
  destinationAddress: string;
  escrowContractId?: string;
  memo?: string;
  paymentStatus: string;
}

type DepositStep =
  | "idle"
  | "connecting"
  | "simulating"
  | "signing"
  | "submitting"
  | "confirming"
  | "verifying"
  | "success";

const FALLBACK_ESCROW_CONTRACT_ID =
  process.env.NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID ||
  "CB4KIK42P32SZHKG4JBDCJUV4A4KGCDN6RHOOTIFSBGZHS2IF653VOEA";

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  leagueId,
  leagueName,
  squadId,
  entryFee,
  onPaymentSuccess,
}) => {
  const [requirement, setRequirement] = useState<PaymentRequirementData | null>(null);
  const [isLoadingReq, setIsLoadingReq] = useState<boolean>(false);
  const [step, setStep] = useState<DepositStep>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [connectedAccount, setConnectedAccount] = useState<string | null>(null);
  const [confirmedTxHash, setConfirmedTxHash] = useState<string | null>(null);
  const [showWalletPicker, setShowWalletPicker] = useState<boolean>(false);
  // A deposit that was signed and submitted but whose confirmation we lost track of
  // (network drop / RPC timeout). Retrying must re-check this hash, never resubmit.
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState<boolean>(false);
  const {
    wallets,
    selectedWallet,
    publicKey,
    isConnecting,
    error: walletError,
    connect,
    disconnect,
    signTransaction,
  } = useWallet();

  // Advanced / manual hash fallback state
  const [showManualFallback, setShowManualFallback] = useState<boolean>(false);
  const [manualTxHash, setManualTxHash] = useState<string>("");
  const [manualAddress, setManualAddress] = useState<string>("");
  const [isManualVerifying, setIsManualVerifying] = useState<boolean>(false);

  // Fetch requirement upon opening
  useEffect(() => {
    if (!isOpen || !leagueId || !squadId) return;

    async function loadRequirement() {
      setIsLoadingReq(true);
      setErrorMsg(null);
      setStep("idle");
      setPendingTxHash(null);
      try {
        const res = await api.get<{ success: boolean; data: PaymentRequirementData }>(
          `/api/v1/leagues/${leagueId}/payment-requirement?squadId=${squadId}`
        );
        if (res?.data) {
          setRequirement(res.data);
        }
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          setErrorMsg(err.message || "Failed to load payment requirement");
        } else {
          setErrorMsg("Could not connect to financial escrow service.");
        }
      } finally {
        setIsLoadingReq(false);
      }
    }

    loadRequirement();
  }, [isOpen, leagueId, squadId]);

  if (!isOpen) return null;

  const copyToClipboard = (text: string, fieldName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(fieldName);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const effectiveContractId =
    requirement?.escrowContractId ||
    requirement?.destinationAddress ||
    FALLBACK_ESCROW_CONTRACT_ID;

  /**
   * Primary canonical flow: deposit via Freighter Soroban invocation
   */
  const handleWalletDeposit = async () => {
    if (!selectedWallet || !publicKey) {
      setShowWalletPicker(true);
      return;
    }

    setErrorMsg(null);
    setPendingTxHash(null);
    setStep("connecting");
    setStatusMessage("Preparing wallet transaction...");

    try {
      setConnectedAccount(publicKey);
      setStep("simulating");
      const depositResult = await depositToSorobanEscrow({
        escrowContractId: effectiveContractId,
        leagueId,
        userPublicKey: publicKey,
        signTransaction,
        onProgress: (status) => {
          setStatusMessage(status);
          if (status.includes("Simulating")) setStep("simulating");
          else if (status.includes("signature")) setStep("signing");
          else if (status.includes("Submitting")) setStep("submitting");
          else if (status.includes("Confirming")) setStep("confirming");
        },
      });

      const txHash = depositResult.txHash;
      setConfirmedTxHash(txHash);

      // 3. Register transaction with FantasyXI backend
      setStep("verifying");
      setStatusMessage("Verifying escrow deposit with FantasyXI backend...");

      await api.post(`/api/v1/leagues/${leagueId}/submit-payment`, {
        stellarTxHash: txHash,
        stellarAddress: publicKey,
      });

      // 4. Confirm verification
      const verifyRes = await api.post<{
        success: boolean;
        message: string;
        data?: unknown;
      }>(`/api/v1/leagues/${leagueId}/verify-payment`, {
        stellarTxHash: txHash,
      });

      if (verifyRes?.success) {
        setStep("success");
        setTimeout(() => {
          onPaymentSuccess?.({ txHash, ledgerSeq: depositResult.ledgerSeq });
          onClose();
        }, 2200);
      } else {
        throw new Error(
          verifyRes?.message || "Payment verification failed on backend"
        );
      }
    } catch (err: unknown) {
      setStep("idle");

      if (err instanceof SorobanDepositTimeoutError) {
        // The deposit may have actually succeeded on-chain; keep the hash around so
        // "retry" re-checks it via the backend instead of signing a brand new payment.
        setPendingTxHash(err.txHash);
        setErrorMsg(err.message);
        return;
      }

      setErrorMsg(mapDepositErrorToMessage(err));
    }
  };

  /**
   * Retry path for a deposit whose confirmation timed out client-side. Re-checks the
   * Soroban escrow contract for this member's deposit instead of signing a new
   * transaction, so a slow confirmation can never result in a double payment.
   */
  const handleReconcileRetry = async () => {
    setErrorMsg(null);
    setIsReconciling(true);
    try {
      const res = await api.post<{
        success: boolean;
        message: string;
        data?: { txHash?: string };
      }>(`/api/v1/leagues/${leagueId}/reconcile-deposit`);

      if (res?.success) {
        setStep("success");
        setConfirmedTxHash(pendingTxHash);
        setTimeout(() => {
          onPaymentSuccess?.({ txHash: pendingTxHash || "" });
          onClose();
        }, 2200);
      } else {
        setErrorMsg(
          res?.message ||
            "No confirmed deposit was found yet. If you just submitted the transaction, wait a few seconds and retry."
        );
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMsg(err.message || "Could not verify your deposit. Please retry.");
      } else {
        setErrorMsg("Could not reach the FantasyXI backend to reconcile your deposit.");
      }
    } finally {
      setIsReconciling(false);
    }
  };

  const handleWalletConnect = async (walletId: WalletProviderId) => {
    try {
      await connect(walletId);
      setShowWalletPicker(false);
    } catch {
      // The provider exposes the detailed error through WalletContext.
    }
  };

  /**
   * Fallback flow: manual hash submission & verification
   */
  const handleManualSubmitAndVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanHash = manualTxHash.trim();
    const cleanAddr =
      manualAddress.trim() || connectedAccount || "G_SUBMITTED_MANUALLY";

    if (!cleanHash) {
      setErrorMsg("Please provide a valid 64-character Stellar transaction hash.");
      return;
    }

    setIsManualVerifying(true);

    try {
      // 1. Submit payment
      await api.post(`/api/v1/leagues/${leagueId}/submit-payment`, {
        stellarTxHash: cleanHash,
        stellarAddress: cleanAddr,
      });

      // 2. Verify payment
      const verifyRes = await api.post<{
        success: boolean;
        message: string;
        data?: unknown;
      }>(`/api/v1/leagues/${leagueId}/verify-payment`, {
        stellarTxHash: cleanHash,
      });

      if (verifyRes?.success) {
        setStep("success");
        setConfirmedTxHash(cleanHash);
        setTimeout(() => {
          onPaymentSuccess?.({ txHash: cleanHash });
          onClose();
        }, 2000);
      } else {
        setErrorMsg(
          "Payment verification failed. Please verify the transaction succeeded on Stellar Testnet."
        );
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMsg(
          err.message || "Verification failed. Check your transaction hash."
        );
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg("Failed to communicate with Stellar verification service.");
      }
    } finally {
      setIsManualVerifying(false);
    }
  };

  const isWorking =
    step === "connecting" ||
    step === "simulating" ||
    step === "signing" ||
    step === "submitting" ||
    step === "confirming" ||
    step === "verifying";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-lg bg-pitch-surface border border-pitch-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-pitch-border flex items-center justify-between bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20">
              <IconShield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white uppercase tracking-tight">
                Soroban Escrow Deposit
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">{leagueName}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isWorking}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <IconClose className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {isLoadingReq ? (
            <div className="py-12 text-center text-slate-400">
              <div className="inline-block w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-xs">Connecting to Soroban escrow contract...</p>
            </div>
          ) : step === "success" ? (
            <div className="py-8 text-center space-y-4 animate-fadeIn">
              <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto border border-emerald-500/30">
                <IconCheck className="w-9 h-9" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Deposit Confirmed!</h3>
                <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                  Your entry fee of {requirement?.entryFee ?? entryFee} USDC is now
                  secured in the Soroban escrow smart contract. Your squad is ACTIVE
                  in {leagueName}.
                </p>
              </div>
              {confirmedTxHash && (
                <div className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 text-[11px] font-mono text-slate-400 max-w-sm mx-auto break-all">
                  Tx: {confirmedTxHash}
                </div>
              )}
            </div>
          ) : (
            <>
              {errorMsg && (
                <div className="p-3.5 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs flex items-start gap-2.5 animate-shake">
                  <IconAlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <span className="font-medium">{errorMsg}</span>
                </div>
              )}

              {/* Required Amount Card */}
              <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider">
                    Required Entry Fee
                  </div>
                  <div className="text-2xl font-black text-emerald-400 font-mono mt-0.5">
                    {requirement?.entryFee ?? entryFee} USDC
                  </div>
                </div>
                <div className="text-right text-[11px] space-y-0.5">
                  <div className="text-emerald-400 font-mono font-semibold text-[11px] tracking-wider uppercase">
                    Stellar Testnet
                  </div>
                  <div className="font-mono text-xs text-slate-400">Soroban Contract</div>
                </div>
              </div>

              {/* Escrow Contract Address */}
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-slate-400 font-semibold">
                  <span>Escrow Contract ID</span>
                  {copiedField === "contract" && (
                    <span className="text-emerald-400 text-[10px]">Copied!</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={effectiveContractId}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-300 font-mono text-[11px] focus:outline-none"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => copyToClipboard(effectiveContractId, "contract")}
                    title="Copy Escrow Contract ID"
                  >
                    <IconCopy className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              {/* Status / In Progress Display */}
              {isWorking && (
                <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 text-center space-y-2">
                  <div className="inline-block w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs font-semibold text-emerald-300">{statusMessage}</p>
                  <p className="text-[11px] text-slate-400">
                    {step === "signing"
                      ? "Please review and approve the transaction in the Freighter popup."
                      : "Please wait while your transaction is processed on the Stellar ledger."}
                  </p>
                </div>
              )}

              {/* Retry state: a deposit whose confirmation timed out. Never resubmits a
                  new payment — only re-checks the escrow contract for the same deposit. */}
              {!isWorking && pendingTxHash && (
                <div className="p-4 rounded-xl bg-amber-950/20 border border-amber-500/30 space-y-3">
                  <p className="text-xs text-amber-300 font-semibold">
                    Your transaction may still be confirming on-chain.
                  </p>
                  <div className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 text-[11px] font-mono text-slate-400 break-all">
                    Tx: {pendingTxHash}
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    onClick={handleReconcileRetry}
                    isLoading={isReconciling}
                    disabled={isReconciling}
                    className="w-full justify-center uppercase font-bold tracking-wide text-xs py-3.5"
                  >
                    Retry: Check Deposit Status
                  </Button>
                </div>
              )}

              {/* Unified wallet connection and deposit action */}
              {!isWorking && !pendingTxHash && (
                <div className="space-y-2.5 pt-1">
                  {selectedWallet && publicKey ? (
                    <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-emerald-950/20 border border-emerald-500/30">
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold">
                          {wallets.find((wallet) => wallet.id === selectedWallet)?.name || selectedWallet} connected
                        </div>
                        <div className="truncate text-[11px] font-mono text-slate-300 mt-1">{publicKey}</div>
                      </div>
                      <button type="button" onClick={() => disconnect()} className="shrink-0 text-[11px] text-slate-400 hover:text-white underline">
                        Change
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowWalletPicker(true)}
                      className="w-full flex items-center justify-between p-3 rounded-lg bg-slate-950/70 border border-slate-700 hover:border-emerald-500/50 transition-colors text-left"
                    >
                      <span>
                        <span className="block text-xs font-bold text-white">Connect a Stellar wallet</span>
                        <span className="block text-[11px] text-slate-500 mt-0.5">Freighter, Albedo, xBull, or WalletConnect</span>
                      </span>
                      <IconWallet className="w-4 h-4 text-emerald-400" />
                    </button>
                  )}

                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    onClick={handleWalletDeposit}
                    disabled={isWorking || !publicKey}
                    className="w-full justify-center uppercase font-bold tracking-wide text-xs py-3.5"
                  >
                    <IconWallet className="w-4 h-4 mr-2" />
                    Pay {requirement?.entryFee ?? entryFee} USDC
                  </Button>
                  <p className="text-[11px] text-slate-500 text-center">
                    Invokes <code className="text-emerald-400">deposit(participant, league_id)</code> directly through your selected wallet.
                  </p>
                </div>
              )}

              {walletError && (
                <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-500/30 text-amber-300 text-xs">
                  {walletError}
                </div>
              )}

              {/* Collapsible Manual Verification Section */}
              <div className="pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowManualFallback(!showManualFallback)}
                  className="w-full flex items-center justify-between text-[11px] text-slate-400 hover:text-slate-200 transition-colors py-1"
                >
                  <span className="font-semibold uppercase tracking-wider">
                    Advanced: Manual Hash Verification
                  </span>
                  {showManualFallback ? (
                    <IconChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <IconChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>

                {showManualFallback && (
                  <form
                    onSubmit={handleManualSubmitAndVerify}
                    className="mt-3 space-y-3 p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 animate-fadeIn"
                  >
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                        Your Stellar Public Key (G...)
                      </label>
                      <input
                        type="text"
                        value={manualAddress}
                        onChange={(e) => setManualAddress(e.target.value)}
                        placeholder="e.g. GA..."
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                        Stellar Transaction Hash <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        value={manualTxHash}
                        onChange={(e) => setManualTxHash(e.target.value)}
                        placeholder="64-character hex transaction hash"
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                      />
                    </div>

                    <Button
                      type="submit"
                      variant="secondary"
                      size="sm"
                      isLoading={isManualVerifying}
                      disabled={isManualVerifying || !manualTxHash.trim()}
                      className="w-full justify-center text-xs font-semibold"
                    >
                      Verify Transaction Hash
                    </Button>
                  </form>
                )}
              </div>
            </>
          )}
        </div>

        {showWalletPicker && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-4 bg-slate-950/95">
            <div className="w-full max-w-sm space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-white">Connect wallet</h3>
                  <p className="text-xs text-slate-400 mt-1">Choose how to sign your Soroban deposit.</p>
                </div>
                <button type="button" onClick={() => setShowWalletPicker(false)} className="p-1.5 text-slate-400 hover:text-white" aria-label="Close wallet picker">
                  <IconClose className="w-5 h-5" />
                </button>
              </div>
              <div className="space-y-2">
                {wallets.map((wallet) => (
                  <button
                    key={wallet.id}
                    type="button"
                    disabled={isConnecting || !wallet.isAvailable}
                    onClick={() => handleWalletConnect(wallet.id)}
                    className="w-full flex items-center gap-3 p-3 rounded-lg bg-slate-900 border border-slate-800 hover:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed text-left"
                  >
                    <img src={wallet.icon} alt="" className="w-8 h-8 rounded-lg" />
                    <span className="flex-1">
                      <span className="block text-sm font-semibold text-white">{wallet.name}</span>
                      <span className="block text-[11px] text-slate-500">{wallet.isAvailable ? "Available" : "Install or enable wallet"}</span>
                    </span>
                    {selectedWallet === wallet.id && <IconCheck className="w-4 h-4 text-emerald-400" />}
                  </button>
                ))}
              </div>
              {!wallets.some((wallet) => wallet.id === "wallet_connect") && (
                <p className="text-[11px] text-slate-500 border-t border-slate-800 pt-3">
                  WalletConnect requires <code className="text-emerald-400">NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code> to be configured.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Footer info */}
        <div className="p-3.5 border-t border-pitch-border bg-slate-950/80 text-center text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
          <IconShield className="w-3.5 h-3.5 text-emerald-500/80" />
          <span>Non-custodial Soroban escrow &bull; 100% on-chain verifiable</span>
        </div>
      </div>
    </div>
  );
};
