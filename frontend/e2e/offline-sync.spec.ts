import { test, expect, type Page } from "@playwright/test";
import { mockBackend, balancedSquad, dragCard } from "./fixtures";

/**
 * Issue #334: lineup edits made offline are persisted in IndexedDB, survive a
 * reload, replay on reconnection, and roll back with a toast when the server
 * rejects them (deadline expired).
 */

const onPitch = (page: Page, id: number) => page.locator(`[data-testid="pitch"] [data-testid="player-card-${id}"]`);
const onBench = (page: Page, id: number) => page.locator(`[data-testid="bench"] [data-testid="player-card-${id}"]`);

/** Captures squad saves; registered after mockBackend so it takes precedence. */
async function captureSquadSaves(page: Page, respond: { status: number; body: object }) {
  const saves: Array<{ players: Array<{ playerId: number; isStarter: boolean }> }> = [];
  await page.route("**/api/v1/squads/squad-1", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves.push(route.request().postDataJSON());
    await route.fulfill({ status: respond.status, contentType: "application/json", body: JSON.stringify(respond.body) });
  });
  return saves;
}

async function swapGoalkeepersOffline(page: Page) {
  await expect(onPitch(page, 1)).toBeVisible();
  await page.context().setOffline(true);
  await dragCard(page, "player-card-2", "player-card-1");
  await expect(onPitch(page, 2)).toBeVisible();
  await expect(page.getByTestId("offline-sync-banner")).toContainText("1 change queued");
}

test.describe("Offline lineup sync", () => {
  test("an offline swap survives a reload on a flaky network and syncs once the API is reachable", async ({ page }) => {
    await mockBackend(page, { squad: balancedSquad() });
    const saves = await captureSquadSaves(page, { status: 200, body: { success: true, data: { id: "squad-1" } } });
    await page.goto("/team");

    await swapGoalkeepersOffline(page);

    // Back "online", but the squad API is unreachable: the reload must show the
    // queued lineup from this device rather than lose it
    const dropSquadApi = (route: import("@playwright/test").Route) => route.abort("internetdisconnected");
    await page.route("**/api/v1/squads**", dropSquadApi);
    await page.context().setOffline(false);
    await page.reload();

    await expect(onPitch(page, 2)).toBeVisible();
    await expect(onBench(page, 1)).toBeVisible();
    await expect(page.getByTestId("offline-sync-banner")).toContainText("1 change queued");
    expect(saves).toHaveLength(0);

    // API reachable again: the coordinator replays the queue on the next online signal
    await page.unroute("**/api/v1/squads**", dropSquadApi);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByText("Synced 1 offline squad change.")).toBeVisible();
    await expect(page.getByTestId("offline-sync-banner")).toHaveCount(0);
    expect(saves).toHaveLength(1);
    const keepers = saves[0].players.filter((p) => p.playerId === 1 || p.playerId === 2);
    expect(keepers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: 2, isStarter: true }),
        expect.objectContaining({ playerId: 1, isStarter: false }),
      ])
    );
  });

  test("a change rejected because the deadline passed is rolled back with an explanation", async ({ page }) => {
    await mockBackend(page, { squad: balancedSquad() });
    const saves = await captureSquadSaves(page, {
      status: 403,
      body: { success: false, message: "Gameweek 5 deadline has passed", deadline: "2026-10-18T17:30:00.000Z" },
    });
    await page.goto("/team");

    await swapGoalkeepersOffline(page);
    await page.context().setOffline(false);

    await expect(page.getByText(/deadline passed before your offline lineup change could sync/i)).toBeVisible();
    expect(saves).toHaveLength(1);
    // Server state wins: the original goalkeeper is back between the posts
    await expect(onPitch(page, 1)).toBeVisible();
    await expect(onBench(page, 2)).toBeVisible();
    await expect(page.getByTestId("offline-sync-banner")).toHaveCount(0);
  });

  test("two tabs reconnecting at the same moment replay a queued change exactly once", async ({ context }) => {
    const pages = [await context.newPage(), await context.newPage()];
    let saves = 0;
    for (const page of pages) {
      await mockBackend(page, { squad: balancedSquad() });
      await page.route("**/api/v1/squads/squad-1", async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        saves++;
        // A slow API keeps the first flush in flight while the other tab tries
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
      });
      await page.goto("/team");
      await expect(onPitch(page, 1)).toBeVisible();
    }

    await swapGoalkeepersOffline(pages[0]);
    await context.setOffline(false);
    // Both tabs notice the connection at the same moment; the Web Lock lets only one replay
    await Promise.all(pages.map((page) => page.evaluate(() => window.dispatchEvent(new Event("online")))));

    await expect(pages[0].getByTestId("offline-sync-banner")).toHaveCount(0);
    await pages[0].waitForTimeout(1500);
    expect(saves).toBe(1);
  });
});
