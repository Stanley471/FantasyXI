"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useToast } from "@/context/ToastContext";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  IconShield,
  RefreshIcon,
  AlertTriangleIcon,
  IconCheck,
  AlertCircleIcon,
} from "@/components/ui/Icons";

// ─── Types ──────────────────────────────────────────────────────────────────

type LockState = "acquired" | "contended" | "expired" | "stale_token_rejected" | "idle";

type LockStatus = {
  resourceId: string;
  state: LockState;
  fencingToken: number | null;
  acquiredAt: number | null;
  leaseExpiresAt: number | null;
  heartbeatActive: boolean;
  holderId: string | null;
  queuePosition: number | null;
};

type TransferRequest = {
  transferId: string;
  playerId: string;
  fromTeam: string;
  toTeam: string;
  lockStatus: LockStatus;
  lastError?: string;
};

// ─── Component ───────────────────────────────────────────────────────────────

export function TransferLockStatus({
  transferId,
  onLockReleased,
}: {
  transferId: string;
  onLockReleased?: () => void;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [releasing, setReleasing] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get<LockStatus>(
        `/api/transfers/${transferId}/lock-status`,
      );
      setStatus(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setStatus(null);
      }
    } finally {
      setLoading(false);
    }
  }, [transferId]);

  useEffect(() => {
    fetchStatus();
    // Poll lock status every 2s while lock is active
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const releaseLock = async () => {
    try {
      setReleasing(true);
      await api.post(`/api/transfers/${transferId}/release-lock`, {});
      toast.success("Distributed lock released safely.");
      onLockReleased?.();
      await fetchStatus();
    } catch (err) {
      toast.error("Failed to release lock");
    } finally {
      setReleasing(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <RefreshIcon className="w-4 h-4 animate-spin" />
        Checking lock status…
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <IconShield className="w-4 h-4" />
        No active lock for this transfer.
      </div>
    );
  }

  const stateConfig: Record<
    LockState,
    { variant: "success" | "warning" | "danger" | "default"; label: string; icon?: React.ReactNode }
  > = {
    acquired: {
      variant: "success",
      label: "Lock Acquired",
      icon: <IconCheck className="w-4 h-4" />,
    },
    contended: {
      variant: "warning",
      label: "Contended — Waiting in Queue",
      icon: <AlertTriangleIcon className="w-4 h-4" />,
    },
    expired: {
      variant: "danger",
      label: "Lock Expired",
      icon: <AlertCircleIcon className="w-4 h-4" />,
    },
    stale_token_rejected: {
      variant: "danger",
      label: "Stale Fencing Token Rejected",
      icon: <AlertCircleIcon className="w-4 h-4" />,
    },
    idle: {
      variant: "default",
      label: "Idle",
    },
  };

  const cfg = stateConfig[status.state];

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <IconShield className="w-5 h-5 text-indigo-600" />
          <h3 className="text-sm font-semibold text-gray-900">
            Distributed Lock — Fencing Token
          </h3>
        </div>
        <Badge variant={cfg.variant}>
          {cfg.icon}
          <span className="ml-1">{cfg.label}</span>
        </Badge>
      </div>

      <dl className="space-y-1.5 text-sm">
        {status.fencingToken !== null && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Fencing Token</dt>
            <dd className="font-mono font-medium">#{status.fencingToken}</dd>
          </div>
        )}
        {status.holderId && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Lock Holder</dt>
            <dd className="font-mono text-xs">{status.holderId.slice(0, 16)}…</dd>
          </div>
        )}
        {status.queuePosition !== null && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Queue Position</dt>
            <dd className="font-medium">#{status.queuePosition}</dd>
          </div>
        )}
        {status.leaseExpiresAt && (
          <div className="flex justify-between">
            <dt className="text-gray-500">Lease Expires</dt>
            <dd className="font-medium">
              {new Date(status.leaseExpiresAt).toLocaleTimeString()}
            </dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-gray-500">Heartbeat</dt>
          <dd>
            {status.heartbeatActive ? (
              <span className="flex items-center gap-1 text-green-600">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                Active
              </span>
            ) : (
              <span className="text-gray-400">Inactive</span>
            )}
          </dd>
        </div>
      </dl>

      {status.state === "stale_token_rejected" && (
        <div className="mt-3 rounded-md bg-red-50 border border-red-200 p-2">
          <p className="text-xs text-red-700">
            A write was attempted with an outdated fencing token. The database rejected
            the commit to prevent split-brain execution. The lock has been invalidated —
            please retry the transfer.
          </p>
        </div>
      )}

      {status.state === "expired" && (
        <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-2">
          <p className="text-xs text-amber-700">
            The lock lease has expired. The holder crashed or experienced a GC pause.
            The lock was safely released after lease expiry without deadlock.
          </p>
        </div>
      )}

      {(status.state === "acquired" || status.state === "contended") && (
        <div className="mt-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={releaseLock}
            disabled={releasing}
          >
            {releasing ? (
              <RefreshIcon className="w-4 h-4 animate-spin mr-1" />
            ) : null}
            Release Lock
          </Button>
        </div>
      )}
    </div>
  );
}
