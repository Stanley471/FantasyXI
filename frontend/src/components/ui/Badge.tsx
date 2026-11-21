import React from "react";
import { Position, LeagueStatus, MembershipStatus } from "@/types";
import {
  PositionBadge,
  POSITION_COLOR_TOKENS,
  getPositionColorToken,
  normalizePositionCode,
  calculateContrastRatio,
  type PositionBadgeProps,
  type PositionBadgeCode,
  type PositionColorToken,
} from "@/components/ui/PositionBadge";

export {
  PositionBadge,
  POSITION_COLOR_TOKENS,
  getPositionColorToken,
  normalizePositionCode,
  calculateContrastRatio,
  type PositionBadgeProps,
  type PositionBadgeCode,
  type PositionColorToken,
};

interface BadgeProps {
  children?: React.ReactNode;
  variant?: "default" | "primary" | "accent" | "success" | "warning" | "danger" | "neutral";
  size?: "sm" | "md";
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "default",
  size = "md",
  className = "",
}) => {
  const sizeClasses = size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2.5 py-1 text-xs font-semibold";

  const variantClasses: Record<string, string> = {
    default: "bg-slate-100 text-slate-700 border border-slate-200",
    primary: "bg-purple-50 text-[#37003c] border border-purple-200/80 font-bold",
    accent: "bg-amber-50 text-amber-800 border border-amber-200/80 font-bold",
    success: "bg-emerald-50 text-emerald-800 border border-emerald-200/80 font-bold",
    warning: "bg-amber-50 text-amber-800 border border-amber-200/80 font-bold",
    danger: "bg-rose-50 text-rose-700 border border-rose-200/80 font-bold",
    neutral: "bg-slate-50 text-slate-600 border border-slate-200",
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md tracking-wide uppercase tabular-nums ${sizeClasses} ${variantClasses[variant] || variantClasses.default} ${className}`}
    >
      {children}
    </span>
  );
};

export const StatusBadge: React.FC<{ status: LeagueStatus | MembershipStatus | string }> = ({
  status,
}) => {
  switch (status) {
    case LeagueStatus.UPCOMING:
    case MembershipStatus.PENDING:
      return <Badge variant="accent">{status}</Badge>;
    case LeagueStatus.ACTIVE:
    case MembershipStatus.ACTIVE:
      return <Badge variant="primary">{status}</Badge>;
    case LeagueStatus.COMPLETED:
      return <Badge variant="default">{status}</Badge>;
    case LeagueStatus.CANCELLED:
    case MembershipStatus.CANCELLED:
      return <Badge variant="danger">{status}</Badge>;
    case MembershipStatus.REFUNDED:
      return <Badge variant="warning">{status}</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
};

export const LeagueStatusBadge = StatusBadge;

