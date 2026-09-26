import { test, expect } from "@playwright/test";
import { mockBackend, balancedSquad, dragCard } from "./fixtures";

test.describe("Squad Builder — drag and drop", () => {
  test("dragging the bench goalkeeper onto the starting goalkeeper swaps them", async ({ page }) => {
    await mockBackend(page, { squad: balancedSquad() });
    await page.goto("/team");

    // Player 1 starts as the starting GK, player 2 as the bench GK.
    await expect(page.locator('[data-testid="pitch"] [data-testid="player-card-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="bench"] [data-testid="player-card-2"]')).toBeVisible();

    await dragCard(page, "player-card-2", "player-card-1");

    // After the drop, they must have swapped roles.
    await expect(page.locator('[data-testid="pitch"] [data-testid="player-card-2"]')).toBeVisible();
    await expect(page.locator('[data-testid="bench"] [data-testid="player-card-1"]')).toBeVisible();

    // A pure GK<->GK swap never changes the formation or its validity.
    await expect(page.getByTestId("formation-errors")).toHaveCount(0);
    await expect(page.getByTestId("save-squad-button")).toBeEnabled();
  });
});
