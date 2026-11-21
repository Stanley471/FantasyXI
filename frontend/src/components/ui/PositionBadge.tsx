import React from "react";
import { Position } from "@/types";

export type PositionBadgeCode = "GKP" | "DEF" | "MID" | "FWD";

export interface PositionColorToken {
  position: PositionBadgeCode;
  colorFamily: "Amber" | "Blue" | "Green" | "Red";
  bgVar: string;
  fgVar: string;
  borderVar: string;
  bgHex: string;
  fgHex: string;
  borderHex: string;
  className: string;
  jerseyClassName: string;
  pitchTokenClassName: string;
}

export const POSITION_COLOR_TOKENS: Record<PositionBadgeCode, PositionColorToken> = {
  GKP: {
    position: "GKP",
    colorFamily: "Amber",
    bgVar: "var(--pos-gkp-bg, #b45309)",
    fgVar: "var(--pos-gkp-fg, #ffffff)",
    borderVar: "var(--pos-gkp-border, #92400e)",
    bgHex: "#b45309",
    fgHex: "#ffffff",
    borderHex: "#92400e",
    className:
      "bg-[var(--pos-gkp-bg,#b45309)] text-[var(--pos-gkp-fg,#ffffff)] border border-[var(--pos-gkp-border,#92400e)]",
    jerseyClassName:
      "from-amber-700 to-amber-800 border-amber-400 text-white",
    pitchTokenClassName:
      "bg-[var(--pos-gkp-bg,#b45309)] border-amber-300 text-[var(--pos-gkp-fg,#ffffff)]",
  },
  DEF: {
    position: "DEF",
    colorFamily: "Blue",
    bgVar: "var(--pos-def-bg, #1d4ed8)",
    fgVar: "var(--pos-def-fg, #ffffff)",
    borderVar: "var(--pos-def-border, #1e40af)",
    bgHex: "#1d4ed8",
    fgHex: "#ffffff",
    borderHex: "#1e40af",
    className:
      "bg-[var(--pos-def-bg,#1d4ed8)] text-[var(--pos-def-fg,#ffffff)] border border-[var(--pos-def-border,#1e40af)]",
    jerseyClassName:
      "from-blue-700 to-blue-800 border-blue-400 text-white",
    pitchTokenClassName:
      "bg-[var(--pos-def-bg,#1d4ed8)] border-blue-300 text-[var(--pos-def-fg,#ffffff)]",
  },
  MID: {
    position: "MID",
    colorFamily: "Green",
    bgVar: "var(--pos-mid-bg, #15803d)",
    fgVar: "var(--pos-mid-fg, #ffffff)",
    borderVar: "var(--pos-mid-border, #166534)",
    bgHex: "#15803d",
    fgHex: "#ffffff",
    borderHex: "#166534",
    className:
      "bg-[var(--pos-mid-bg,#15803d)] text-[var(--pos-mid-fg,#ffffff)] border border-[var(--pos-mid-border,#166534)]",
    jerseyClassName:
      "from-green-700 to-green-800 border-green-400 text-white",
    pitchTokenClassName:
      "bg-[var(--pos-mid-bg,#15803d)] border-green-300 text-[var(--pos-mid-fg,#ffffff)]",
  },
  FWD: {
    position: "FWD",
    colorFamily: "Red",
    bgVar: "var(--pos-fwd-bg, #b91c1c)",
    fgVar: "var(--pos-fwd-fg, #ffffff)",
    borderVar: "var(--pos-fwd-border, #991b1b)",
    bgHex: "#b91c1c",
    fgHex: "#ffffff",
    borderHex: "#991b1b",
    className:
      "bg-[var(--pos-fwd-bg,#b91c1c)] text-[var(--pos-fwd-fg,#ffffff)] border border-[var(--pos-fwd-border,#991b1b)]",
    jerseyClassName:
      "from-red-700 to-red-800 border-red-400 text-white",
    pitchTokenClassName:
      "bg-[var(--pos-fwd-bg,#b91c1c)] border-red-300 text-[var(--pos-fwd-fg,#ffffff)]",
  },
};

export function normalizePositionCode(position: Position | string): PositionBadgeCode | null {
  const normalized = String(position).trim().toUpperCase();
  if (
    normalized === Position.GKP ||
    normalized === Position.DEF ||
    normalized === Position.MID ||
    normalized === Position.FWD
  ) {
    return normalized as PositionBadgeCode;
  }
  return null;
}

export function getPositionColorToken(position: Position | string): PositionColorToken | null {
  const code = normalizePositionCode(position);
  return code ? POSITION_COLOR_TOKENS[code] : null;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function getRelativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const num = parseInt(clean, 16);
  const r = srgbToLinear((num >> 16) & 0xff);
  const g = srgbToLinear((num >> 8) & 0xff);
  const b = srgbToLinear(num & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function calculateContrastRatio(hexA: string, hexB: string): number {
  const l1 = getRelativeLuminance(hexA);
  const l2 = getRelativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface PositionBadgeProps {
  position: Position | string;
  size?: "sm" | "md";
  className?: string;
}

export const PositionBadge: React.FC<PositionBadgeProps> = ({
  position,
  size = "sm",
  className = "",
}) => {
  const token = getPositionColorToken(position);
  const sizeClass = size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs";

  if (!token) {
    return (
      <span
        data-testid="position-badge"
        data-position={String(position)}
        className={`inline-flex items-center font-bold uppercase rounded ${sizeClass} bg-slate-100 text-slate-700 border border-slate-200 ${className}`.trim()}
      >
        {position}
      </span>
    );
  }

  return (
    <span
      data-testid="position-badge"
      data-position={token.position}
      data-color-family={token.colorFamily.toLowerCase()}
      style={{
        backgroundColor: token.bgVar,
        color: token.fgVar,
        borderColor: token.borderVar,
      }}
      className={`inline-flex items-center justify-center font-bold uppercase rounded tracking-wide ${sizeClass} ${token.className} ${className}`.trim()}
    >
      {token.position}
    </span>
  );
};
