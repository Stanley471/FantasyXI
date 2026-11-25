/**
 * useSystemTheme Hook
 *
 * Detects and syncs with system OS theme preferences
 * Respects prefers-color-scheme media query
 */

import { useEffect, useState, useCallback } from "react";
import { ThemeName } from "@/lib/themes/tokens";

interface UseSystemThemeOptions {
  /** Whether to respect system preference (default: true) */
  respectSystem?: boolean;
  /** Callback when system preference changes */
  onSystemPreferenceChange?: (theme: ThemeName) => void;
}

/**
 * Hook to detect and respond to system theme changes
 * Returns the current system preference without changing the actual theme
 */
export function useSystemTheme(
  options: UseSystemThemeOptions = {}
): {
  systemTheme: ThemeName | null;
  isSystemDark: boolean;
  isSystemLight: boolean;
} {
  const { respectSystem = true, onSystemPreferenceChange } = options;
  const [systemTheme, setSystemTheme] = useState<ThemeName | null>(null);

  const detectSystemTheme = useCallback((): ThemeName => {
    if (typeof window === "undefined") return "light";

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }, []);

  useEffect(() => {
    if (!respectSystem || typeof window === "undefined") return;

    // Set initial system theme
    const initial = detectSystemTheme();
    setSystemTheme(initial);

    // Listen for changes to system preference
    const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const newTheme: ThemeName = e.matches ? "dark" : "light";
      setSystemTheme(newTheme);
      onSystemPreferenceChange?.(newTheme);
    };

    // Modern API
    if (darkModeQuery.addEventListener) {
      darkModeQuery.addEventListener("change", handleChange);
      return () => darkModeQuery.removeEventListener("change", handleChange);
    }

    // Fallback for older browsers
    darkModeQuery.addListener(handleChange);
    return () => darkModeQuery.removeListener(handleChange);
  }, [respectSystem, detectSystemTheme, onSystemPreferenceChange]);

  return {
    systemTheme,
    isSystemDark: systemTheme === "dark",
    isSystemLight: systemTheme === "light",
  };
}
