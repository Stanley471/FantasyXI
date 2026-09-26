import { test, expect } from "@playwright/test";
import { mockBackend, balancedSquad, overBudgetSquad, makePlayer } from "./fixtures";

test.describe("Squad Builder — budget validation", () => {
  test("disables save and warns when the loaded squad exceeds the £100m cap", async ({ page }) => {
    await mockBackend(page, { squad: overBudgetSquad() });
    await page.goto("/team");

    await expect(page.getByTestId("budget-over-warning")).toBeVisible();
    await expect(page.getByTestId("budget-over-warning")).toContainText("exceeded the £100.0m limit");
    await expect(page.getByTestId("save-squad-button")).toBeDisabled();
  });

  test("cannot pick a replacement player that would exceed the remaining budget", async ({ page }) => {
    const expensiveReplacement = makePlayer({
      id: 999,
      position: "DEF",
      teamId: 999,
      displayName: "PriceyDefender",
      price: 300, // £30.0m — far more than the ~£21.0m remaining after the balanced squad
    });

    await mockBackend(page, {
      squad: balancedSquad(),
      playerPool: [expensiveReplacement],
    });
    await page.goto("/team");

    await expect(page.getByTestId("budget-remaining")).toHaveText("£21.0m");

    // Open the transfer picker for a starting defender.
    await page.getByTestId("player-card-3").click();
    await page.getByTestId("transfer-out-button").click();
    await expect(page.getByTestId("player-picker-modal")).toBeVisible();

    const row = page.getByTestId("picker-row-999");
    await expect(row).toContainText("Over Budget");
    await expect(page.getByTestId("pick-player-999")).toBeDisabled();
  });
});
