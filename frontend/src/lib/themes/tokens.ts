/**
 * Design Tokens
 *
 * Centralized color and spacing tokens for all themes.
 * Used for theme switching and contrast compliance validation.
 */

export type ColorToken = string;
export type ThemeName = "light" | "dark" | "high-contrast";

/**
 * Design token structure defining colors, spacing, and typography scale
 */
export interface DesignTokens {
  colors: {
    // Backgrounds
    background: ColorToken;
    surface: ColorToken;
    surfaceHover: ColorToken;
    surfaceActive: ColorToken;
    surfaceCard: ColorToken;

    // Text/Foreground
    foreground: ColorToken;
    foregroundSecondary: ColorToken;
    foregroundTertiary: ColorToken;

    // Borders
    border: ColorToken;
    borderSubtle: ColorToken;

    // Brand Colors
    primary: ColorToken;
    primaryHover: ColorToken;
    primarySubtle: ColorToken;
    primaryGlow: ColorToken;

    secondary: ColorToken;
    secondaryHover: ColorToken;
    secondarySubtle: ColorToken;
    secondaryBorder: ColorToken;

    // Accent Colors
    accentPurple: ColorToken;
    accentBlue: ColorToken;
    accentAmber: ColorToken;

    // Football Pitch
    pitchGrass1: ColorToken;
    pitchGrass2: ColorToken;
    pitchLine: ColorToken;

    // Status/Semantic
    success: ColorToken;
    warning: ColorToken;
    error: ColorToken;
    info: ColorToken;

    // Focus indicators
    focus: ColorToken;
    focusRing: ColorToken;
  };

  // For easy reference in validation
  readonly metadata: {
    name: ThemeName;
    description: string;
  };
}

/**
 * Light SaaS Theme - Default theme
 * High readability on white backgrounds with subtle accents
 */
export const lightTheme: DesignTokens = {
  metadata: {
    name: "light",
    description: "Light SaaS theme - Default light mode for daytime use",
  },
  colors: {
    background: "#f8fafc",
    surface: "#ffffff",
    surfaceHover: "#f1f5f9",
    surfaceActive: "#e2e8f0",
    surfaceCard: "#ffffff",

    foreground: "#1e1338",
    foregroundSecondary: "#475569",
    foregroundTertiary: "#94a3b8",

    border: "#e2e8f0",
    borderSubtle: "#f1f5f9",

    primary: "#37003c",
    primaryHover: "#26002b",
    primarySubtle: "rgba(55, 0, 60, 0.08)",
    primaryGlow: "rgba(55, 0, 60, 0.15)",

    secondary: "#00ff87",
    secondaryHover: "#00e074",
    secondarySubtle: "rgba(0, 255, 135, 0.14)",
    secondaryBorder: "rgba(0, 255, 135, 0.35)",

    accentPurple: "#48126e",
    accentBlue: "#0284c7",
    accentAmber: "#f59e0b",

    pitchGrass1: "#065f46",
    pitchGrass2: "#047857",
    pitchLine: "rgba(255, 255, 255, 0.28)",

    success: "#10b981",
    warning: "#f59e0b",
    error: "#ef4444",
    info: "#0284c7",

    focus: "#37003c",
    focusRing: "rgba(55, 0, 60, 0.5)",
  },
};

/**
 * Pitch Stadium Dark Theme
 * Dark background with vibrant neon accents for evening/night use
 */
export const darkTheme: DesignTokens = {
  metadata: {
    name: "dark",
    description: "Pitch Stadium Dark theme - Premium dark mode with vibrant accents",
  },
  colors: {
    background: "#0f172a",
    surface: "#1e293b",
    surfaceHover: "#334155",
    surfaceActive: "#475569",
    surfaceCard: "#1e293b",

    foreground: "#f1f5f9",
    foregroundSecondary: "#cbd5e1",
    foregroundTertiary: "#94a3b8",

    border: "#334155",
    borderSubtle: "#1e293b",

    primary: "#37003c",
    primaryHover: "#4a1261",
    primarySubtle: "rgba(55, 0, 60, 0.2)",
    primaryGlow: "rgba(55, 0, 60, 0.3)",

    secondary: "#00ff87",
    secondaryHover: "#00e074",
    secondarySubtle: "rgba(0, 255, 135, 0.2)",
    secondaryBorder: "rgba(0, 255, 135, 0.4)",

    accentPurple: "#a78bfa",
    accentBlue: "#38bdf8",
    accentAmber: "#fbbf24",

    pitchGrass1: "#064e3b",
    pitchGrass2: "#065f46",
    pitchLine: "rgba(255, 255, 255, 0.2)",

    success: "#34d399",
    warning: "#fcd34d",
    error: "#f87171",
    info: "#38bdf8",

    focus: "#00ff87",
    focusRing: "rgba(0, 255, 135, 0.5)",
  },
};

/**
 * High Contrast Mode - WCAG AAA Compliant
 * Maximum contrast ratios (>7:1), distinct borders, and enhanced focus indicators
 * Designed for users with low vision or color blindness
 */
export const highContrastTheme: DesignTokens = {
  metadata: {
    name: "high-contrast",
    description:
      "High Contrast mode - WCAG AAA compliant with enhanced contrast, bold borders, and prominent focus indicators",
  },
  colors: {
    background: "#ffffff",
    surface: "#ffffff",
    surfaceHover: "#f5f5f5",
    surfaceActive: "#e0e0e0",
    surfaceCard: "#ffffff",

    foreground: "#000000",
    foregroundSecondary: "#1a1a1a",
    foregroundTertiary: "#404040",

    border: "#000000",
    borderSubtle: "#404040",

    primary: "#000000",
    primaryHover: "#1a1a1a",
    primarySubtle: "#f0f0f0",
    primaryGlow: "#e0e0e0",

    // High-contrast secondary with strong distinction
    secondary: "#0066cc",
    secondaryHover: "#0052a3",
    secondarySubtle: "#f0f5ff",
    secondaryBorder: "#0066cc",

    accentPurple: "#000080",
    accentBlue: "#0000ff",
    accentAmber: "#cc6600",

    pitchGrass1: "#003300",
    pitchGrass2: "#004400",
    pitchLine: "#000000",

    success: "#008000",
    warning: "#cc6600",
    error: "#cc0000",
    info: "#0066cc",

    // Highly visible focus indicators
    focus: "#0066cc",
    focusRing: "#0000ff",
  },
};

export const themes: Record<ThemeName, DesignTokens> = {
  light: lightTheme,
  dark: darkTheme,
  "high-contrast": highContrastTheme,
};

export const THEME_NAMES: ThemeName[] = ["light", "dark", "high-contrast"];
