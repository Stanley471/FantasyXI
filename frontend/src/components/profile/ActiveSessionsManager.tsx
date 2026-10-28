"use client";

import React, { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";

export interface ActiveSessionItem {
  id: string;
  device: {
    browser: string;
    os: string;
    deviceType: string;
    ip: string;
    userAgent: string;
    fingerprintHash: string;
  };
  createdAt: string;
  lastActiveAt: string;
  isCurrent: boolean;
}

export function ActiveSessionsManager() {
  const [sessions, setSessions] = useState<ActiveSessionItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRevoking, setIsRevoking] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchSessions = async () => {
    setIsLoading(true);
    try {
      const res = await api.get<{
        success: boolean;
        data: {
          currentSessionId: string | null;
          sessions: ActiveSessionItem[];
        };
      }>("/api/v1/auth/sessions");

      if (res?.success && res.data) {
        setSessions(res.data.sessions);
      }
    } catch {
      // fallback if offline or mock
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleRevokeSingle = async (sessionId: string) => {
    setIsRevoking(true);
    setMessage(null);
    try {
      await api.del(`/api/v1/auth/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setMessage("Session successfully revoked.");
    } catch {
      setMessage("Failed to revoke session.");
    } finally {
      setIsRevoking(false);
    }
  };

  const handleRevokeOthers = async () => {
    setIsRevoking(true);
    setMessage(null);
    try {
      const res = await api.post<{ success: boolean; revokedCount: number }>(
        "/api/v1/auth/sessions/revoke-others",
        {}
      );
      setSessions((prev) => prev.filter((s) => s.isCurrent));
      setMessage(`Logged out ${res?.revokedCount ?? "all"} other devices.`);
    } catch {
      setMessage("Failed to log out other devices.");
    } finally {
      setIsRevoking(false);
    }
  };

  const otherSessions = sessions.filter((s) => !s.isCurrent);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm mt-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-lg font-semibold text-white">Active Sessions & Devices</h3>
          <p className="text-sm text-slate-400">
            Manage your logged-in devices and revoke unauthorized access.
          </p>
        </div>
        {otherSessions.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRevokeOthers}
            disabled={isRevoking}
            className="text-rose-400 border-rose-500/30 hover:bg-rose-500/10"
          >
            {isRevoking ? "Revoking..." : "Log out other devices"}
          </Button>
        )}
      </div>

      {message && (
        <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-lg text-sm">
          {message}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 bg-slate-800/40 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-slate-400">No active sessions found.</p>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center justify-between p-4 rounded-xl border ${
                session.isCurrent
                  ? "bg-emerald-500/5 border-emerald-500/30"
                  : "bg-slate-800/30 border-slate-700/50"
              }`}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">
                    {session.device.browser} on {session.device.os}
                  </span>
                  {session.isCurrent && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      This device
                    </span>
                  )}
                  <span className="text-xs text-slate-500 uppercase">
                    {session.device.deviceType}
                  </span>
                </div>
                <div className="text-xs text-slate-400 flex items-center gap-3">
                  <span>IP: {session.device.ip}</span>
                  <span>•</span>
                  <span>
                    Started {new Date(session.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {!session.isCurrent && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRevokeSingle(session.id)}
                  disabled={isRevoking}
                  className="text-xs text-slate-400 hover:text-rose-400 hover:border-rose-500/40"
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
