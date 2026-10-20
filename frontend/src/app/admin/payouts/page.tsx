"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { api } from "@/lib/api";
import { FailedPayoutRecord, FailedPayoutStatus } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  ShieldIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  RefreshIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  SearchIcon,
  InfoIcon,
} from "@/components/ui/Icons";

function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return {
      push: (_url: string) => {},
      replace: (_url: string) => {},
      prefetch: async () => {},
      back: () => {},
      forward: () => {},
      refresh: () => {},
    };
  }
}

export default function AdminPayoutsPage() {
  const router = useSafeRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [records, setRecords] = useState<FailedPayoutRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<FailedPayoutStatus | "ALL">("ALL");
  const [leagueFilter, setLeagueFilter] = useState<string>("");

  // Modals
  const [inspectRecord, setInspectRecord] = useState<FailedPayoutRecord | null>(null);
  const [retryTarget, setRetryTarget] = useState<FailedPayoutRecord | null>(null);
  const [retryNote, setRetryNote] = useState<string>("");
  const [discardTarget, setDiscardTarget] = useState<FailedPayoutRecord | null>(null);
  const [discardReason, setDiscardReason] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const isStaff = user?.role === "ADMIN" || user?.role === "MODERATOR";

  const fetchFailedPayouts = useCallback(async () => {
    if (!isAuthenticated || !isStaff) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") {
        params.set("status", statusFilter);
      }
      if (leagueFilter.trim()) {
        params.set("leagueId", leagueFilter.trim());
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await api.get<{ success: boolean; data: FailedPayoutRecord[] }>(
        `/api/v1/admin/payouts/dead-letter${query}`
      );
      if (res && res.data) {
        setRecords(res.data);
      } else {
        setRecords([]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load dead-letter payouts.";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, isStaff, statusFilter, leagueFilter, toast]);

  useEffect(() => {
    if (!authLoading && isAuthenticated && isStaff) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchFailedPayouts();
    }
  }, [authLoading, isAuthenticated, isStaff, fetchFailedPayouts]);

  const handleCopy = (text: string, id: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
      toast.info("Copied to clipboard");
    }
  };

  const handleConfirmRetry = async () => {
    if (!retryTarget) return;
    setIsSubmitting(true);
    try {
      const res = await api.post<{ success: boolean; message?: string; data?: unknown }>(
        `/api/v1/admin/payouts/dead-letter/${retryTarget.id}/retry`,
        { note: retryNote.trim() || undefined }
      );

      toast.success(res?.message || "Payout re-queued for submission.");
      // Optimistically update status
      setRecords((prev) =>
        prev.map((r) =>
          r.id === retryTarget.id
            ? { ...r, status: FailedPayoutStatus.RETRYING, attempts: r.attempts + 1 }
            : r
        )
      );
      setRetryTarget(null);
      setRetryNote("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to trigger payout retry.";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDiscard = async () => {
    if (!discardTarget) return;
    if (!discardReason.trim()) {
      toast.error("A reason is required to discard a failed payout.");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await api.post<{ success: boolean; message?: string; data?: FailedPayoutRecord }>(
        `/api/v1/admin/payouts/dead-letter/${discardTarget.id}/discard`,
        { reason: discardReason.trim() }
      );

      toast.success(res?.message || "Payout marked as discarded.");
      // Update record in list
      setRecords((prev) =>
        prev.map((r) =>
          r.id === discardTarget.id
            ? { ...r, status: FailedPayoutStatus.DISCARDED, discardReason: discardReason.trim() }
            : r
        )
      );
      setDiscardTarget(null);
      setDiscardReason("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to discard payout.";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 1. Loading state
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">Authenticating staff privileges...</p>
        </div>
      </div>
    );
  }

  // 2. Unauthenticated -> 403 / Redirect state
  if (!isAuthenticated || !user) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
          <div className="w-12 h-12 bg-rose-500/10 text-rose-400 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircleIcon size={24} />
          </div>
          <h1 className="text-xl font-bold mb-2">403 - Forbidden</h1>
          <p className="text-slate-400 text-sm mb-6">
            Authentication is required to access the administrator payout portal.
          </p>
          <Button
            variant="primary"
            className="w-full"
            onClick={() => router.push("/login?redirect=/admin/payouts")}
          >
            Sign In with Staff Account
          </Button>
        </div>
      </div>
    );
  }

  // 3. Not an ADMIN / MODERATOR
  if (!isStaff) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-rose-900/50 rounded-xl p-8 text-center">
          <div className="w-12 h-12 bg-rose-500/10 text-rose-400 rounded-full flex items-center justify-center mx-auto mb-4">
            <ShieldIcon size={24} />
          </div>
          <h1 className="text-xl font-bold mb-2">403 - Access Denied</h1>
          <p className="text-slate-400 text-sm mb-6">
            You do not have staff permissions to inspect or manage dead-letter payouts. Contact your
            system administrator if you believe this is an error.
          </p>
          <Button variant="secondary" className="w-full" onClick={() => router.push("/")}>
            Return to Home
          </Button>
        </div>
      </div>
    );
  }

  const renderStatusBadge = (status: FailedPayoutStatus) => {
    switch (status) {
      case FailedPayoutStatus.PENDING:
        return <Badge variant="warning">Pending</Badge>;
      case FailedPayoutStatus.RETRYING:
        return <Badge variant="primary">Retrying</Badge>;
      case FailedPayoutStatus.RESOLVED:
        return <Badge variant="success">Resolved</Badge>;
      case FailedPayoutStatus.DISCARDED:
        return <Badge variant="neutral">Discarded</Badge>;
      default:
        return <Badge variant="default">{status}</Badge>;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-1">
              <ShieldIcon size={16} /> Admin Portal
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Dead-Letter Payouts
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Inspect on-chain settlement failures, examine Soroban RPC errors, and re-submit or discard transactions safely.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshIcon size={16} className={loading ? "animate-spin" : ""} />}
              onClick={fetchFailedPayouts}
              disabled={loading}
              aria-label="Refresh dead-letter list"
            >
              Refresh
            </Button>
          </div>
        </header>

        {/* Filters bar */}
        <section
          aria-label="Filter dead-letter records"
          className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-1">
              Status:
            </span>
            {(["ALL", FailedPayoutStatus.PENDING, FailedPayoutStatus.RETRYING, FailedPayoutStatus.RESOLVED, FailedPayoutStatus.DISCARDED] as const).map(
              (st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    statusFilter === st
                      ? "bg-emerald-600 text-white font-semibold"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                  aria-pressed={statusFilter === st}
                >
                  {st === "ALL" ? "All Statuses" : st}
                </button>
              )
            )}
          </div>

          <div className="relative min-w-[240px]">
            <input
              type="text"
              placeholder="Filter by League ID..."
              value={leagueFilter}
              onChange={(e) => setLeagueFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              aria-label="Search by League ID"
            />
            <SearchIcon
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            />
          </div>
        </section>

        {/* Error notification */}
        {error && (
          <div
            role="alert"
            className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-sm text-rose-300 flex items-start gap-3"
          >
            <AlertCircleIcon size={20} className="text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button
              onClick={() => setError(null)}
              className="text-slate-400 hover:text-white"
              aria-label="Dismiss error"
            >
              <CloseIcon size={16} />
            </button>
          </div>
        )}

        {/* Table Container */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table
              className="w-full text-left text-sm text-slate-300 border-collapse"
              aria-label="Failed Payouts Dead-Letter Queue"
            >
              <caption className="sr-only">List of failed on-chain payouts requiring manual admin action</caption>
              <thead className="bg-slate-950/60 text-xs uppercase font-semibold text-slate-400 border-b border-slate-800">
                <tr>
                  <th scope="col" className="px-4 py-3.5">ID / Type</th>
                  <th scope="col" className="px-4 py-3.5">League ID</th>
                  <th scope="col" className="px-4 py-3.5">Recipient(s)</th>
                  <th scope="col" className="px-4 py-3.5">Amount</th>
                  <th scope="col" className="px-4 py-3.5">Attempts</th>
                  <th scope="col" className="px-4 py-3.5">Status</th>
                  <th scope="col" className="px-4 py-3.5">Error Trace</th>
                  <th scope="col" className="px-4 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {loading && records.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-slate-500">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        <span>Loading failed payout queue...</span>
                      </div>
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center">
                      <div className="flex flex-col items-center justify-center gap-2 text-slate-500">
                        <CheckIcon size={32} className="text-emerald-500/80 mb-1" />
                        <p className="text-base font-medium text-slate-300">Queue is clear</p>
                        <p className="text-xs">No dead-letter payouts match the selected filter criteria.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  records.map((item) => {
                    const firstRecipient = item.recipients[0] || "Unknown";
                    const truncatedRecipient =
                      firstRecipient.length > 12
                        ? `${firstRecipient.slice(0, 6)}...${firstRecipient.slice(-4)}`
                        : firstRecipient;

                    return (
                      <tr
                        key={item.id}
                        className="hover:bg-slate-800/30 transition-colors focus-within:bg-slate-800/40"
                      >
                        <td className="px-4 py-3 font-mono text-xs">
                          <div className="font-semibold text-slate-200">
                            {item.id.slice(0, 8)}...
                          </div>
                          <span className="text-[10px] uppercase tracking-wide text-slate-400">
                            {item.type}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-300">
                          {item.leagueId.slice(0, 8)}...
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 font-mono text-xs">
                            <span title={firstRecipient}>{truncatedRecipient}</span>
                            {item.recipients.length > 1 && (
                              <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">
                                +{item.recipients.length - 1}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleCopy(firstRecipient, item.id)}
                              className="text-slate-500 hover:text-slate-300 p-0.5"
                              title="Copy full recipient address"
                              aria-label={`Copy address ${firstRecipient}`}
                            >
                              <CopyIcon size={12} />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-semibold text-emerald-400 font-mono text-xs">
                          {String(item.amountPerRecipient)}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span
                            className={`font-mono px-2 py-0.5 rounded text-xs ${
                              item.attempts >= 3
                                ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                                : "bg-slate-800 text-slate-300"
                            }`}
                          >
                            {item.attempts}
                          </span>
                        </td>
                        <td className="px-4 py-3">{renderStatusBadge(item.status)}</td>
                        <td className="px-4 py-3">
                          <div className="max-w-xs truncate text-xs text-rose-300 font-mono" title={item.error}>
                            {item.error}
                          </div>
                          {item.errorCode !== null && (
                            <span className="text-[10px] text-slate-400 font-mono">
                              RPC #{item.errorCode}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setInspectRecord(item)}
                              className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                              aria-label={`Inspect error details for payout ${item.id}`}
                            >
                              Inspect
                            </button>
                            {item.status !== FailedPayoutStatus.RESOLVED &&
                              item.status !== FailedPayoutStatus.DISCARDED && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => setRetryTarget(item)}
                                    className="px-2.5 py-1 text-xs rounded bg-emerald-600/80 hover:bg-emerald-500 text-white font-medium transition"
                                    aria-label={`Retry payout ${item.id}`}
                                  >
                                    Retry
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setDiscardTarget(item)}
                                    className="px-2.5 py-1 text-xs rounded bg-rose-600/80 hover:bg-rose-500 text-white font-medium transition"
                                    aria-label={`Discard payout ${item.id}`}
                                  >
                                    Discard
                                  </button>
                                </>
                              )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Modals */}

        {/* 1. Inspect Error Trace Modal */}
        {inspectRecord && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="inspect-title"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          >
            <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <h2 id="inspect-title" className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <AlertTriangleIcon size={20} className="text-amber-400" />
                    Transaction Error Details
                  </h2>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">ID: {inspectRecord.id}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setInspectRecord(null)}
                  className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"
                  aria-label="Close error inspection"
                >
                  <CloseIcon size={18} />
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-950 p-3 rounded-xl border border-slate-800/80 text-xs">
                <div>
                  <span className="text-slate-500 block uppercase">Status</span>
                  <span className="font-semibold">{renderStatusBadge(inspectRecord.status)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block uppercase">Attempts</span>
                  <span className="font-mono text-slate-200">{inspectRecord.attempts}</span>
                </div>
                <div>
                  <span className="text-slate-500 block uppercase">Recoverable</span>
                  <span className={inspectRecord.recoverable ? "text-emerald-400 font-medium" : "text-amber-400 font-medium"}>
                    {inspectRecord.recoverable ? "Yes (Auto-eligible)" : "No (Admin required)"}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block uppercase">RPC Code</span>
                  <span className="font-mono text-slate-200">{inspectRecord.errorCode ?? "N/A"}</span>
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                  Recipients ({inspectRecord.recipients.length})
                </span>
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-mono max-h-24 overflow-y-auto space-y-1">
                  {inspectRecord.recipients.map((r, i) => (
                    <div key={i} className="text-slate-300">
                      {r}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    Raw Horizon / Soroban RPC Error Trace
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(inspectRecord.error, inspectRecord.id)}
                    className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                  >
                    <CopyIcon size={12} /> Copy Trace
                  </button>
                </div>
                <pre className="bg-slate-950 p-3.5 rounded-lg border border-slate-800 text-rose-300 text-xs font-mono whitespace-pre-wrap break-all max-h-56 overflow-y-auto">
                  {inspectRecord.error}
                </pre>
              </div>

              {inspectRecord.discardReason && (
                <div className="bg-amber-500/10 border border-amber-500/30 p-3 rounded-lg text-xs text-amber-300">
                  <span className="font-semibold block mb-0.5">Discard Reason:</span>
                  {inspectRecord.discardReason}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setInspectRecord(null)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 2. Retry Confirmation Modal */}
        {retryTarget && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="retry-title"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          >
            <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <h2 id="retry-title" className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <RefreshIcon size={18} className="text-emerald-400" />
                    Confirm Payout Retry
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    This action will re-queue transaction {retryTarget.id.slice(0, 8)}... for on-chain submission.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRetryTarget(null)}
                  className="text-slate-400 hover:text-white p-1"
                  aria-label="Cancel retry"
                >
                  <CloseIcon size={18} />
                </button>
              </div>

              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">League:</span>
                  <span className="font-mono text-slate-200">{retryTarget.leagueId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Amount per recipient:</span>
                  <span className="font-mono text-emerald-400 font-semibold">{String(retryTarget.amountPerRecipient)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Recipients:</span>
                  <span className="font-mono text-slate-200">{retryTarget.recipients.length}</span>
                </div>
              </div>

              <div>
                <label htmlFor="retry-note" className="block text-xs font-semibold text-slate-300 mb-1">
                  Audit Note (Optional)
                </label>
                <textarea
                  id="retry-note"
                  rows={2}
                  maxLength={500}
                  value={retryNote}
                  onChange={(e) => setRetryNote(e.target.value)}
                  placeholder="e.g. RPC node recovered, retrying submission..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setRetryTarget(null)} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleConfirmRetry}
                  isLoading={isSubmitting}
                >
                  Confirm & Re-Submit
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 3. Discard / Mark Resolved Modal */}
        {discardTarget && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-title"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          >
            <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl">
              <div className="flex items-start justify-between">
                <div>
                  <h2 id="discard-title" className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <AlertTriangleIcon size={18} className="text-rose-400" />
                    Discard Failed Payout
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Writing off payout {discardTarget.id.slice(0, 8)}... permanently stops automatic retries.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDiscardTarget(null)}
                  className="text-slate-400 hover:text-white p-1"
                  aria-label="Cancel discard"
                >
                  <CloseIcon size={18} />
                </button>
              </div>

              <div className="bg-rose-500/10 border border-rose-500/20 p-3 rounded-lg text-xs text-rose-300">
                Warning: Once discarded, platform workers will never dispatch funds for this record. A mandatory reason is logged to the financial audit trail.
              </div>

              <div>
                <label htmlFor="discard-reason" className="block text-xs font-semibold text-slate-300 mb-1">
                  Mandatory Discard Reason <span className="text-rose-400">*</span>
                </label>
                <textarea
                  id="discard-reason"
                  rows={3}
                  maxLength={500}
                  required
                  value={discardReason}
                  onChange={(e) => setDiscardReason(e.target.value)}
                  placeholder="Explain why this transaction cannot or should not be retried (e.g. Duplicate claim manually resolved off-chain, invalid recipient)..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setDiscardTarget(null)} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleConfirmDiscard}
                  isLoading={isSubmitting}
                  disabled={!discardReason.trim()}
                >
                  Confirm Discard
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
