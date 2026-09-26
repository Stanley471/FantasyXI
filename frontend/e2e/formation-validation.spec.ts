import { test, expect } from "@playwright/test";
import { mockBackend, boundaryFormationSquad, invalidFormationSquad, dragCard } from "./fixtures";

test.describe("Squad Builder — formation validation", () => {
  test("blocks a drag that would drop below the minimum defenders (2-5-3)", async ({ page }) => {
    await mockBackend(page, { squad: boundaryFormationSquad() });
    await page.goto("/team");

    // Starts as a legal 3-4-3.
    await expect(page.getByTestId("pitch").getByText("3-4-3")).toBeVisible();

    let dialogMessage = "";
    page.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });

    // Player 4 is a starting defender; player 12 is the spare bench midfielder.
    // Dragging one onto the other would drop starting defenders to 2 — invalid.
    await dragCard(page, "player-card-4", "player-card-12");

    await expect.poll(() => dialogMessage).toContain("Invalid Formation");
    expect(dialogMessage).toContain("2-5-3");

    // The blocked swap must leave the squad exactly as it was.
    await expect(page.getByTestId("pitch").getByText("3-4-3")).toBeVisible();
    await expect(page.getByTestId("formation-errors")).toHaveCount(0);
    await expect(page.getByTestId("save-squad-button")).toBeEnabled();
  });

  test("allows a drag that keeps the formation within FPL limits", async ({ page }) => {
    await mockBackend(page, { squad: boundaryFormationSquad() });
    await page.goto("/team");

    await expect(page.getByTestId("pitch").getByText("3-4-3")).toBeVisible();

    // Player 6 is a spare bench defender; player 8 is a starting midfielder.
    // Swapping them yields 4 defenders / 3 midfielders — still legal.
    await dragCard(page, "player-card-6", "player-card-8");

    await expect(page.getByTestId("pitch").getByText("4-3-3")).toBeVisible();
    await expect(page.getByTestId("formation-errors")).toHaveCount(0);
    await expect(page.getByTestId("save-squad-button")).toBeEnabled();
  });

  test("rejects submitting a squad that is already in an invalid 2-5-3 formation", async ({ page }) => {
    await mockBackend(page, { squad: invalidFormationSquad() });
    await page.goto("/team");

    await expect(page.getByTestId("formation-errors")).toBeVisible();
    await expect(page.getByTestId("formation-errors")).toContainText("between 3 and 5 starting Defenders");
    await expect(page.getByTestId("save-squad-button")).toBeDisabled();
  });
});
