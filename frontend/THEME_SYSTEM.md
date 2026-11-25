# Dynamic Multi-Theme Engine - FantasyXI

Comprehensive theme switching system supporting three themes with WCAG 2.1 AAA accessibility compliance.

## Overview

This implementation provides:

- **Three Themes**: Light (default), Dark (premium), High-Contrast (accessible)
- **Instant Switching**: CSS variable-based architecture enables theme changes without page reload
- **FOUC Prevention**: Server-side rendering prevents flash of unstyled content
- **Persistent Preferences**: User theme choice saved to localStorage and synced with system settings
- **WCAG AAA Compliance**: All text contrast ratios exceed 7:1, meeting AAA standards
- **Focus Indicators**: Enhanced keyboard navigation with high-contrast focus rings

## Architecture

### File Structure

```
src/
├── lib/themes/
│   ├── tokens.ts           # Design token definitions (colors, spacing)
│   └── a11y.ts             # Accessibility utilities for contrast validation
├── context/
│   └── ThemeContext.tsx    # Theme provider and useTheme hook
├── hooks/
│   └── useSystemTheme.ts   # System preference detection
├── components/theme/
│   ├── ThemeScript.tsx     # FOUC prevention script
│   └── ThemeSwitcher.tsx   # Theme selector UI component
└── tests/
    ├── theme.tokens.test.ts    # Token completeness tests
    ├── theme.contrast.test.ts   # WCAG compliance tests
    └── theme.context.test.tsx   # Provider and switching tests
```

### Component Hierarchy

```
RootLayout
  ├── ThemeScript (inline, prevents FOUC)
  └── ThemeProvider
      ├── AuthProvider
      ├── WalletProvider
      ├── ToastProvider
      └── TelemetryProvider
          └── AppShell
```

## Design Tokens

All colors are defined in `src/lib/themes/tokens.ts`:

### Light Theme (Default)
- Background: `#f8fafc` (light slate)
- Foreground: `#1e1338` (dark purple)
- Primary: `#37003c` (royal purple)
- Secondary: `#00ff87` (neon green)

### Dark Theme (Pitch Stadium)
- Background: `#0f172a` (navy blue)
- Foreground: `#f1f5f9` (light slate)
- Primary: `#37003c` (royal purple, consistent)
- Secondary: `#00ff87` (neon green, consistent)

### High Contrast Theme (WCAG AAA)
- Background: `#ffffff` (pure white)
- Foreground: `#000000` (pure black)
- Primary: `#000000` (maximum contrast)
- Secondary: `#0066cc` (high-saturation blue)

**Key Principle**: Color tokens are centralized in TypeScript. CSS variables are generated from these tokens during rendering, ensuring consistency and enabling instant theme switching.

## CSS Variables

All theme colors are exposed as CSS custom properties:

```css
/* Light theme (default) */
:root,
:root[data-theme="light"] {
  --fxi-background: #f8fafc;
  --fxi-foreground: #1e1338;
  --fxi-primary: #37003c;
  --fxi-secondary: #00ff87;
  /* ... all other colors */
}

/* Dark theme */
:root[data-theme="dark"] {
  --fxi-background: #0f172a;
  --fxi-foreground: #f1f5f9;
  /* ... */
}

/* High contrast */
:root[data-theme="high-contrast"] {
  --fxi-background: #ffffff;
  --fxi-foreground: #000000;
  /* ... */
}
```

Use in components:

```tsx
// Tailwind
<div className="bg-[var(--fxi-background)] text-[var(--fxi-foreground)]">
  Content
</div>

// CSS
.my-element {
  background-color: var(--fxi-background);
  color: var(--fxi-foreground);
  border: 2px solid var(--fxi-border);
}
```

## Usage

### Basic Integration

The `ThemeProvider` is automatically set up in `src/app/layout.tsx`:

```tsx
import { ThemeProvider } from "@/context/ThemeContext";
import { ThemeScript } from "@/components/theme/ThemeScript";

export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        <ThemeScript /> {/* Prevents FOUC */}
      </head>
      <body>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

### Hook Usage

```tsx
"use client";

import { useTheme } from "@/context/ThemeContext";

export function MyComponent() {
  const { theme, setTheme, toggleTheme, isHighContrast } = useTheme();

  return (
    <div>
      <p>Current theme: {theme}</p>
      <button onClick={() => setTheme("dark")}>Dark</button>
      <button onClick={toggleTheme}>Toggle</button>
      
      {isHighContrast && <p>High contrast mode active</p>}
    </div>
  );
}
```

### Theme Switcher Component

```tsx
import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";

// Simple toggle button
<ThemeSwitcher variant="button" showLabel={true} />

// Dropdown selector
<ThemeSwitcher variant="select" showLabel={true} />

// Individual theme buttons
<ThemeSwitcher variant="buttons" showLabel={false} />
```

### System Theme Detection

```tsx
import { useSystemTheme } from "@/hooks/useSystemTheme";

export function AutoTheme() {
  const { systemTheme, isSystemDark } = useSystemTheme({
    respectSystem: true,
    onSystemPreferenceChange: (theme) => {
      console.log("System preference changed to:", theme);
    },
  });

  return <div>System prefers: {systemTheme}</div>;
}
```

## Accessibility Features

### High Contrast Mode

The high-contrast theme is optimized for users with:

- Low vision
- Color blindness (deuteranopia, protanopia, tritanopia)
- Light sensitivity
- Screen reader users needing visual context

Features:

- **Text Contrast**: 21:1 ratio (foreground #000000, background #ffffff)
- **Border Outlines**: All interactive elements have distinct 2-4px borders
- **Focus Indicators**: Enhanced 4px outline with 3px offset
- **Semantic Colors**: High-saturation distinct colors for status indicators

### Focus Management

Enhanced keyboard navigation with WCAG AAA-compliant focus indicators:

```css
:focus-visible {
  outline: 3px solid var(--fxi-focus);
  outline-offset: 2px;
  border-radius: 2px;
}

:root[data-theme="high-contrast"] :focus-visible {
  outline: 4px solid var(--fxi-focus-ring);
  outline-offset: 3px;
  box-shadow: 0 0 0 4px var(--fxi-focus);
}
```

### Testing Accessibility

Run contrast validation tests:

```bash
npm test -- src/tests/theme.contrast.test.ts
```

Automated checks verify:

- All critical text pairs meet WCAG AAA (7:1)
- All important pairings meet WCAG AA (4.5:1)
- Semantic colors (success, error, warning) are distinguishable
- Focus indicators exceed 10:1 contrast ratio

## FOUC Prevention

The `ThemeScript` component injects an inline script that runs **before React hydration**:

```tsx
<ThemeScript />
```

This script:

1. Reads saved theme preference from localStorage
2. Checks system preference if no saved preference
3. Sets `data-theme` attribute on `<html>` immediately
4. CSS variables are applied before React mounts

**Result**: Users never see unstyled content, even on hard refresh.

## Persistence

Theme preference is persisted and restored automatically:

1. **LocalStorage**: Saved with key `fxi-theme-preference`
2. **Validation**: Only valid themes ("light", "dark", "high-contrast") are restored
3. **Fallback**: If no saved preference, system theme is detected

```ts
// Get current saved theme
const saved = localStorage.getItem("fxi-theme-preference");

// Clear saved theme
localStorage.removeItem("fxi-theme-preference");
```

## Custom Events

Listen to theme changes application-wide:

```ts
window.addEventListener("theme-changed", (e: CustomEvent) => {
  console.log("Theme changed to:", e.detail.theme);
});
```

## Development

### Running Tests

```bash
# All tests
npm test

# Only theme tests
npm test -- src/tests/theme

# Only contrast validation
npm test -- src/tests/theme.contrast.test.ts
```

### Adding New Colors

1. Update `src/lib/themes/tokens.ts`:

```ts
export const lightTheme: DesignTokens = {
  colors: {
    // Add new color
    myColor: "#abc123",
  },
};
```

2. CSS variables auto-generated as `--fxi-my-color`

3. Update tests in `src/tests/theme.tokens.test.ts`

### Modifying Existing Tokens

Update all three theme definitions (`lightTheme`, `darkTheme`, `highContrastTheme`):

```ts
// In tokens.ts
lightTheme.colors.primary = "#newcolor";
darkTheme.colors.primary = "#newcolor";
highContrastTheme.colors.primary = "#newcolor";
```

Then verify contrast compliance:

```bash
npm test -- src/tests/theme.contrast.test.ts
```

## Browser Support

- ✅ Modern browsers (Chrome 49+, Firefox 31+, Safari 9.1+, Edge 15+)
- ✅ Mobile browsers (iOS Safari 9.3+, Chrome Mobile)
- ⚠️ IE 11: No CSS variable support (fallback to light theme)

## Migration Guide

### From Hardcoded Colors

**Before:**

```tsx
<div className="bg-white text-slate-800">Content</div>
```

**After:**

```tsx
<div className="bg-[var(--fxi-surface)] text-[var(--fxi-foreground)]">
  Content
</div>
```

### Using useTheme

For components that need to respond to theme changes:

```tsx
const { theme, isHighContrast } = useTheme();

if (isHighContrast) {
  // Use enhanced contrast styles
}
```

## Performance Considerations

- **Instant Switching**: No page reload, CSS variable updates are instant
- **Small Bundle**: ~2KB gzipped (tokens + context + utilities)
- **No CSS-in-JS**: Uses native CSS variables for maximum performance
- **SSR Safe**: Theme script prevents layout shift during hydration

## Troubleshooting

### FOUC Still Appears

1. Ensure `ThemeScript` is in `<head>`, not `<body>`
2. Check browser console for errors
3. Verify localStorage isn't disabled
4. Test with hard refresh (Ctrl+Shift+R)

### Theme Not Persisting

1. Check if localStorage is available: `localStorage.setItem('test', '1')`
2. Verify saved value: `localStorage.getItem('fxi-theme-preference')`
3. Clear and reload: `localStorage.clear()` then hard refresh

### Colors Look Wrong

1. Verify CSS variables are set: `getComputedStyle(document.documentElement).getPropertyValue('--fxi-background')`
2. Check `data-theme` attribute on html: `document.documentElement.getAttribute('data-theme')`
3. Review browser DevTools Computed Styles

## Future Enhancements

- [ ] Custom theme builder UI
- [ ] Per-component theme overrides
- [ ] Theme animation transitions
- [ ] Color blindness simulation tools
- [ ] Automated contrast testing in CI/CD
- [ ] User theme history/suggestions

## References

- [WCAG 2.1 Color Contrast Guidelines](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
- [CSS Custom Properties (MDN)](https://developer.mozilla.org/en-US/docs/Web/CSS/--*)
- [Web Accessibility Testing](https://www.w3.org/WAI/test-evaluate/)
- [axe-core Documentation](https://github.com/dequelabs/axe-core)

## Questions?

Refer to component JSDoc comments or run tests for detailed behavior validation.
