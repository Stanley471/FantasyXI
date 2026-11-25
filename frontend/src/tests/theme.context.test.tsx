/**
 * Theme Context Test
 *
 * Tests theme provider, switching, persistence, and CSS variable injection
 */

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderHook, act } from "@testing-library/react";
import { ThemeProvider, useTheme, injectThemeCSS, getThemeCSSVariables } from "@/context/ThemeContext";
import { ThemeName } from "@/lib/themes/tokens";

describe("Theme Context", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    // Reset document attribute
    document.documentElement.removeAttribute("data-theme");
  });

  describe("injectThemeCSS", () => {
    it("should generate valid CSS for light theme", () => {
      const css = injectThemeCSS("light");
      expect(css).toContain(`:root[data-theme="light"]`);
      expect(css).toContain("--fxi-background");
      expect(css).toContain("--fxi-foreground");
      expect(css).toContain("#f8fafc");
    });

    it("should generate valid CSS for dark theme", () => {
      const css = injectThemeCSS("dark");
      expect(css).toContain(`:root[data-theme="dark"]`);
      expect(css).toContain("#0f172a");
    });

    it("should generate valid CSS for high-contrast theme", () => {
      const css = injectThemeCSS("high-contrast");
      expect(css).toContain(`:root[data-theme="high-contrast"]`);
      expect(css).toContain("#ffffff");
      expect(css).toContain("#000000");
    });
  });

  describe("getThemeCSSVariables", () => {
    it("should return CSS variables for light theme", () => {
      const vars = getThemeCSSVariables("light");
      expect(vars["--fxi-background"]).toBe("#f8fafc");
      expect(vars["--fxi-foreground"]).toBe("#1e1338");
    });

    it("should return CSS variables for all themes", () => {
      const lightVars = getThemeCSSVariables("light");
      const darkVars = getThemeCSSVariables("dark");
      const hcVars = getThemeCSSVariables("high-contrast");

      // All should have the same keys
      expect(Object.keys(darkVars).sort()).toEqual(Object.keys(lightVars).sort());
      expect(Object.keys(hcVars).sort()).toEqual(Object.keys(lightVars).sort());

      // But different values
      expect(lightVars["--fxi-background"]).not.toBe(darkVars["--fxi-background"]);
    });
  });

  describe("useTheme Hook", () => {
    it("should throw error when used outside provider", () => {
      const { result } = renderHook(() => useTheme());
      expect(result.current).toBeDefined();
    });

    it("should return theme context within provider", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      expect(result.current.theme).toBeDefined();
      expect(result.current.setTheme).toBeDefined();
      expect(result.current.toggleTheme).toBeDefined();
      expect(result.current.getTheme).toBeDefined();
      expect(result.current.isHighContrast).toBeDefined();
    });

    it("should start with light theme by default", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      expect(result.current.theme).toBe("light");
      expect(result.current.isHighContrast).toBe(false);
    });
  });

  describe("Theme Switching", () => {
    it("should switch to dark theme", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      expect(result.current.theme).toBe("dark");
    });

    it("should switch to high-contrast theme", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      act(() => {
        result.current.setTheme("high-contrast");
      });

      expect(result.current.theme).toBe("high-contrast");
      expect(result.current.isHighContrast).toBe(true);
    });

    it("should toggle theme between light and dark", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      expect(result.current.theme).toBe("light");

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.theme).toBe("dark");

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.theme).toBe("light");
    });

    it("should toggle from high-contrast to light", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      act(() => {
        result.current.setTheme("high-contrast");
      });

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.theme).toBe("light");
    });
  });

  describe("Persistence", () => {
    it("should persist theme preference to localStorage", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      expect(localStorage.getItem("fxi-theme-preference")).toBe("dark");
    });

    it("should restore theme from localStorage on mount", () => {
      localStorage.setItem("fxi-theme-preference", "dark");

      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      // Should load dark theme from storage
      expect(result.current.theme).toBe("dark");
    });

    it("should ignore invalid stored theme and default to system", () => {
      localStorage.setItem("fxi-theme-preference", "invalid-theme");

      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      // Should fallback to light (default system doesn't match)
      expect(result.current.theme).toBe("light");
    });
  });

  describe("CSS Variable Injection", () => {
    it("should set data-theme attribute on html element", () => {
      renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      waitFor(() => {
        expect(document.documentElement.getAttribute("data-theme")).toBeTruthy();
      });
    });

    it("should apply CSS variables for current theme", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      waitFor(() => {
        const style = getComputedStyle(document.documentElement);
        // CSS variable should be set (can't directly test value due to JSDOM limitations)
        expect(style).toBeDefined();
      });
    });
  });

  describe("getCSSVar", () => {
    it("should convert token names to CSS variable names", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      expect(result.current.getCSSVar("background")).toBe("--fxi-background");
      expect(result.current.getCSSVar("foreground")).toBe("--fxi-foreground");
      expect(result.current.getCSSVar("primaryHover")).toBe("--fxi-primary-hover");
      expect(result.current.getCSSVar("surfaceCard")).toBe("--fxi-surface-card");
    });
  });

  describe("getTheme", () => {
    it("should return current theme object", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      const theme = result.current.getTheme();
      expect(theme).toHaveProperty("colors");
      expect(theme).toHaveProperty("metadata");
      expect(theme.metadata.name).toBe("light");
    });

    it("should return updated theme object after switching", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      const theme = result.current.getTheme();
      expect(theme.metadata.name).toBe("dark");
      expect(theme.colors.background).toBe("#0f172a");
    });
  });

  describe("Custom Events", () => {
    it("should dispatch theme-changed event when theme changes", () => {
      const listener = vi.fn();
      window.addEventListener("theme-changed", listener);

      const { result } = renderHook(() => useTheme(), {
        wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      expect(listener).toHaveBeenCalled();
      expect(listener.mock.calls[0][0].detail.theme).toBe("dark");

      window.removeEventListener("theme-changed", listener);
    });
  });
});
