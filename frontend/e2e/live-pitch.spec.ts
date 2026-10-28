import { test, expect, type Page } from "@playwright/test";

/**
 * Issue #333: canvas live pitch inside the live squad modal.
 * - Visual regression of the still (reduced-motion) pitch on phone, tablet
 *   and desktop viewports, plus a responsive-scaling check.
 * - Cost of a burst of match events: the renderer's main-thread time per
 *   frame (it must fit a 60 Hz frame many times over) and the JS heap.
 *   Frame rate is logged, not asserted: headless software compositing paces
 *   well below 60 Hz and fluctuates by machine load, pitch or no pitch.
 */

const LEAGUE_ID = "lg-live";
const POSITIONS: Array<[number, string, string]> = [
  [1, "GKP", "Raya"], [2, "DEF", "Saliba"], [3, "DEF", "Gabriel"], [4, "DEF", "Van Dijk"], [5, "DEF", "Gvardiol"],
  [6, "MID", "Saka"], [7, "MID", "Palmer"], [8, "MID", "Odegaard"], [9, "MID", "Salah"],
  [10, "FWD", "Haaland"], [11, "FWD", "Isak"], [12, "DEF", "Timber"],
];

function lineup() {
  return POSITIONS.map(([playerId, position, name]) => ({
    playerId,
    name,
    teamShortName: "ARS",
    position,
    isStarter: playerId <= 11,
    isCaptain: playerId === 10,
    isViceCaptain: playerId === 9,
    positionOrder: playerId,
    minutesPlayed: 60,
    rawPoints: playerId === 10 ? 9 : playerId === 9 ? 6 : 2,
    multiplier: playerId === 10 ? 2 : 1,
    effectivePoints: playerId === 10 ? 18 : playerId === 9 ? 6 : 2,
    subbedIn: false,
    subbedOut: false,
  }));
}

function snapshot(goals: number) {
  return {
    leagueId: LEAGUE_ID,
    gameweek: { id: 5, name: "Gameweek 5" },
    fixtures: [],
    events: POSITIONS.slice(0, 11).map(([playerId, , name]) => ({
      playerId,
      playerName: name,
      teamShortName: "ARS",
      goals: playerId >= 9 ? goals : 0,
      assists: playerId >= 6 && playerId <= 8 ? goals : 0,
      yellowCards: playerId === 3 && goals > 0 ? 1 : 0,
      redCards: 0,
      saves: playerId === 1 ? goals : 0,
      bonus: 0,
      totalPoints: 2,
    })),
    standings: [
      {
        rank: 1,
        userId: "user-2",
        username: "rival",
        squadId: "squad-2",
        squadName: "Gegenpress FC",
        membershipStatus: "PAID",
        totalPoints: 120,
        livePoints: 46,
        lineup: lineup(),
      },
    ],
    generatedAt: "2026-10-18T15:00:00.000Z",
  };
}

const sse = (snapshots: object[], retryMs: number) =>
  `retry: ${retryMs}\n\n` + snapshots.map((s) => `event: snapshot\ndata: ${JSON.stringify(s)}\n\n`).join("");

/** Mocks the league page's API; returns a switch that releases a burst of events on the next feed reconnect. */
async function mockLiveLeague(page: Page) {
  const state = { burst: false };
  await page.addInitScript(() => window.localStorage.setItem("token", "e2e-fake-jwt"));
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: [] }) })
  );
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: { id: "user-1", email: "e2e@fantasyxi.test", username: "e2e_manager", createdAt: "2026-01-01T00:00:00Z" },
      }),
    })
  );
  await page.route(`**/api/v1/leagues/${LEAGUE_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          id: LEAGUE_ID,
          name: "Matchday Live League",
          description: null,
          creatorId: "user-2",
          inviteCode: null,
          isPrivate: false,
          maxMembers: 10,
          minMembers: 2,
          currentMembers: 1,
          entryFee: 0,
          prizePool: 0,
          status: "ACTIVE",
          scoringType: "CLASSIC",
          startGameweekId: 1,
          endGameweekId: 38,
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        },
      }),
    })
  );
  await page.route(`**/api/v1/leagues/${LEAGUE_ID}/live`, (route) => {
    const body = state.burst
      ? sse(Array.from({ length: 20 }, (_, i) => snapshot(i + 1)), 600_000)
      : sse([snapshot(0)], 300);
    return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body });
  });
  return state;
}

/** Records how long each requestAnimationFrame callback runs (the renderer's frame work). */
function recordFrameCallbackCost(page: Page) {
  return page.addInitScript(() => {
    const w = window as unknown as { __frameCostMs: number[] };
    w.__frameCostMs = [];
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      request((time) => {
        const start = performance.now();
        callback(time);
        w.__frameCostMs.push(performance.now() - start);
      });
  });
}

/** Frame rate and callback cost over `durationMs`, plus the JS heap (Chromium only). */
async function measureFrames(page: Page, durationMs: number) {
  await page.evaluate(() => ((window as unknown as { __frameCostMs: number[] }).__frameCostMs = []));
  await page.waitForTimeout(durationMs);
  return page.evaluate((duration) => {
    const costs = [...(window as unknown as { __frameCostMs: number[] }).__frameCostMs].sort((a, b) => a - b);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: costs.length / (duration / 1000),
      p95CostMs: costs[Math.floor(costs.length * 0.95)],
      maxCostMs: costs[costs.length - 1],
      heapMb: memory ? memory.usedJSHeapSize / 1024 / 1024 : null,
    };
  }, durationMs);
}

async function openLivePitch(page: Page) {
  await page.goto(`/leagues/${LEAGUE_ID}`);
  await page.getByText("Gegenpress FC").first().click();
  const canvas = page.getByTestId("live-pitch-canvas");
  await expect(canvas).toBeVisible();
  // Let the renderer paint
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return canvas;
}

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

test.describe("Live pitch canvas", () => {
  test.describe("visual regression (reduced motion: still frame)", () => {
    test.use({ reducedMotion: "reduce" });

    for (const viewport of VIEWPORTS) {
      test(`${viewport.name} ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await mockLiveLeague(page);
        const canvas = await openLivePitch(page);

        // Responsive scaling: the backing store tracks the element at the device pixel ratio
        const size = await canvas.evaluate((el: HTMLCanvasElement) => ({
          cssWidth: el.clientWidth,
          cssHeight: el.clientHeight,
          width: el.width,
          dpr: Math.min(window.devicePixelRatio, 2),
        }));
        expect(size.width).toBe(Math.round(size.cssWidth * size.dpr));
        expect(size.cssHeight / size.cssWidth).toBeCloseTo(68 / 105, 2);
        expect(size.cssWidth).toBeLessThanOrEqual(viewport.width);

        await expect(canvas).toHaveScreenshot(`live-pitch-${viewport.name}.png`, { maxDiffPixelRatio: 0.01 });
      });
    }
  });

  test("keeps per-frame work, frame pacing and heap in budget during a burst of match events", async ({ page }) => {
    await recordFrameCallbackCost(page);
    const feed = await mockLiveLeague(page);
    await openLivePitch(page);
    await page.waitForTimeout(1000);
    const idle = await measureFrames(page, 3000);

    // The next feed reconnect delivers 20 snapshots back to back (goals, assists, saves, cards)
    feed.burst = true;
    const burst = await measureFrames(page, 4000);

    console.log(`[live-pitch] idle ${JSON.stringify(idle)} burst ${JSON.stringify(burst)}`);
    // 60 fps leaves 16.7 ms per frame for script, style, raster and compositing
    expect(burst.p95CostMs).toBeLessThanOrEqual(4);
    expect(burst.maxCostMs).toBeLessThan(1000 / 60);
    if (burst.heapMb !== null) expect(burst.heapMb).toBeLessThan(100);
  });
});
