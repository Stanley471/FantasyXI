/**
 * ThemeScript Component
 *
 * This script runs before React hydration to prevent FOUC
 * It must be inlined in the HTML head to execute immediately
 *
 * This component generates the script tag that will be rendered
 * in the root layout
 */

const STORAGE_KEY = "fxi-theme-preference";
const ATTRIBUTE_NAME = "data-theme";

/**
 * Generate the inline script that prevents FOUC
 * This runs synchronously before React hydration
 */
export function ThemeScript() {
  const script = `
(function() {
  try {
    const STORAGE_KEY = "${STORAGE_KEY}";
    const ATTRIBUTE_NAME = "${ATTRIBUTE_NAME}";

    // Get saved preference or system preference
    let theme = localStorage.getItem(STORAGE_KEY);
    
    if (!theme || !["light", "dark", "high-contrast"].includes(theme)) {
      // Check system preference
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        theme = "dark";
      } else {
        theme = "light";
      }
    }

    // Apply theme immediately before React hydrates
    document.documentElement.setAttribute(ATTRIBUTE_NAME, theme);
  } catch (e) {
    // Silently fail - theme will be applied by React
    console.error("Theme initialization error:", e);
  }
})();
  `;

  return (
    <script
      dangerouslySetInnerHTML={{ __html: script }}
      suppressHydrationWarning
    />
  );
}
