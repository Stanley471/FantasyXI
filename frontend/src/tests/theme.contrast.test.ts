/**
 * Theme Contrast Test
 *
 * Validates WCAG 2.1 AAA color contrast compliance for all themes
 * Ensures text is readable by users with low vision or color blindness
 */

import { describe, it, expect } from "vitest";
import {
  calculateContrastRatio,
  validateContrast,
  WCAGLevel,
  generateAccessibilityReport,
} from "@/lib/themes/a11y";
import { lightTheme, darkTheme, highContrastTheme, themes } from "@/lib/themes/tokens";

describe("Theme Contrast Compliance (WCAG 2.1 AAA)", () => {
  /**
   * Critical text pairings that must meet WCAG AAA (7:1)
   */
  const criticalPairings = [
    {
      name: "Foreground on Background",
      getForeground: (theme: typeof lightTheme) => theme.colors.foreground,
      getBackground: (theme: typeof lightTheme) => theme.colors.background,
    },
    {
      name: "Foreground on Surface",
      getForeground: (theme: typeof lightTheme) => theme.colors.foreground,
      getBackground: (theme: typeof lightTheme) => theme.colors.surface,
    },
    {
      name: "Primary on Background",
      getForeground: (theme: typeof lightTheme) => theme.colors.primary,
      getBackground: (theme: typeof lightTheme) => theme.colors.background,
    },
    {
      name: "Secondary on Background",
      getForeground: (theme: typeof lightTheme) => theme.colors.secondary,
      getBackground: (theme: typeof lightTheme) => theme.colors.background,
    },
  ];

  /**
   * Important pairings that should meet WCAG AA (4.5:1)
   */
  const importantPairings = [
    {
      name: "Foreground Secondary on Background",
      getForeground: (theme: typeof lightTheme) => theme.colors.foregroundSecondary,
      getBackground: (theme: typeof lightTheme) => theme.colors.background,
    },
    {
      name: "Foreground on Surface Hover",
      getForeground: (theme: typeof lightTheme) => theme.colors.foreground,
      getBackground: (theme: typeof lightTheme) => theme.colors.surfaceHover,
    },
  ];

  describe("Light Theme - Critical Pairings (WCAG AAA)", () => {
    for (const pairing of criticalPairings) {
      it(`${pairing.name} should meet WCAG AAA (7:1)`, () => {
        const fg = pairing.getForeground(lightTheme);
        const bg = pairing.getBackground(lightTheme);
        const ratio = calculateContrastRatio(fg, bg);

        expect(ratio).toBeGreaterThanOrEqual(
          WCAGLevel.AAA,
          `${pairing.name}: ratio ${ratio.toFixed(2)}:1 is below required ${WCAGLevel.AAA}:1`
        );
      });
    }
  });

  describe("Dark Theme - Critical Pairings (WCAG AAA)", () => {
    for (const pairing of criticalPairings) {
      it(`${pairing.name} should meet WCAG AAA (7:1)`, () => {
        const fg = pairing.getForeground(darkTheme);
        const bg = pairing.getBackground(darkTheme);
        const ratio = calculateContrastRatio(fg, bg);

        expect(ratio).toBeGreaterThanOrEqual(
          WCAGLevel.AAA,
          `${pairing.name}: ratio ${ratio.toFixed(2)}:1 is below required ${WCAGLevel.AAA}:1`
        );
      });
    }
  });

  describe("High Contrast Theme - Critical Pairings (WCAG AAA+)", () => {
    for (const pairing of criticalPairings) {
      it(`${pairing.name} should exceed WCAG AAA (7:1)`, () => {
        const fg = pairing.getForeground(highContrastTheme);
        const bg = pairing.getBackground(highContrastTheme);
        const ratio = calculateContrastRatio(fg, bg);

        // High contrast should have even better ratios (ideally near maximum 21:1)
        expect(ratio).toBeGreaterThanOrEqual(
          WCAGLevel.AAA,
          `${pairing.name}: ratio ${ratio.toFixed(2)}:1 is below required ${WCAGLevel.AAA}:1`
        );
      });
    }
  });

  describe("Light Theme - Important Pairings (WCAG AA)", () => {
    for (const pairing of importantPairings) {
      it(`${pairing.name} should meet WCAG AA (4.5:1)`, () => {
        const fg = pairing.getForeground(lightTheme);
        const bg = pairing.getBackground(lightTheme);
        const ratio = calculateContrastRatio(fg, bg);

        expect(ratio).toBeGreaterThanOrEqual(
          WCAGLevel.AA,
          `${pairing.name}: ratio ${ratio.toFixed(2)}:1 is below required ${WCAGLevel.AA}:1`
        );
      });
    }
  });

  describe("Dark Theme - Important Pairings (WCAG AA)", () => {
    for (const pairing of importantPairings) {
      it(`${pairing.name} should meet WCAG AA (4.5:1)`, () => {
        const fg = pairing.getForeground(darkTheme);
        const bg = pairing.getBackground(darkTheme);
        const ratio = calculateContrastRatio(fg, bg);

        expect(ratio).toBeGreaterThanOrEqual(
          WCAGLevel.AA,
          `${pairing.name}: ratio ${ratio.toFixed(2)}:1 is below required ${WCAGLevel.AA}:1`
        );
      });
    }
  });

  describe("Semantic Colors - Contrast Validation", () => {
    it("success color should be readable on light background", () => {
      const ratio = calculateContrastRatio(lightTheme.colors.success, lightTheme.colors.background);
      expect(ratio).toBeGreaterThanOrEqual(WCAGLevel.AA);
    });

    it("error color should be readable on light background", () => {
      const ratio = calculateContrastRatio(lightTheme.colors.error, lightTheme.colors.background);
      expect(ratio).toBeGreaterThanOrEqual(WCAGLevel.AA);
    });

    it("warning color should be readable on light background", () => {
      const ratio = calculateContrastRatio(lightTheme.colors.warning, lightTheme.colors.background);
      expect(ratio).toBeGreaterThanOrEqual(WCAGLevel.AA);
    });

    it("success color should be readable on dark background", () => {
      const ratio = calculateContrastRatio(darkTheme.colors.success, darkTheme.colors.background);
      expect(ratio).toBeGreaterThanOrEqual(WCAGLevel.AA);
    });

    it("error color should be readable on dark background", () => {
      const ratio = calculateContrastRatio(darkTheme.colors.error, darkTheme.colors.background);
      expect(ratio).toBeGreaterThanOrEqual(WCAGLevel.AA);
    });

    it("warning color should be readable on dark background", () => {
      const ratio = calculateContrastRatio(darkTheme.colors.warning, darkTheme.colors.background);
      expect(ratio).toBeGreaterThanOrEqual(WCAGLevel.AA);
    });
  });

  describe("Focus Indicators - Visibility", () => {
    it("high-contrast focus ring should be highly visible", () => {
      const ratio = calculateContrastRatio(
        highContrastTheme.colors.focusRing,
        highContrastTheme.colors.background
      );
      expect(ratio).toBeGreaterThan(10); // Very high contrast for keyboard users
    });

    it("light theme focus color should be distinct from primary", () => {
      expect(lightTheme.colors.focus).not.toBe(lightTheme.colors.primary);
    });

    it("dark theme focus color should be distinct from primary", () => {
      expect(darkTheme.colors.focus).not.toBe(darkTheme.colors.primary);
    });
  });

  describe("Accessibility Reports", () => {
    it("should generate valid report for light theme", () => {
      const report = generateAccessibilityReport(
        "light",
        lightTheme.colors.foreground,
        {
          background: lightTheme.colors.background,
          surface: lightTheme.colors.surface,
          primary: lightTheme.colors.primary,
        },
        WCAGLevel.AAA
      );

      expect(report).toHaveProperty("theme", "light");
      expect(report).toHaveProperty("timestamp");
      expect(report).toHaveProperty("validations");
      expect(report).toHaveProperty("summary");
      expect(Array.isArray(report.validations)).toBe(true);
    });

    it("should mark high-contrast as fully compliant", () => {
      const report = generateAccessibilityReport(
        "high-contrast",
        highContrastTheme.colors.foreground,
        {
          background: highContrastTheme.colors.background,
          surface: highContrastTheme.colors.surface,
          primary: highContrastTheme.colors.primary,
        },
        WCAGLevel.AAA
      );

      expect(report.allValid).toBe(true);
      expect(report.summary.failing).toBe(0);
    });
  });

  describe("Contrast Ratio Validation", () => {
    it("should correctly calculate contrast between white and black", () => {
      const ratio = calculateContrastRatio("#ffffff", "#000000");
      // White on black should be 21:1 (maximum contrast)
      expect(ratio).toBe(21);
    });

    it("should correctly calculate contrast between similar colors", () => {
      const ratio = calculateContrastRatio("#f5f5f5", "#ffffff");
      // Very similar colors should have low contrast
      expect(ratio).toBeLessThan(1.5);
    });

    it("validateContrast should return correct validation object", () => {
      const validation = validateContrast("#000000", "#ffffff", WCAGLevel.AAA);

      expect(validation.valid).toBe(true);
      expect(validation.ratio).toBe(21);
      expect(validation.level).toBe("AAA");
      expect(validation.required).toBe(WCAGLevel.AAA);
      expect(validation.message).toContain("✓");
    });

    it("validateContrast should fail for insufficient contrast", () => {
      const validation = validateContrast("#f5f5f5", "#ffffff", WCAGLevel.AAA);

      expect(validation.valid).toBe(false);
      expect(validation.message).toContain("✗");
    });
  });
});
