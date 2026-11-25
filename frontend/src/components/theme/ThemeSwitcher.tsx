"use client";

import React, { useState } from "react";
import { useTheme } from "@/context/ThemeContext";
import { ThemeName } from "@/lib/themes/tokens";

interface ThemeSwitcherProps {
  /**
   * Display variant
   * - "button": Simple toggle button
   * - "select": Dropdown selector
   * - "buttons": Icon buttons for each theme
   */
  variant?: "button" | "select" | "buttons";
  /** Custom className for the container */
  className?: string;
  /** Whether to show label text */
  showLabel?: boolean;
}

/**
 * Theme Switcher Component
 *
 * Allows users to switch between Light, Dark, and High Contrast themes
 * Provides multiple UI variants for different use cases
 */
export const ThemeSwitcher: React.FC<ThemeSwitcherProps> = ({
  variant = "button",
  className = "",
  showLabel = true,
}) => {
  const { theme, setTheme, toggleTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);

  const themeLabels: Record<ThemeName, string> = {
    light: "Light",
    dark: "Dark",
    "high-contrast": "High Contrast",
  };

  const themeEmojis: Record<ThemeName, string> = {
    light: "☀️",
    dark: "🌙",
    "high-contrast": "◉",
  };

  if (variant === "button") {
    return (
      <button
        onClick={toggleTheme}
        className={`px-3 py-2 rounded-lg bg-[var(--fxi-surface)] border border-[var(--fxi-border)] text-[var(--fxi-foreground)] hover:bg-[var(--fxi-surface-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fxi-focus)] ${className}`}
        title={`Current theme: ${themeLabels[theme]}. Click to toggle.`}
        aria-label={`Theme: ${themeLabels[theme]}. Click to toggle between Light, Dark, and High Contrast.`}
      >
        {themeEmojis[theme]} {showLabel && themeLabels[theme]}
      </button>
    );
  }

  if (variant === "select") {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        {showLabel && (
          <label
            htmlFor="theme-select"
            className="text-sm font-medium text-[var(--fxi-foreground)]"
          >
            Theme:
          </label>
        )}
        <select
          id="theme-select"
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeName)}
          className="px-3 py-2 rounded-lg bg-[var(--fxi-surface)] border border-[var(--fxi-border)] text-[var(--fxi-foreground)] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fxi-focus)]"
          aria-label="Select theme"
        >
          {(["light", "dark", "high-contrast"] as ThemeName[]).map((t) => (
            <option key={t} value={t}>
              {themeEmojis[t]} {themeLabels[t]}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (variant === "buttons") {
    return (
      <div className={`flex gap-2 ${className}`} role="group" aria-label="Theme selector">
        {(["light", "dark", "high-contrast"] as ThemeName[]).map((t) => (
          <button
            key={t}
            onClick={() => setTheme(t)}
            className={`px-4 py-2 rounded-lg transition-all font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fxi-focus)] ${
              theme === t
                ? "bg-[var(--fxi-primary)] text-white"
                : "bg-[var(--fxi-surface)] border border-[var(--fxi-border)] text-[var(--fxi-foreground)] hover:bg-[var(--fxi-surface-hover)]"
            }`}
            aria-pressed={theme === t}
            aria-label={`${themeLabels[t]} theme`}
          >
            {themeEmojis[t]} {showLabel && themeLabels[t]}
          </button>
        ))}
      </div>
    );
  }

  return null;
};
