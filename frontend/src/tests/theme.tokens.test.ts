/**
 * Theme Tokens Test
 *
 * Validates that all theme tokens are complete and properly defined
 */

import { describe, it, expect } from "vitest";
import { lightTheme, darkTheme, highContrastTheme, themes, THEME_NAMES } from "@/lib/themes/tokens";

describe("Theme Tokens", () => {
  describe("Theme Structure", () => {
    it("should have all required themes", () => {
      expect(themes).toHaveProperty("light");
      expect(themes).toHaveProperty("dark");
      expect(themes).toHaveProperty("high-contrast");
    });

    it("should export theme constants", () => {
      expect(THEME_NAMES).toContain("light");
      expect(THEME_NAMES).toContain("dark");
      expect(THEME_NAMES).toContain("high-contrast");
      expect(THEME_NAMES).toHaveLength(3);
    });

    it("should have metadata for each theme", () => {
      expect(lightTheme.metadata.name).toBe("light");
      expect(darkTheme.metadata.name).toBe("dark");
      expect(highContrastTheme.metadata.name).toBe("high-contrast");

      expect(lightTheme.metadata.description).toBeDefined();
      expect(darkTheme.metadata.description).toBeDefined();
      expect(highContrastTheme.metadata.description).toBeDefined();
    });
  });

  describe("Color Token Completeness", () => {
    const requiredColors = [
      // Backgrounds
      "background",
      "surface",
      "surfaceHover",
      "surfaceActive",
      "surfaceCard",
      // Text
      "foreground",
      "foregroundSecondary",
      "foregroundTertiary",
      // Borders
      "border",
      "borderSubtle",
      // Primary
      "primary",
      "primaryHover",
      "primarySubtle",
      "primaryGlow",
      // Secondary
      "secondary",
      "secondaryHover",
      "secondarySubtle",
      "secondaryBorder",
      // Accents
      "accentPurple",
      "accentBlue",
      "accentAmber",
      // Pitch
      "pitchGrass1",
      "pitchGrass2",
      "pitchLine",
      // Semantic
      "success",
      "warning",
      "error",
      "info",
      // Focus
      "focus",
      "focusRing",
    ];

    it("should have all required color tokens in light theme", () => {
      for (const color of requiredColors) {
        expect(lightTheme.colors).toHaveProperty(color);
        expect(lightTheme.colors[color as keyof typeof lightTheme.colors]).toBeDefined();
        expect(typeof lightTheme.colors[color as keyof typeof lightTheme.colors]).toBe("string");
      }
    });

    it("should have all required color tokens in dark theme", () => {
      for (const color of requiredColors) {
        expect(darkTheme.colors).toHaveProperty(color);
        expect(darkTheme.colors[color as keyof typeof darkTheme.colors]).toBeDefined();
        expect(typeof darkTheme.colors[color as keyof typeof darkTheme.colors]).toBe("string");
      }
    });

    it("should have all required color tokens in high-contrast theme", () => {
      for (const color of requiredColors) {
        expect(highContrastTheme.colors).toHaveProperty(color);
        expect(highContrastTheme.colors[color as keyof typeof highContrastTheme.colors]).toBeDefined();
        expect(typeof highContrastTheme.colors[color as keyof typeof highContrastTheme.colors]).toBe("string");
      }
    });

    it("should have exactly the same set of color tokens across all themes", () => {
      const lightColors = Object.keys(lightTheme.colors).sort();
      const darkColors = Object.keys(darkTheme.colors).sort();
      const highContrastColors = Object.keys(highContrastTheme.colors).sort();

      expect(darkColors).toEqual(lightColors);
      expect(highContrastColors).toEqual(lightColors);
    });
  });

  describe("Color Values", () => {
    it("should have valid hex or rgba color values in light theme", () => {
      for (const [key, value] of Object.entries(lightTheme.colors)) {
        const isValid =
          typeof value === "string" &&
          (value.match(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/) ||
            value.match(/^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/));
        expect(isValid).toBe(true, `${key}: "${value}" is not a valid hex or rgba color`);
      }
    });

    it("should have valid hex or rgba color values in dark theme", () => {
      for (const [key, value] of Object.entries(darkTheme.colors)) {
        const isValid =
          typeof value === "string" &&
          (value.match(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/) ||
            value.match(/^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/));
        expect(isValid).toBe(true, `${key}: "${value}" is not a valid hex or rgba color`);
      }
    });

    it("should have valid hex or rgba color values in high-contrast theme", () => {
      for (const [key, value] of Object.entries(highContrastTheme.colors)) {
        const isValid =
          typeof value === "string" &&
          (value.match(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/) ||
            value.match(/^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/));
        expect(isValid).toBe(true, `${key}: "${value}" is not a valid hex or rgba color`);
      }
    });
  });

  describe("Theme Distinctness", () => {
    it("light and dark themes should have distinct backgrounds", () => {
      expect(lightTheme.colors.background).not.toBe(darkTheme.colors.background);
      expect(lightTheme.colors.foreground).not.toBe(darkTheme.colors.foreground);
    });

    it("high-contrast should have maximum contrast backgrounds", () => {
      // High contrast should use pure white and black or very dark/light colors
      const hcBg = highContrastTheme.colors.background.toLowerCase();
      const hcFg = highContrastTheme.colors.foreground.toLowerCase();

      expect(hcBg === "#ffffff" || hcBg === "#000000").toBe(true);
      expect(hcFg === "#ffffff" || hcFg === "#000000").toBe(true);
      expect(hcBg).not.toBe(hcFg);
    });
  });

  describe("Brand Color Consistency", () => {
    it("should maintain brand colors across themes", () => {
      // Primary purple should be consistent
      expect(lightTheme.colors.primary).toBe(darkTheme.colors.primary);
      // Secondary green should be consistent
      expect(lightTheme.colors.secondary).toBe(darkTheme.colors.secondary);
    });

    it("should have hover variants for primary colors", () => {
      expect(lightTheme.colors.primaryHover).toBeDefined();
      expect(darkTheme.colors.primaryHover).toBeDefined();
      expect(lightTheme.colors.secondaryHover).toBeDefined();
      expect(darkTheme.colors.secondaryHover).toBeDefined();
    });
  });
});
