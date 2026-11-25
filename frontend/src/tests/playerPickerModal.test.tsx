import "./testSupport/jsdomBootstrap";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Position, type Player, type Team } from "../types";
import { PlayerPickerModal } from "../components/team/PlayerPickerModal";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let fetchCalls: string[];

const TEAMS: Team[] = [
  { id: 1, fplId: 1, name: "Arsenal", shortName: "ARS", logoUrl: null },
  { id: 2, fplId: 2, name: "Chelsea", shortName: "CHE", logoUrl: null },
];

function makePlayer(overrides: Partial<Player>): Player {
  return {
    id: 1,
    fplId: 1,
    firstName: "Test",
    lastName: "Player",
    displayName: "Test Player",
    position: Position.DEF,
    teamId: 1,
    price: 60,
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

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

/** Fires a controlled input's onChange the way a real keystroke/drag would. */
function setInputValue(dom: JSDOM, element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

/** Fires a `<select>`'s onChange the way a real option pick would. */
function setSelectValue(dom: JSDOM, element: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  fetchCalls = [];
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("localStorage", { getItem: () => null });
  setGlobal("ResizeObserver", MockResizeObserver);
  setGlobal("fetch", async (url: string) => {
    fetchCalls.push(url);
    if (url.includes("/api/v1/teams")) {
      return { status: 200, ok: true, json: async () => ({ success: true, data: TEAMS }) };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({ success: true, data: [makePlayer({})] }),
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

const BASE_PROPS = {
  isOpen: true,
  onClose: () => {},
  requiredPosition: null,
  currentSquadPlayerIds: [],
  clubCounts: {},
  remainingBudget: 1000,
  replacingPlayer: null,
  onSelectPlayer: () => {},
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playerFetchUrls() {
  return fetchCalls.filter((u) => u.includes("/api/v1/players"));
}

describe("PlayerPickerModal filters (issue #502)", () => {
  it("loads the club list and debounces the initial player fetch", async () => {
    await act(async () => {
      root.render(<PlayerPickerModal {...BASE_PROPS} />);
    });
    // Teams fetch happens immediately; the player fetch is still debouncing.
    assert.ok(fetchCalls.some((u) => u.includes("/api/v1/teams")));
    assert.equal(playerFetchUrls().length, 0);

    await act(async () => {
      await wait(300);
    });
    assert.equal(playerFetchUrls().length, 1);
    assert.ok(container.textContent?.includes("Arsenal"));
  });

  it("coalesces rapid search edits into a single debounced request", async () => {
    await act(async () => {
      root.render(<PlayerPickerModal {...BASE_PROPS} />);
    });
    await act(async () => {
      await wait(300);
    });
    const callsAfterInitialLoad = playerFetchUrls().length;

    const searchInput = container.querySelector('input[placeholder^="Search"]') as HTMLInputElement;

    await act(async () => {
      setInputValue(dom, searchInput, "S");
      await wait(50);
      setInputValue(dom, searchInput, "Sa");
      await wait(50);
      setInputValue(dom, searchInput, "Sal");
    });
    // Still within the 250ms debounce window from the last keystroke.
    assert.equal(playerFetchUrls().length, callsAfterInitialLoad);

    await act(async () => {
      await wait(300);
    });
    const playerFetches = playerFetchUrls();
    assert.equal(playerFetches.length, callsAfterInitialLoad + 1);
    assert.equal(queryOf(playerFetches[playerFetches.length - 1]).get("search"), "Sal");
  });

  it("combines position, club and max-price filters into one request", async () => {
    await act(async () => {
      root.render(<PlayerPickerModal {...BASE_PROPS} />);
    });
    await act(async () => {
      await wait(300);
    });

    const defButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "DEF"
    ) as HTMLButtonElement;
    const clubSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.textContent === "Arsenal")
    ) as HTMLSelectElement;
    const priceSlider = container.querySelector('input[type="range"]') as HTMLInputElement;

    await act(async () => {
      defButton.click();
      setSelectValue(dom, clubSelect, "1");
      setInputValue(dom, priceSlider, "6");
      await wait(300);
    });

    const playerFetches = playerFetchUrls();
    const lastQuery = queryOf(playerFetches[playerFetches.length - 1]);
    assert.equal(lastQuery.get("position"), "DEF");
    assert.equal(lastQuery.get("teamId"), "1");
    assert.equal(lastQuery.get("maxPrice"), "6");
  });

  it("omits maxPrice from the query once the slider is dragged back to its ceiling", async () => {
    await act(async () => {
      root.render(<PlayerPickerModal {...BASE_PROPS} />);
    });
    await act(async () => {
      await wait(300);
    });

    const priceSlider = container.querySelector('input[type="range"]') as HTMLInputElement;

    await act(async () => {
      setInputValue(dom, priceSlider, "6");
      await wait(300);
    });
    assert.equal(queryOf(playerFetchUrls().at(-1)!).get("maxPrice"), "6");

    await act(async () => {
      setInputValue(dom, priceSlider, String(priceSlider.max));
      await wait(300);
    });
    assert.equal(queryOf(playerFetchUrls().at(-1)!).get("maxPrice"), null);
  });

  it("is fully responsive on narrow (mobile) viewports: filters wrap instead of overflowing", async () => {
    await act(async () => {
      root.render(<PlayerPickerModal {...BASE_PROPS} />);
    });
    await act(async () => {
      await wait(300);
    });

    const filterBars = container.querySelectorAll(".flex-wrap");
    assert.ok(filterBars.length >= 2, "position/sort and club/price bars should wrap on narrow screens");
  });
});
