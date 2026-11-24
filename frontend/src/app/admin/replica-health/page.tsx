"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  IconShield,
  RefreshIcon,
  IconCheck,
  AlertTriangleIcon,
  AlertCircleIcon,
} from "@/components/ui/Icons";

// ─── Types ──────────────────────────────────────────────────────────────────

type ReplicaStatus = {
  replicaId: string;
  region: string;
  lagMs: number;
  currentLsn: string;
  primaryLsn: string;
  healthy: boolean;
  isPrimary: boolean;
  acceptingReads: boolean;
};

type RoutingDecision = {
  endpoint: string;
  routedTo: "primary" | "replica";
  replicaId?: string;
  reason: "read_your_writes" | "low_lag" | "high_lag_fallback" | "no_recent_writes" | "write";
  sessionLsn?: string;
  timestamp: string;
};

type SessionConsistencyState = {
  userId: string;
  lastWriteLsn: string | null;
  waitingForReplica: string | null;
  readYourWritesActive: boolean;
  cookieExpiry: number | null;
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ReplicaHealthPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [replicas, setReplicas] = useState<ReplicaStatus[]>([]);
  const [routingLog, setRoutingLog] = useState<RoutingDecision[]>([]);
  const [sessionState, setSessionState] = useState<SessionConsistencyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(1000);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [replicasRes, routingRes, sessionRes] = await Promise.all([
        api.get<{ replicas: ReplicaStatus[]; lagThreshold: number }>(
          "/api/admin/replica-health",
        ),
        api.get<{ decisions: RoutingDecision[] }>("/api/admin/replica-health/routing-log"),
        api.get<SessionConsistencyState>("/api/admin/replica-health/session-state"),
      ]);
      setReplicas(replicasRes.replicas ?? []);
      setThreshold(replicasRes.lagThreshold ?? 1000);
      setRoutingLog(routingRes.decisions ?? []);
      setSessionState(sessionRes);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Failed to load replica health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) fetchData();
    // Auto-refresh every 5s for live lag tracking
    const interval = setInterval(() => {
      if (isAuthenticated) fetchData();
    }, 5000);
    return () => clearInterval(interval);
  }, [isAuthenticated, fetchData]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500 flex items-center gap-2">
          <RefreshIcon className="w-5 h-5 animate-spin" />
          Loading replica health…
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

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
              <IconShield className="w-7 h-7 text-indigo-600" />
              Read-Replica Lag Tracker
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Multi-region replication lag and read-your-writes consistency guard.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={fetchData}>
            <RefreshIcon className="w-4 h-4 mr-1" />
            Refresh
          </Button>
        </div>

        {/* Session Consistency State */}
        {sessionState && (
          <div className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Session Read-Your-Writes State
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-500">User</p>
                <p className="text-sm font-mono truncate">
                  {sessionState.userId?.slice(0, 16)}…
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Last Write LSN</p>
                <p className="text-sm font-mono">
                  {sessionState.lastWriteLsn ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">R-Y-W Active</p>
                {sessionState.readYourWritesActive ? (
                  <Badge variant="warning">Routing to Primary</Badge>
                ) : (
                  <Badge variant="success">Replica-Safe</Badge>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500">Cookie Expiry</p>
                <p className="text-sm">
                  {sessionState.cookieExpiry
                    ? new Date(sessionState.cookieExpiry).toLocaleTimeString()
                    : "—"}
                </p>
              </div>
            </div>
            {sessionState.waitingForReplica && (
              <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-2">
                <p className="text-xs text-amber-700">
                  Waiting for replica{" "}
                  <span className="font-mono">{sessionState.waitingForReplica}</span>{" "}
                  to catch up to LSN before routing reads back to replicas.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Replica Status Grid */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Replica Status
            </h2>
            <div className="text-sm text-gray-500">
              Safe lag threshold:{" "}
              <span className="font-mono font-medium">{threshold}ms</span>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {replicas.map((r) => {
              const lagPct = Math.min(100, (r.lagMs / threshold) * 100);
              const isOverThreshold = r.lagMs > threshold;
              return (
                <div
                  key={r.replicaId}
                  className={`rounded-lg border p-5 shadow-sm ${
                    r.isPrimary
                      ? "bg-indigo-50 border-indigo-200"
                      : r.healthy && !isOverThreshold
                        ? "bg-white"
                        : "bg-red-50 border-red-200"
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-900">
                      {r.isPrimary ? "PRIMARY" : r.replicaId}
                    </h3>
                    {r.isPrimary ? (
                      <Badge variant="default">Primary</Badge>
                    ) : r.healthy && !isOverThreshold ? (
                      <Badge variant="success">
                        <IconCheck className="w-3 h-3" /> Healthy
                      </Badge>
                    ) : (
                      <Badge variant="danger">
                        <AlertCircleIcon className="w-3 h-3" /> Unhealthy
                      </Badge>
                    )}
                  </div>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Region</dt>
                      <dd className="font-medium">{r.region}</dd>
                    </div>
                    {!r.isPrimary && (
                      <>
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Lag</dt>
                          <dd
                            className={`font-mono font-medium ${
                              isOverThreshold ? "text-red-600" : "text-green-600"
                            }`}
                          >
                            {r.lagMs}ms
                          </dd>
                        </div>
                        {/* Lag bar */}
                        <div className="mt-1 h-2 rounded-full bg-gray-200 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              isOverThreshold ? "bg-red-500" : "bg-green-500"
                            }`}
                            style={{ width: `${lagPct}%` }}
                          />
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Current LSN</dt>
                          <dd className="font-mono text-xs">
                            {r.currentLsn.slice(0, 16)}…
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Primary LSN</dt>
                          <dd className="font-mono text-xs">
                            {r.primaryLsn.slice(0, 16)}…
                          </dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-gray-500">Accepting Reads</dt>
                          <dd>
                            {r.acceptingReads ? (
                              <span className="text-green-600">Yes</span>
                            ) : (
                              <span className="text-red-600">No (fallback to primary)</span>
                            )}
                          </dd>
                        </div>
                      </>
                    )}
                  </dl>
                </div>
              );
            })}
          </div>
        </div>

        {/* Routing Decision Log */}
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Recent Routing Decisions
          </h2>
          <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Time
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Endpoint
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Routed To
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Reason
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Session LSN
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {routingLog.slice(0, 50).map((d, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {new Date(d.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono">{d.endpoint}</td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={
                          d.routedTo === "primary" ? "warning" : "success"
                        }
                      >
                        {d.routedTo}
                        {d.replicaId ? ` (${d.replicaId})` : ""}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {d.reason.replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-500">
                      {d.sessionLsn?.slice(0, 16) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {routingLog.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-sm text-gray-400">No routing decisions logged yet.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
