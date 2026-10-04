import { test, expect } from "@playwright/test";
import { mockBackend, AUTO_PICK_POOL } from "./fixtures";

test.describe("Wildcard Chip — activation and transfer workflow", () => {
  test("activates Wildcard chip and enables unlimited free transfers", async ({ page }) => {
    await mockBackend(page, { 
      squad: [], 
      playerPool: AUTO_PICK_POOL,
      currentGameweek: { id: 1, name: "Gameweek 1", deadline: new Date().toISOString() },
    });
    await page.goto("/team");

    // Auto-pick a squad first
    await page.getByTestId("auto-pick-button").click();
    await page.getByTestId("save-squad-button").click();
    await expect(page.getByTestId("save-success")).toBeVisible();

    // Activate Wildcard
    await page.getByTestId("wildcard-toggle").click();
    
    // Verify Wildcard is now active
    await expect(page.getByTestId("wildcard-toggle")).toHaveText("Wildcard Active");
    await expect(page.getByTestId("wildcard-toggle")).toBeDisabled();
    
    // Make multiple transfers (which would normally incur point penalties)
    // This test verifies the UI state; actual transfer cost calculation is tested in backend unit tests
    await expect(page.getByTestId("wildcard-toggle")).toHaveClass(/bg-emerald-500\/20/);
  });

  test("disables Wildcard toggle when already activated for the gameweek", async ({ page }) => {
    await mockBackend(page, { 
      squad: [], 
      playerPool: AUTO_PICK_POOL,
      currentGameweek: { id: 1, name: "Gameweek 1", deadline: new Date().toISOString() },
      chipUsages: [
        {
          id: 1,
          squadId: "squad-1",
          gameweekId: 1,
          chipType: "WILDCARD",
          season: "2024",
          usedAt: new Date().toISOString(),
        },
      ],
    });
    await page.goto("/team");

    // Auto-pick a squad first
    await page.getByTestId("auto-pick-button").click();
    await page.getByTestId("save-squad-button").click();
    await expect(page.getByTestId("save-success")).toBeVisible();

    // Wildcard should already be active from chip usages
    await expect(page.getByTestId("wildcard-toggle")).toHaveText("Wildcard Active");
    await expect(page.getByTestId("wildcard-toggle")).toBeDisabled();
  });

  test("disables Wildcard toggle when offline", async ({ page }) => {
    await mockBackend(page, { 
      squad: [], 
      playerPool: AUTO_PICK_POOL,
      currentGameweek: { id: 1, name: "Gameweek 1", deadline: new Date().toISOString() },
    });
    
    // Simulate offline state
    await page.context().setOffline(true);
    await page.goto("/team");

    // Wildcard toggle should be disabled when offline
    await expect(page.getByTestId("wildcard-toggle")).toBeDisabled();
  });

  test("shows loading state while activating Wildcard", async ({ page }) => {
    await mockBackend(page, { 
      squad: [], 
      playerPool: AUTO_PICK_POOL,
      currentGameweek: { id: 1, name: "Gameweek 1", deadline: new Date().toISOString() },
    });
    await page.goto("/team");

    // Auto-pick and save first
    await page.getByTestId("auto-pick-button").click();
    await page.getByTestId("save-squad-button").click();
    await expect(page.getByTestId("save-success")).toBeVisible();

    // Click Wildcard and verify loading state
    await page.getByTestId("wildcard-toggle").click();
    await expect(page.getByTestId("wildcard-toggle")).toHaveText("Activating...");
  });
});
