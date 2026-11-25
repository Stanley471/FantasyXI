"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  IconShield,
  IconTrophy,
  AlertTriangleIcon,
  IconCheck,
  RefreshIcon,
  DownloadIcon,
} from "@/components/ui/Icons";

// ─── Types ──────────────────────────────────────────────────────────────────

type ContestRecord = {
  contestId: string;
  contestName: string;
  entryFee: number;
  payout: number;
  platformFee: number;
  netResult: number;
  settledAt: string;
  currency: string;
  exchangeRateAtSettlement?: number;
};

type AnnualSummary = {
  year: number;
  totalEntryFees: number;
  totalPayouts: number;
  totalPlatformFees: number;
  netWinnings: number;
  costBasis: number;
  contestsPlayed: number;
  contestsWon: number;
  thresholdFlagged: boolean;
  thresholdAmount: number;
  thresholdJurisdiction: string;
};

type ExportJob = {
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed";
  downloadUrl?: string;
  expiresAt?: string;
  format: "csv" | "json";
  year: number;
  createdAt: string;
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ComplianceExportPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [records, setRecords] = useState<ContestRecord[]>([]);
  const [summaries, setSummaries] = useState<AnnualSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | "all">("all");
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [requestingExport, setRequestingExport] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [recordsRes, summariesRes] = await Promise.all([
        api.get<{ records: ContestRecord[] }>("/api/compliance/transactions"),
        api.get<{ summaries: AnnualSummary[] }>("/api/compliance/annual-summaries"),
      ]);
      setRecords(recordsRes.records ?? []);
      setSummaries(summariesRes.summaries ?? []);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to load compliance data");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && user) fetchData();
  }, [isAuthenticated, user, fetchData]);

  const requestExport = async (format: "csv" | "json", year: number) => {
    try {
      setRequestingExport(true);
      const job = await api.post<ExportJob>("/api/compliance/export", {
        format,
        year,
      });
      setExportJobs((prev) => [job, ...prev]);
      toast.success(`Export requested (${format.toUpperCase()} for ${year}). You'll receive a secure download link.`);
    } catch (err) {
      toast.error("Failed to request export");
    } finally {
      setRequestingExport(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500 flex items-center gap-2">
          <RefreshIcon className="w-5 h-5 animate-spin" />
          Loading compliance data…
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <IconShield className="w-12 h-12 mx-auto text-gray-400" />
          <p className="mt-4 text-gray-600">Please sign in to view compliance reports.</p>
        </div>
      </div>
    );
  }

  const filteredRecords =
    selectedYear === "all"
      ? records
      : records.filter((r) => new Date(r.settledAt).getFullYear() === selectedYear);

  const years = Array.from(new Set(records.map((r) => new Date(r.settledAt).getFullYear()))).sort(
    (a, b) => b - a,
  );

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
            <IconShield className="w-7 h-7 text-indigo-600" />
            Tax & Regulatory Compliance
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Annual prize winnings summary, cost basis, and regulatory threshold monitoring.
          </p>
        </div>

        {/* Threshold Alerts */}
        {summaries.some((s) => s.thresholdFlagged) && (
          <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangleIcon className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-amber-900">Regulatory Threshold Alert</p>
                {summaries
                  .filter((s) => s.thresholdFlagged)
                  .map((s) => (
                    <p key={s.year} className="mt-1 text-sm text-amber-700">
                      {s.year}: Net winnings of{" "}
                      <span className="font-semibold">
                        ${s.netWinnings.toLocaleString()}
                      </span>{" "}
                      exceed the {s.thresholdJurisdiction} threshold of{" "}
                      <span className="font-semibold">
                        ${s.thresholdAmount.toLocaleString()}
                      </span>
                      . Tax reporting may be required.
                    </p>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* Annual Summaries */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Annual Summaries</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map((s) => (
              <div
                key={s.year}
                className="rounded-lg border bg-white p-5 shadow-sm"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold text-gray-900">{s.year}</h3>
                  {s.thresholdFlagged ? (
                    <Badge variant="warning">Threshold Exceeded</Badge>
                  ) : (
                    <Badge variant="success">Below Threshold</Badge>
                  )}
                </div>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Contests Played</dt>
                    <dd className="font-medium">{s.contestsPlayed}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Total Entry Fees</dt>
                    <dd className="font-medium">${s.totalEntryFees.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Total Payouts</dt>
                    <dd className="font-medium text-green-600">
                      ${s.totalPayouts.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Platform Fees</dt>
                    <dd className="font-medium text-red-500">
                      -${s.totalPlatformFees.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex justify-between border-t pt-1 mt-1">
                    <dt className="font-semibold text-gray-700">Net Winnings</dt>
                    <dd
                      className={`font-bold ${
                        s.netWinnings >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      ${s.netWinnings.toLocaleString()}
                    </dd>
                  </div>
                </dl>
                {/* Export buttons */}
                <div className="mt-4 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => requestExport("csv", s.year)}
                    disabled={requestingExport}
                  >
                    <DownloadIcon className="w-4 h-4 mr-1" />
                    CSV
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => requestExport("json", s.year)}
                    disabled={requestingExport}
                  >
                    <DownloadIcon className="w-4 h-4 mr-1" />
                    JSON
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Export Jobs */}
        {exportJobs.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              Export History
            </h2>
            <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Format
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Year
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {exportJobs.map((job) => (
                    <tr key={job.jobId}>
                      <td className="px-4 py-3 text-sm font-medium uppercase">
                        {job.format}
                      </td>
                      <td className="px-4 py-3 text-sm">{job.year}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            job.status === "completed"
                              ? "success"
                              : job.status === "failed"
                                ? "danger"
                                : "default"
                          }
                        >
                          {job.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {job.downloadUrl && job.status === "completed" ? (
                          <a
                            href={job.downloadUrl}
                            className="text-indigo-600 hover:text-indigo-700 text-sm font-medium"
                          >
                            Download (expires {job.expiresAt})
                          </a>
                        ) : (
                          <span className="text-gray-400 text-sm">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Transaction History */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Contest Transaction History
            </h2>
            <select
              value={selectedYear}
              onChange={(e) =>
                setSelectedYear(
                  e.target.value === "all" ? "all" : parseInt(e.target.value),
                )
              }
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="all">All Years</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Contest
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Entry Fee
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Payout
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Platform Fee
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Net
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Settled
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredRecords.map((r) => (
                  <tr key={r.contestId}>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {r.contestName}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      ${r.entryFee.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-green-600">
                      ${r.payout.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-red-500">
                      -${r.platformFee.toLocaleString()}
                    </td>
                    <td
                      className={`px-4 py-3 text-sm text-right font-medium ${
                        r.netResult >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      ${r.netResult.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {new Date(r.settledAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
