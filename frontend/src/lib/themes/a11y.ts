/**
 * Accessibility (a11y) Utilities
 *
 * Functions for validating WCAG 2.1 color contrast compliance
 * and generating accessibility reports.
 */

/**
 * Convert hex color to RGB
 * @param hex Hex color string (e.g., "#ffffff" or "ffffff")
 * @returns [r, g, b] tuple
 */
export function hexToRgb(hex: string): [number, number, number] {
  const cleanHex = hex.replace(/^#/, "");
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return [r, g, b];
}

/**
 * Convert RGB to hex
 * @param r Red (0-255)
 * @param g Green (0-255)
 * @param b Blue (0-255)
 * @returns Hex string (e.g., "#ffffff")
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/**
 * Calculate relative luminance of a color
 * Per WCAG 2.1 definition
 * @param rgb [r, g, b] tuple
 * @returns Luminance value (0-1)
 */
export function calculateLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculate contrast ratio between two colors
 * Per WCAG 2.1 definition: (L1 + 0.05) / (L2 + 0.05)
 * @param color1 Hex color string
 * @param color2 Hex color string
 * @returns Contrast ratio (1-21)
 */
export function calculateContrastRatio(color1: string, color2: string): number {
  const lum1 = calculateLuminance(hexToRgb(color1));
  const lum2 = calculateLuminance(hexToRgb(color2));

  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG 2.1 conformance levels
 */
export enum WCAGLevel {
  AAA_LARGE = 3, // 3:1 for large text (18pt+ or 14pt+ bold)
  AAA = 7, // 7:1 for normal text
  AA = 4.5, // 4.5:1 for normal text
  AA_LARGE = 3, // 3:1 for large text
}

/**
 * Check if contrast ratio meets WCAG level
 * @param ratio Contrast ratio to check
 * @param level WCAG level to validate against
 * @returns true if ratio meets or exceeds level
 */
export function meetsWCAGLevel(ratio: number, level: WCAGLevel): boolean {
  return ratio >= level;
}

/**
 * Get WCAG level for a contrast ratio
 * @param ratio Contrast ratio
 * @returns Highest WCAG level achieved
 */
export function getWCAGLevel(ratio: number): string | null {
  if (ratio >= WCAGLevel.AAA) {
    return "AAA";
  }
  if (ratio >= WCAGLevel.AA) {
    return "AA";
  }
  if (ratio >= WCAGLevel.AA_LARGE) {
    return "AA Large";
  }
  return null;
}

/**
 * Validate a foreground/background color pair
 * @param foreground Hex color
 * @param background Hex color
 * @param minLevel Minimum required WCAG level (default AAA)
 * @returns Validation result
 */
export interface ContrastValidation {
  valid: boolean;
  ratio: number;
  required: number;
  level: string | null;
  message: string;
}

export function validateContrast(
  foreground: string,
  background: string,
  minLevel: WCAGLevel = WCAGLevel.AAA
): ContrastValidation {
  const ratio = calculateContrastRatio(foreground, background);
  const level = getWCAGLevel(ratio);
  const valid = meetsWCAGLevel(ratio, minLevel);

  return {
    valid,
    ratio: Math.round(ratio * 100) / 100,
    required: minLevel,
    level,
    message: valid
      ? `✓ Contrast ratio ${ratio.toFixed(2)}:1 meets WCAG ${level}`
      : `✗ Contrast ratio ${ratio.toFixed(2)}:1 below required ${minLevel}:1 (${level || "None"})`,
  };
}

/**
 * Batch validate theme colors
 * @param foreground Foreground color
 * @param backgrounds Array of background colors
 * @param minLevel WCAG level
 * @returns Map of validation results
 */
export function validateThemeContrasts(
  foreground: string,
  backgrounds: Record<string, string>,
  minLevel: WCAGLevel = WCAGLevel.AAA
): Record<string, ContrastValidation> {
  const results: Record<string, ContrastValidation> = {};

  for (const [key, bg] of Object.entries(backgrounds)) {
    results[key] = validateContrast(foreground, bg, minLevel);
  }

  return results;
}

/**
 * Generate accessibility report for theme colors
 */
export interface AccessibilityReport {
  theme: string;
  timestamp: string;
  validations: Array<{
    pair: string;
    foreground: string;
    background: string;
    validation: ContrastValidation;
  }>;
  allValid: boolean;
  summary: {
    total: number;
    passing: number;
    failing: number;
  };
}

export function generateAccessibilityReport(
  themeName: string,
  foregroundColor: string,
  backgroundColors: Record<string, string>,
  minLevel: WCAGLevel = WCAGLevel.AAA
): AccessibilityReport {
  const validations = validateThemeContrasts(foregroundColor, backgroundColors, minLevel);

  const pairs = Object.entries(validations).map(([key, validation]) => ({
    pair: key,
    foreground: foregroundColor,
    background: backgroundColors[key],
    validation,
  }));

  const summary = {
    total: pairs.length,
    passing: pairs.filter((p) => p.validation.valid).length,
    failing: pairs.filter((p) => !p.validation.valid).length,
  };

  return {
    theme: themeName,
    timestamp: new Date().toISOString(),
    validations: pairs,
    allValid: summary.failing === 0,
    summary,
  };
}
