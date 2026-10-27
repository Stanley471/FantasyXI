import { test, expect } from "@playwright/test";

/**
 * Issue #331: a correct password from an unrecognized device is answered with
 * a step-up challenge; the emailed code completes the sign-in. Backend mocked.
 */

const USER = { id: "user-1", email: "e2e@fantasyxi.test", username: "e2e_manager", createdAt: "2026-01-01T00:00:00Z" };

test.describe("Login step-up challenge", () => {
  test("sends a device fingerprint, asks for the emailed code, then signs in", async ({ page }) => {
    let loginBody: { deviceFingerprint?: string } = {};
    let verifyBody: { challengeId?: string; code?: string } = {};
    await page.route("**/api/v1/auth/login", async (route) => {
      loginBody = route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { challengeRequired: true, challengeId: "ch-1", method: "EMAIL_OTP", expiresAt: "2026-10-20T12:00:00Z" },
        }),
      });
    });
    await page.route("**/api/v1/auth/login/verify", async (route) => {
      verifyBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { token: "e2e-verified-jwt", user: USER } }),
      });
    });
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: USER }) })
    );

    await page.goto("/login");
    await page.fill("#email", USER.email);
    await page.fill("#password", "correct-horse-battery");
    await page.getByRole("button", { name: /sign in to dugout/i }).click();

    await expect(page.getByTestId("login-challenge")).toContainText(USER.email);
    expect(loginBody.deviceFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // A pasted, formatted code keeps all six digits
    await page.fill("#code", "123 456");
    await expect(page.locator("#code")).toHaveValue("123456");
    await page.getByRole("button", { name: /verify & sign in/i }).click();

    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    expect(verifyBody).toEqual({ challengeId: "ch-1", code: "123456" });
    expect(await page.evaluate(() => localStorage.getItem("token"))).toBe("e2e-verified-jwt");
  });

  test("shows the reason when the sign-in is blocked for impossible travel", async ({ page }) => {
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          message: "This sign-in was blocked because it came from an implausibly distant location. Check your email for details.",
        }),
      })
    );
    await page.goto("/login");
    await page.fill("#email", USER.email);
    await page.fill("#password", "correct-horse-battery");
    await page.getByRole("button", { name: /sign in to dugout/i }).click();
    await expect(page.getByText(/implausibly distant location/)).toBeVisible();
    await expect(page.getByTestId("login-challenge")).toHaveCount(0);
  });
});
