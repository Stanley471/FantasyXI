import { expect, test } from "@playwright/test";
import { ed25519 } from "@noble/curves/ed25519.js";

const user = {
  id: "user-recovery",
  email: "manager@example.test",
  username: "manager",
  name: "Recovery Manager",
  role: "USER",
  createdAt: new Date(0).toISOString(),
  authProviders: { password: false, google: false },
};

test("registered passkey can be replaced after mnemonic recovery", async ({ page }) => {
  let recoveryPublicKey = "";
  const challenge = Buffer.alloc(32, 23).toString("base64url");

  await page.route("http://localhost:5000/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/me")) {
      await route.fulfill({ json: { success: true, data: user } });
    } else if (path.endsWith("/auth/webauthn/credentials")) {
      await route.fulfill({ json: { success: true, data: [{
        id: "credential-phone",
        name: "Phone passkey",
        deviceType: "multiDevice",
        backedUp: true,
        transports: ["internal"],
        createdAt: new Date(0).toISOString(),
        lastUsedAt: null,
      }] } });
    } else if (path.endsWith("/auth/webauthn/recovery/configure")) {
      recoveryPublicKey = request.postDataJSON().publicKey;
      await route.fulfill({ status: 201, json: { success: true, data: { configuredAt: new Date().toISOString() } } });
    } else if (path.endsWith("/auth/webauthn/recovery/begin")) {
      await route.fulfill({ json: { success: true, data: { challengeId: "challenge-1", challenge, expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
    } else if (path.endsWith("/auth/webauthn/recovery/complete")) {
      const body = request.postDataJSON();
      const valid = ed25519.verify(
        Buffer.from(body.signature, "base64url"),
        Buffer.from(challenge, "base64url"),
        Buffer.from(recoveryPublicKey, "base64url")
      );
      await route.fulfill({
        status: valid ? 200 : 401,
        json: valid
          ? { success: true, data: { token: "recovered-token", user, requiresPasskeyRegistration: true } }
          : { success: false, message: "Invalid proof" },
      });
    } else if (path.endsWith("/auth/sessions")) {
      await route.fulfill({
        json: { success: true, data: { currentSessionId: null, sessions: [] } },
      });
    } else {
      await route.fulfill({ json: { success: true, data: [] } });
    }
  });

  await page.addInitScript(() => localStorage.setItem("token", "registered-device-token"));
  await page.goto("/profile");
  await expect(page.getByText("Phone passkey")).toBeVisible();
  await page.getByRole("button", { name: "Create recovery phrase" }).click();
  const phrase = (await page.locator(".select-all.font-mono").textContent())?.trim() ?? "";
  expect(phrase.split(" ")).toHaveLength(12);
  expect(recoveryPublicKey).not.toBe("");

  await page.evaluate(() => localStorage.clear());
  await page.goto("/recover-passkey");
  await page.getByLabel("Account email").fill(user.email);
  await page.getByLabel("12-word recovery phrase").fill(phrase);
  await page.getByRole("button", { name: "Recover account" }).click();
  await expect(page).toHaveURL(/\/profile\?recovered=passkey/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("token"))).toBe("recovered-token");
});
