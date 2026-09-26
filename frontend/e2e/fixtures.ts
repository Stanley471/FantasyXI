import type { Page } from "@playwright/test";

/**
 * Drags `sourceTestId` onto `targetTestId` using real mouse events, clearing
 * dnd-kit's MouseSensor activation distance (10px) so the interaction is
 * recognized as a drag rather than a click (a click on a player card opens
 * the action modal instead of swapping).
 */
export async function dragCard(page: Page, sourceTestId: string, targetTestId: string): Promise<void> {
  const source = page.getByTestId(sourceTestId);
  const target = page.getByTestId(targetTestId);

  // Both cards must actually be inside the viewport, or the coordinates below
  // land outside the browser's visible area and the synthetic mouse events
  // are dropped on the floor.
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Could not measure drag source/target");

  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // dnd-kit's MouseSensor only arms after the pointer clears its activation
  // distance (10px) *and* has a chance to process the intermediate moves, so
  // step gradually with small pauses rather than jumping straight to the target.
  await page.mouse.move(start.x + 15, start.y, { steps: 5 });
  await page.waitForTimeout(50);
  await page.mouse.move(start.x + 15, start.y + 15, { steps: 5 });
  await page.waitForTimeout(50);
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * i) / steps,
      start.y + ((end.y - start.y) * i) / steps
    );
  }
  await page.waitForTimeout(100);
  await page.mouse.up();
}

/**
 * Fixture helpers for the Squad Selection E2E suite.
 *
 * These tests exercise real client-side drag-and-drop, budget and formation
 * logic in a real browser, but never hit the real Express/Prisma backend —
 * every `/api/v1/*` call is intercepted and served from fixture data here.
 * (Per the issue scope: backend API E2E tests are out of scope; frontend E2E
 * tests should mock backend responses. Authentication itself is also out of
 * scope, so we seed a fake session token directly.)
 */

export interface FixturePlayer {
  id: number;
  fplId: number;
  firstName: string;
  lastName: string;
  displayName: string;
  position: "GKP" | "DEF" | "MID" | "FWD";
  teamId: number;
  team: { id: number; shortName: string; name: string };
  price: number; // tenths of a million, e.g. 55 = £5.5m
  totalPoints: number;
  minutesPlayed: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  form: number;
  status: string | null;
  news: string | null;
  chanceOfPlayingNextRound: number | null;
  selectedByPercent: number | null;
  photoUrl: string | null;
}

export function makePlayer(
  overrides: Partial<FixturePlayer> & {
    id: number;
    position: FixturePlayer["position"];
    teamId: number;
  }
): FixturePlayer {
  return {
    fplId: overrides.id,
    firstName: `First${overrides.id}`,
    lastName: `Last${overrides.id}`,
    displayName: `Player${overrides.id}`,
    price: 50,
    totalPoints: 200 - overrides.id,
    minutesPlayed: 900,
    goalsScored: 1,
    assists: 1,
    cleanSheets: 0,
    form: 5,
    status: "a",
    news: null,
    chanceOfPlayingNextRound: 100,
    selectedByPercent: 10,
    photoUrl: null,
    team: { id: overrides.teamId, shortName: `T${overrides.teamId}`, name: `Team ${overrides.teamId}` },
    ...overrides,
  };
}

export interface FixtureSquadPlayer {
  id: number;
  squadId: string;
  playerId: number;
  player: FixturePlayer;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isStarter: boolean;
  positionOrder: number;
  purchasePrice: number;
}

export function makeSquadPlayer(
  player: FixturePlayer,
  opts: { isStarter: boolean; positionOrder: number; isCaptain?: boolean; isViceCaptain?: boolean }
): FixtureSquadPlayer {
  return {
    id: player.id,
    squadId: "squad-1",
    playerId: player.id,
    player,
    isCaptain: opts.isCaptain ?? false,
    isViceCaptain: opts.isViceCaptain ?? false,
    isStarter: opts.isStarter,
    positionOrder: opts.positionOrder,
    purchasePrice: player.price,
  };
}

/** A balanced, budget-legal 15-man pool for the auto-pick happy path (2/5/5/3, total £79.0m). */
export const AUTO_PICK_POOL: FixturePlayer[] = [
  makePlayer({ id: 1, position: "GKP", teamId: 1, price: 40 }),
  makePlayer({ id: 2, position: "GKP", teamId: 2, price: 40 }),
  makePlayer({ id: 3, position: "DEF", teamId: 3, price: 45 }),
  makePlayer({ id: 4, position: "DEF", teamId: 4, price: 45 }),
  makePlayer({ id: 5, position: "DEF", teamId: 5, price: 45 }),
  makePlayer({ id: 6, position: "DEF", teamId: 6, price: 45 }),
  makePlayer({ id: 7, position: "DEF", teamId: 7, price: 45 }),
  makePlayer({ id: 8, position: "MID", teamId: 8, price: 55 }),
  makePlayer({ id: 9, position: "MID", teamId: 9, price: 55 }),
  makePlayer({ id: 10, position: "MID", teamId: 10, price: 55 }),
  makePlayer({ id: 11, position: "MID", teamId: 11, price: 55 }),
  makePlayer({ id: 12, position: "MID", teamId: 12, price: 55 }),
  makePlayer({ id: 13, position: "FWD", teamId: 13, price: 70 }),
  makePlayer({ id: 14, position: "FWD", teamId: 14, price: 70 }),
  makePlayer({ id: 15, position: "FWD", teamId: 15, price: 70 }),
];

/** The same pool assembled into a saved 4-4-2 squad (1 GKP/4 DEF/4 MID/2 FWD starters). */
export function balancedSquad(): FixtureSquadPlayer[] {
  const [gk1, gk2, d1, d2, d3, d4, d5, m1, m2, m3, m4, m5, f1, f2, f3] = AUTO_PICK_POOL;
  return [
    makeSquadPlayer(gk1, { isStarter: true, positionOrder: 1 }),
    makeSquadPlayer(d1, { isStarter: true, positionOrder: 2 }),
    makeSquadPlayer(d2, { isStarter: true, positionOrder: 3 }),
    makeSquadPlayer(d3, { isStarter: true, positionOrder: 4 }),
    makeSquadPlayer(d4, { isStarter: true, positionOrder: 5 }),
    makeSquadPlayer(m1, { isStarter: true, positionOrder: 6, isCaptain: true }),
    makeSquadPlayer(m2, { isStarter: true, positionOrder: 7 }),
    makeSquadPlayer(m3, { isStarter: true, positionOrder: 8 }),
    makeSquadPlayer(m4, { isStarter: true, positionOrder: 9 }),
    makeSquadPlayer(f1, { isStarter: true, positionOrder: 10, isViceCaptain: true }),
    makeSquadPlayer(f2, { isStarter: true, positionOrder: 11 }),
    makeSquadPlayer(gk2, { isStarter: false, positionOrder: 12 }),
    makeSquadPlayer(d5, { isStarter: false, positionOrder: 13 }),
    makeSquadPlayer(m5, { isStarter: false, positionOrder: 14 }),
    makeSquadPlayer(f3, { isStarter: false, positionOrder: 15 }),
  ];
}

/**
 * A legal 3-4-3 squad with two spare defenders and one spare midfielder on the
 * bench. Swapping bench DEF -> starting MID keeps it legal (4-3-3); swapping a
 * starting DEF -> bench MID drops defenders to 2 and must be rejected (2-5-3).
 */
export function boundaryFormationSquad(): FixtureSquadPlayer[] {
  const [gk1, gk2, d1, d2, d3, d4, d5, m1, m2, m3, m4, m5, f1, f2, f3] = AUTO_PICK_POOL;
  return [
    makeSquadPlayer(gk1, { isStarter: true, positionOrder: 1 }),
    makeSquadPlayer(d1, { isStarter: true, positionOrder: 2 }),
    makeSquadPlayer(d2, { isStarter: true, positionOrder: 3 }),
    makeSquadPlayer(d3, { isStarter: true, positionOrder: 4 }),
    makeSquadPlayer(m1, { isStarter: true, positionOrder: 5, isCaptain: true }),
    makeSquadPlayer(m2, { isStarter: true, positionOrder: 6 }),
    makeSquadPlayer(m3, { isStarter: true, positionOrder: 7 }),
    makeSquadPlayer(m4, { isStarter: true, positionOrder: 8 }),
    makeSquadPlayer(f1, { isStarter: true, positionOrder: 9, isViceCaptain: true }),
    makeSquadPlayer(f2, { isStarter: true, positionOrder: 10 }),
    makeSquadPlayer(f3, { isStarter: true, positionOrder: 11 }),
    makeSquadPlayer(gk2, { isStarter: false, positionOrder: 12 }),
    makeSquadPlayer(d4, { isStarter: false, positionOrder: 13 }),
    makeSquadPlayer(d5, { isStarter: false, positionOrder: 14 }),
    makeSquadPlayer(m5, { isStarter: false, positionOrder: 15 }),
  ];
}

/** Already-invalid 2-5-3 formation (2 starting defenders, below the 3 minimum). */
export function invalidFormationSquad(): FixtureSquadPlayer[] {
  const [gk1, gk2, d1, d2, d3, d4, d5, m1, m2, m3, m4, m5, f1, f2, f3] = AUTO_PICK_POOL;
  return [
    makeSquadPlayer(gk1, { isStarter: true, positionOrder: 1 }),
    makeSquadPlayer(d1, { isStarter: true, positionOrder: 2 }),
    makeSquadPlayer(d2, { isStarter: true, positionOrder: 3 }),
    makeSquadPlayer(m1, { isStarter: true, positionOrder: 4, isCaptain: true }),
    makeSquadPlayer(m2, { isStarter: true, positionOrder: 5 }),
    makeSquadPlayer(m3, { isStarter: true, positionOrder: 6 }),
    makeSquadPlayer(m4, { isStarter: true, positionOrder: 7 }),
    makeSquadPlayer(m5, { isStarter: true, positionOrder: 8 }),
    makeSquadPlayer(f1, { isStarter: true, positionOrder: 9, isViceCaptain: true }),
    makeSquadPlayer(f2, { isStarter: true, positionOrder: 10 }),
    makeSquadPlayer(f3, { isStarter: true, positionOrder: 11 }),
    makeSquadPlayer(gk2, { isStarter: false, positionOrder: 12 }),
    makeSquadPlayer(d3, { isStarter: false, positionOrder: 13 }),
    makeSquadPlayer(d4, { isStarter: false, positionOrder: 14 }),
    makeSquadPlayer(d5, { isStarter: false, positionOrder: 15 }),
  ];
}

/** A valid-formation squad priced at £150.0m — over the £100m cap. */
export function overBudgetSquad(): FixtureSquadPlayer[] {
  return balancedSquad().map((sp) => ({
    ...sp,
    player: { ...sp.player, price: 100 },
    purchasePrice: 100,
  }));
}

export interface MockBackendOptions {
  /** Squad returned by GET /api/v1/squads/me. Undefined/[] means "no squad yet". */
  squad?: FixtureSquadPlayer[];
  /** Player pool returned by GET /api/v1/players (auto-pick and the picker modal both use it). */
  playerPool?: FixturePlayer[];
}

/**
 * Seeds a fake auth session and stubs every backend endpoint the Team Builder
 * page touches. Call before `page.goto("/team")`.
 */
export async function mockBackend(page: Page, options: MockBackendOptions = {}): Promise<void> {
  const { squad = [], playerPool = AUTO_PICK_POOL } = options;

  await page.addInitScript(() => {
    window.localStorage.setItem("token", "e2e-fake-jwt");
  });

  await page.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          id: "user-1",
          email: "e2e@fantasyxi.test",
          username: "e2e_manager",
          name: "E2E Manager",
          createdAt: new Date().toISOString(),
        },
      }),
    });
  });

  await page.route("**/api/v1/squads/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data:
          squad.length > 0
            ? [
                {
                  id: "squad-1",
                  userId: "user-1",
                  name: "My Fantasy XI",
                  budgetRemaining: 1000,
                  totalPoints: 0,
                  players: squad,
                  createdAt: new Date().toISOString(),
                },
              ]
            : [],
      }),
    });
  });

  await page.route("**/api/v1/players**", async (route) => {
    const url = new URL(route.request().url());
    const position = url.searchParams.get("position");
    const filtered = position ? playerPool.filter((p) => p.position === position) : playerPool;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: filtered }),
    });
  });

  await page.route("**/api/v1/squads", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: { id: "squad-1", userId: "user-1", name: "My Fantasy XI", budgetRemaining: 210, totalPoints: 0, createdAt: new Date().toISOString() },
      }),
    });
  });

  await page.route("**/api/v1/squads/squad-1", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { id: "squad-1" } }),
    });
  });
}
