"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { ThemeName, themes, THEME_NAMES } from "@/lib/themes/tokens";

interface ThemeContextType {
  /** Current active theme */
  theme: ThemeName;
  /** Set theme to one of: "light", "dark", "high-contrast" */
  setTheme: (theme: ThemeName) => void;
  /** Toggle between light and dark themes */
  toggleTheme: () => void;
  /** Get current theme object */
  getTheme: () => typeof themes[ThemeName];
  /** Check if high contrast mode is enabled */
  isHighContrast: boolean;
  /** Get CSS variable name for a token key */
  getCSSVar: (tokenKey: string) => string;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = "fxi-theme-preference";
const ATTRIBUTE_NAME = "data-theme";

/**
 * Map theme color token names to CSS variable names
 * e.g., "background" -> "--fxi-bg"
 */
function getCSSVarName(tokenKey: string): string {
  return `--fxi-${tokenKey
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "")}`;
}

/**
 * Get system theme preference
 * Respects prefers-color-scheme media query
 */
function getSystemTheme(): ThemeName {
  if (typeof window === "undefined") return "light";

  if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

/**
 * Inject CSS variables into document
 * Called during server rendering to prevent FOUC
 */
export function injectThemeCSS(themeName: ThemeName): string {
  const theme = themes[themeName];
  const styles: string[] = [`:root[data-theme="${themeName}"] {`];

  for (const [key, value] of Object.entries(theme.colors)) {
    const cssVar = getCSSVarName(key);
    styles.push(`  ${cssVar}: ${value};`);
  }

  styles.push("}");
  return styles.join("\n");
}

/**
 * Get all CSS variables for a theme
 * Used during hydration and theme switching
 */
export function getThemeCSSVariables(themeName: ThemeName): Record<string, string> {
  const theme = themes[themeName];
  const variables: Record<string, string> = {};

  for (const [key, value] of Object.entries(theme.colors)) {
    const cssVar = getCSSVarName(key);
    variables[cssVar] = value;
  }

  return variables;
}

/**
 * Apply theme CSS variables to document
 * This is called on client-side to switch themes instantly
 */
function applyThemeVariables(themeName: ThemeName): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const variables = getThemeCSSVariables(themeName);

  // Set all CSS variables
  for (const [key, value] of Object.entries(variables)) {
    root.style.setProperty(key, value);
  }

  // Update data attribute for CSS selectors
  root.setAttribute(ATTRIBUTE_NAME, themeName);

  // Update meta theme-color for mobile browsers
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    const theme = themes[themeName];
    metaThemeColor.setAttribute("content", theme.colors.primary);
  }
}

/**
 * Get persisted theme preference or fallback to system
 */
function getSavedTheme(): ThemeName {
  if (typeof localStorage === "undefined") return "light";

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && THEME_NAMES.includes(saved as ThemeName)) {
    return saved as ThemeName;
  }

  return getSystemTheme();
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeName>(() => getSavedTheme());
  const [isHydrated, setIsHydrated] = useState(false);

  // Hydrate after mount to prevent FOUC
  useEffect(() => {
    setIsHydrated(true);
    applyThemeVariables(theme);
  }, [theme]);

  const setTheme = useCallback((newTheme: ThemeName) => {
    if (!THEME_NAMES.includes(newTheme)) {
      console.warn(`Invalid theme: ${newTheme}. Using "light" instead.`);
      newTheme = "light";
    }

    setThemeState(newTheme);

    // Persist preference
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, newTheme);
    }

    // Apply immediately on client
    applyThemeVariables(newTheme);

    // Dispatch custom event for external listeners
    window.dispatchEvent(
      new CustomEvent("theme-changed", {
        detail: { theme: newTheme },
      })
    );
  }, []);

  const toggleTheme = useCallback(() => {
    if (theme === "high-contrast") {
      setTheme("light");
    } else if (theme === "light") {
      setTheme("dark");
    } else {
      setTheme("light");
    }
  }, [theme, setTheme]);

  const getTheme = useCallback(() => {
    return themes[theme];
  }, [theme]);

  const getCSSVar = useCallback((tokenKey: string) => {
    return getCSSVarName(tokenKey);
  }, []);

  const value: ThemeContextType = {
    theme,
    setTheme,
    toggleTheme,
    getTheme,
    isHighContrast: theme === "high-contrast",
    getCSSVar,
  };

  return (
    <ThemeContext.Provider value={value}>
      {isHydrated ? children : <>{children}</>}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
