import { test, expect } from "@playwright/test";
import { mockBackend, AUTO_PICK_POOL } from "./fixtures";

test.describe("Squad Builder — auto-pick and submit", () => {
  test("drafts a valid, balanced squad and submits it successfully", async ({ page }) => {
    await mockBackend(page, { squad: [], playerPool: AUTO_PICK_POOL });
    await page.goto("/team");

    await page.getByTestId("auto-pick-button").click();

    // 15 players drafted, within budget, and Save becomes available.
    await expect(page.getByTestId("budget-remaining")).toHaveText("£21.0m");
    await expect(page.getByTestId("budget-over-warning")).toHaveCount(0);
    await expect(page.getByTestId("formation-errors")).toHaveCount(0);
    await expect(page.getByTestId("save-squad-button")).toBeEnabled();

    await page.getByTestId("save-squad-button").click();

    await expect(page.getByTestId("save-success")).toBeVisible();
    await expect(page.getByTestId("save-error")).toHaveCount(0);
  });

  test("fails to submit while the squad is incomplete", async ({ page }) => {
    await mockBackend(page, { squad: [], playerPool: AUTO_PICK_POOL });
    await page.goto("/team");

    // No players picked yet — Save must stay disabled rather than allow a
    // partial/invalid squad to reach the backend.
    await expect(page.getByTestId("save-squad-button")).toBeDisabled();
  });
});
