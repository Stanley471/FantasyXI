"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Notification } from "@/types";
import { IconClose, IconBell, IconCheck } from "@/components/ui/Icons";

export interface NotificationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called whenever the unread count changes, so the bell badge stays in sync. */
  onUnreadCountChange?: (count: number) => void;
}

/**
 * Sliding notification center drawer (issue #500): lists the signed-in
 * user's notifications, supports mark-as-read / clear-all, and deep-links
 * into the target league/wallet screen on click.
 */
export const NotificationDrawer: React.FC<NotificationDrawerProps> = ({
  isOpen,
  onClose,
  onUnreadCountChange,
}) => {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setIsLoading(true);

    api
      .get<{ success: boolean; data: Notification[]; unreadCount: number }>(
        "/api/v1/notifications"
      )
      .then((res) => {
        if (cancelled) return;
        setNotifications(res.data || []);
        onUnreadCountChange?.(res.unreadCount ?? 0);
      })
      .catch((err) => console.error("Failed to load notifications:", err))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadCount]);

  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.isRead) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n))
      );
      try {
        await api.post(`/api/v1/notifications/${notification.id}/read`);
      } catch (err) {
        console.error("Failed to mark notification as read:", err);
      }
    }

    if (notification.link) {
      onClose();
      router.push(notification.link);
    }
  };

  const handleMarkAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    try {
      await api.post("/api/v1/notifications/read-all");
    } catch (err) {
      console.error("Failed to mark all notifications as read:", err);
    }
  };

  const handleClearAll = async () => {
    setNotifications([]);
    try {
      await api.del("/api/v1/notifications");
    } catch (err) {
      console.error("Failed to clear notifications:", err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="notification-drawer">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close notifications"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm animate-fadeIn"
      />

      {/* Sliding Panel */}
      <div className="relative w-full max-w-sm h-full bg-white border-l border-slate-200 shadow-2xl flex flex-col">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-tight flex items-center gap-2">
            <IconBell className="w-4 h-4" />
            Notifications
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 text-[11px] font-semibold">
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={unreadCount === 0}
            className="text-emerald-700 hover:text-emerald-900 disabled:text-slate-300 disabled:cursor-not-allowed"
          >
            Mark all read
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={notifications.length === 0}
            className="text-rose-600 hover:text-rose-800 disabled:text-slate-300 disabled:cursor-not-allowed"
          >
            Clear all
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="py-16 text-center text-slate-400 text-xs">Loading notifications...</div>
          ) : notifications.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-xs">You&apos;re all caught up.</div>
          ) : (
            notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                data-testid={`notification-item-${notification.id}`}
                onClick={() => handleNotificationClick(notification)}
                className={`w-full text-left px-4 py-3 border-b border-slate-100 transition-colors hover:bg-slate-50 flex items-start gap-2 ${
                  notification.isRead ? "" : "bg-emerald-50/60"
                }`}
              >
                {!notification.isRead && (
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-900">{notification.title}</p>
                  {notification.body && (
                    <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{notification.body}</p>
                  )}
                </div>
                {notification.isRead && <IconCheck className="w-3 h-3 text-slate-300 shrink-0 mt-1" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
