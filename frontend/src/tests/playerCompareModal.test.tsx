import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Position, type Player } from "../types";
import { PlayerCompareModal } from "../components/players/PlayerCompareModal";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let fetchCalls: string[];

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function makePlayer(overrides: Partial<Player>): Player {
  return {
    id: 1,
    fplId: 1,
    firstName: "Test",
    lastName: "Player",
    displayName: "Test Player",
    position: Position.FWD,
    teamId: 1,
    price: 100,
    totalPoints: 50,
    minutesPlayed: 900,
    goalsScored: 5,
    assists: 2,
    cleanSheets: 0,
    form: 4.5,
    photoUrl: null,
    isAvailable: true,
    ...overrides,
  };
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  fetchCalls = [];
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("localStorage", { getItem: () => null });
  setGlobal("fetch", async (url: string) => {
    fetchCalls.push(url);
    const playerId = Number(url.match(/players\/(\d+)\/analytics/)?.[1]);
    const averageFdr = playerId === 1 ? 2 : 4;
    return {
      status: 200,
      ok: true,
      json: async () => ({ success: true, data: { averageFdr } }),
    };
  });
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("PlayerCompareModal", () => {
  it("highlights the superior stat for each metric", async () => {
    const playerA = makePlayer({ id: 1, displayName: "Player A", price: 80, totalPoints: 100, form: 6 });
    const playerB = makePlayer({ id: 2, displayName: "Player B", price: 120, totalPoints: 60, form: 3 });

    await act(async () => {
      root.render(
        <PlayerCompareModal isOpen={true} onClose={() => {}} playerA={playerA} playerB={playerB} />
      );
    });

    assert.ok(container.querySelector('[role="dialog"]'));

    const pointsA = container.querySelector('[data-testid="cell-Total Points-A"]')!;
    const pointsB = container.querySelector('[data-testid="cell-Total Points-B"]')!;
    assert.match(pointsA.className, /bg-emerald-50/);
    assert.doesNotMatch(pointsB.className, /bg-emerald-50/);

    // Lower price is the better (cheaper) stat — playerA wins.
    const priceA = container.querySelector('[data-testid="cell-Price-A"]')!;
    const priceB = container.querySelector('[data-testid="cell-Price-B"]')!;
    assert.match(priceA.className, /bg-emerald-50/);
    assert.doesNotMatch(priceB.className, /bg-emerald-50/);

    // Fixture difficulty resolves asynchronously; lower FDR (playerA=2) wins.
    const fdrA = container.querySelector('[data-testid="cell-Fixture Difficulty-A"]')!;
    const fdrB = container.querySelector('[data-testid="cell-Fixture Difficulty-B"]')!;
    assert.match(fdrA.className, /bg-emerald-50/);
    assert.doesNotMatch(fdrB.className, /bg-emerald-50/);
    assert.equal(fetchCalls.length, 2);
  });

  it("renders nothing when closed", () => {
    const playerA = makePlayer({ id: 1 });
    const playerB = makePlayer({ id: 2 });

    act(() => {
      root.render(
        <PlayerCompareModal isOpen={false} onClose={() => {}} playerA={playerA} playerB={playerB} />
      );
    });

    assert.equal(container.querySelector('[role="dialog"]'), null);
  });
});
