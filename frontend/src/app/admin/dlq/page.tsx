"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  RefreshIcon,
  IconCheck,
  SearchIcon,
  IconShield,
} from "@/components/ui/Icons";

// ─── Types ──────────────────────────────────────────────────────────────────

type ErrorCategory = "transient" | "deterministic";

type DlqJob = {
  jobId: string;
  jobName: string;
  queueName: string;
  status: "quarantined" | "dlq" | "retry_scheduled";
  errorCategory: ErrorCategory;
  errorMessage: string;
  errorStack?: string;
  attempts: number;
  maxRetries: number;
  lastAttemptAt: string;
  createdAt: string;
  payload?: Record<string, unknown>;
};

type CircuitBreakerStatus = {
  queueName: string;
  tripped: boolean;
  failureRatePct: number;
  thresholdPct: number;
  windowMs: number;
  trippedAt?: string;
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function DlqDashboardPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [jobs, setJobs] = useState<DlqJob[]>([]);
  const [circuitBreakers, setCircuitBreakers] = useState<CircuitBreakerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | ErrorCategory>("all");
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<DlqJob | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get<{ jobs: DlqJob[]; circuitBreakers: CircuitBreakerStatus[] }>(
        "/api/admin/dlq",
      );
      setJobs(res.jobs ?? []);
      setCircuitBreakers(res.circuitBreakers ?? []);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Failed to load DLQ jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchJobs();
  }, [isAuthenticated, fetchJobs]);

  const replayJob = async (jobId: string) => {
    try {
      setReplaying(jobId);
      await api.post(`/api/admin/dlq/${jobId}/replay`, {});
      toast.success("Job re-submitted to active queue.");
      await fetchJobs();
    } catch (err) {
      toast.error("Failed to replay job");
    } finally {
      setReplaying(null);
    }
  };

  const bulkReplay = async (jobIds: string[]) => {
    try {
      setReplaying("bulk");
      await api.post("/api/admin/dlq/bulk-replay", { jobIds });
      toast.success(`${jobIds.length} jobs re-submitted.`);
      await fetchJobs();
    } catch (err) {
      toast.error("Bulk replay failed");
    } finally {
      setReplaying(null);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500 flex items-center gap-2">
          <RefreshIcon className="w-5 h-5 animate-spin" />
          Loading DLQ dashboard…
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <IconShield className="w-12 h-12 mx-auto text-gray-400" />
          <p className="mt-4 text-gray-600">Admin access required.</p>
        </div>
      </div>
    );
  }

  const filtered = jobs.filter((j) => {
    if (filter !== "all" && j.errorCategory !== filter) return false;
    if (search && !j.jobName.toLowerCase().includes(search.toLowerCase()) && !j.errorMessage.toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
            <AlertCircleIcon className="w-7 h-7 text-red-500" />
            Dead Letter Queue
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Inspect, quarantine, and replay failed background jobs.
          </p>
        </div>

        {/* Circuit Breakers */}
        {circuitBreakers.length > 0 && (
          <div className="mb-6 space-y-2">
            {circuitBreakers.map((cb) => (
              <div
                key={cb.queueName}
                className={`rounded-lg border p-4 ${
                  cb.tripped
                    ? "bg-red-50 border-red-200"
                    : "bg-green-50 border-green-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangleIcon
                      className={`w-5 h-5 ${cb.tripped ? "text-red-500" : "text-green-500"}`}
                    />
                    <span className="font-medium text-gray-900">
                      Circuit Breaker: {cb.queueName}
                    </span>
                  </div>
                  <Badge variant={cb.tripped ? "danger" : "success"}>
                    {cb.tripped ? "TRIPPED" : "HEALTHY"}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Failure rate:{" "}
                  <span className="font-mono font-medium">
                    {cb.failureRatePct.toFixed(1)}%
                  </span>{" "}
                  / threshold:{" "}
                  <span className="font-mono">
                    {cb.thresholdPct}%
                  </span>{" "}
                  (window: {cb.windowMs / 1000}s)
                </p>
                {cb.tripped && cb.trippedAt && (
                  <p className="mt-1 text-xs text-red-600">
                    Tripped at {new Date(cb.trippedAt).toLocaleString()}.
                    Queue consumption paused to prevent cascade failures.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <SearchIcon className="w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by job name or error…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm w-64"
            />
          </div>
          <div className="flex gap-1">
            {(["all", "transient", "deterministic"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                  filter === f
                    ? "bg-indigo-100 text-indigo-700"
                    : "text-gray-500 hover:bg-gray-100"
                }`}
              >
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          {filtered.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => bulkReplay(filtered.map((j) => j.jobId))}
              disabled={replaying === "bulk"}
            >
              {replaying === "bulk" ? (
                <RefreshIcon className="w-4 h-4 animate-spin mr-1" />
              ) : null}
              Bulk Replay ({filtered.length})
            </Button>
          )}
        </div>

        {/* Job Table */}
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Job
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Queue
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Category
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Error
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">
                  Attempts
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Status
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map((job) => (
                <tr key={job.jobId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {job.jobName}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{job.queueName}</td>
                  <td className="px-4 py-3">
                    <Badge variant={job.errorCategory === "transient" ? "warning" : "danger"}>
                      {job.errorCategory}
                    </Badge>
                  </td>
                  <td
                    className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate"
                    title={job.errorMessage}
                  >
                    {job.errorMessage}
                  </td>
                  <td className="px-4 py-3 text-sm text-center font-mono">
                    {job.attempts}/{job.maxRetries}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        job.status === "quarantined"
                          ? "danger"
                          : job.status === "retry_scheduled"
                            ? "warning"
                            : "default"
                      }
                    >
                      {job.status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedJob(job)}
                      >
                        Inspect
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => replayJob(job.jobId)}
                        disabled={replaying === job.jobId}
                      >
                        {replaying === job.jobId ? (
                          <RefreshIcon className="w-4 h-4 animate-spin" />
                        ) : (
                          "Replay"
                        )}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="py-12 text-center">
              <IconCheck className="w-10 h-10 mx-auto text-green-400" />
              <p className="mt-2 text-sm text-gray-500">No failed jobs in the DLQ.</p>
            </div>
          )}
        </div>

        {/* Inspect Modal */}
        {selectedJob && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setSelectedJob(null)}
          >
            <div
              className="max-w-3xl w-full max-h-[80vh] overflow-auto rounded-lg bg-white shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="border-b px-6 py-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  {selectedJob.jobName} — Execution Context
                </h3>
              </div>
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500">Job ID</p>
                    <p className="font-mono text-xs">{selectedJob.jobId}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Queue</p>
                    <p className="font-medium">{selectedJob.queueName}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Category</p>
                    <Badge
                      variant={
                        selectedJob.errorCategory === "transient"
                          ? "warning"
                          : "danger"
                      }
                    >
                      {selectedJob.errorCategory}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-gray-500">Attempts</p>
                    <p className="font-mono">
                      {selectedJob.attempts} / {selectedJob.maxRetries}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Created</p>
                    <p className="text-xs">
                      {new Date(selectedJob.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Last Attempt</p>
                    <p className="text-xs">
                      {new Date(selectedJob.lastAttemptAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-500 mb-1">Error Message</p>
                  <pre className="rounded-md bg-gray-50 border p-3 text-xs text-red-600 overflow-auto">
                    {selectedJob.errorMessage}
                  </pre>
                </div>
                {selectedJob.errorStack && (
                  <div>
                    <p className="text-sm text-gray-500 mb-1">Stack Trace</p>
                    <pre className="rounded-md bg-gray-50 border p-3 text-xs overflow-auto max-h-48">
                      {selectedJob.errorStack}
                    </pre>
                  </div>
                )}
                {selectedJob.payload && (
                  <div>
                    <p className="text-sm text-gray-500 mb-1">Payload</p>
                    <pre className="rounded-md bg-gray-50 border p-3 text-xs overflow-auto max-h-48">
                      {JSON.stringify(selectedJob.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
              <div className="border-t px-6 py-3 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSelectedJob(null)}
                >
                  Close
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    replayJob(selectedJob.jobId);
                    setSelectedJob(null);
                  }}
                  disabled={replaying === selectedJob.jobId}
                >
                  Replay Job
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
