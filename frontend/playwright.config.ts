import { defineConfig, devices } from "@playwright/test";

/**
 * E2E suite for the Gameweek Squad Selection flow (drag & drop, budget and
 * formation validation). All backend calls are intercepted with `page.route`
 * fixtures (see e2e/fixtures) so these tests run against a real browser and
 * real client-side logic without needing a live API server or database.
 */
export default defineConfig({
  testDir: "./e2e",
  // A single dev-mode Next.js server compiles pages on demand; running specs
  // in parallel makes concurrent first-hits to /team fight over that compile
  // and blow past the navigation timeout. One worker keeps runs deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    navigationTimeout: 45_000,
    // Tall enough that the pitch and bench are both on-screen without
    // scrolling, which matters for the drag-and-drop tests below.
    viewport: { width: 1280, height: 1800 },
  },
  projects: [
    {
      name: "chromium",
      // `devices["Desktop Chrome"]` carries its own 1280x720 viewport, which
      // would silently override the taller one above if spread after it.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 1800 } },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
