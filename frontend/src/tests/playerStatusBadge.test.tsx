import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PlayerStatusBadge } from "../components/pitch/PlayerStatusBadge";
import { getPlayerAvailabilityBadge } from "../lib/playerStatus";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function render(player: Parameters<typeof PlayerStatusBadge>[0]["player"]) {
  act(() => root.render(<PlayerStatusBadge player={player} />));
  return container.querySelector('[data-testid="player-status-badge"]');
}

const available = { status: "a", chanceOfPlayingNextRound: null, news: null, isAvailable: true };

describe("getPlayerAvailabilityBadge (issue #494)", () => {
  it("returns null for a fully available player", () => {
    assert.equal(getPlayerAvailabilityBadge(available), null);
  });

  it("returns red for chance_of_playing = 0", () => {
    const badge = getPlayerAvailabilityBadge({ ...available, status: "i", chanceOfPlayingNextRound: 0 });
    assert.equal(badge?.color, "red");
    assert.equal(badge?.label, "0%");
  });

  it("returns orange for chance_of_playing = 25", () => {
    const badge = getPlayerAvailabilityBadge({ ...available, status: "d", chanceOfPlayingNextRound: 25 });
    assert.equal(badge?.color, "orange");
    assert.equal(badge?.label, "25%");
  });

  it("returns yellow for chance_of_playing = 50", () => {
    const badge = getPlayerAvailabilityBadge({ ...available, status: "d", chanceOfPlayingNextRound: 50 });
    assert.equal(badge?.color, "yellow");
    assert.equal(badge?.label, "50%");
  });

  it("returns yellow for chance_of_playing = 75", () => {
    const badge = getPlayerAvailabilityBadge({ ...available, status: "d", chanceOfPlayingNextRound: 75 });
    assert.equal(badge?.color, "yellow");
    assert.equal(badge?.label, "75%");
  });

  it("returns null for chance_of_playing = 100", () => {
    const badge = getPlayerAvailabilityBadge({ ...available, status: "a", chanceOfPlayingNextRound: 100 });
    assert.equal(badge, null);
  });

  it("flags a suspended player red even without a percentage", () => {
    const badge = getPlayerAvailabilityBadge({ ...available, status: "s", chanceOfPlayingNextRound: null });
    assert.equal(badge?.color, "red");
    assert.equal(badge?.label, "Suspended");
  });

  it("flags an unavailable (departed) player red", () => {
    const badge = getPlayerAvailabilityBadge({
      ...available,
      status: "u",
      isAvailable: false,
      chanceOfPlayingNextRound: null,
    });
    assert.equal(badge?.color, "red");
  });

  it("uses the player's news as the tooltip when present", () => {
    const badge = getPlayerAvailabilityBadge({
      ...available,
      status: "i",
      chanceOfPlayingNextRound: 25,
      news: "Hamstring injury - expected back 12 Dec",
    });
    assert.equal(badge?.tooltip, "Hamstring injury - expected back 12 Dec");
  });

  it("falls back to a status label tooltip when there is no news", () => {
    const badge = getPlayerAvailabilityBadge({ ...available, status: "s", news: "" });
    assert.equal(badge?.tooltip, "Suspended");
  });
});

describe("PlayerStatusBadge component (issue #494)", () => {
  it("renders nothing for a fully available player", () => {
    assert.equal(render(available), null);
  });

  for (const chance of [0, 25, 50, 75]) {
    it(`renders a visible badge for chance_of_playing = ${chance}`, () => {
      const el = render({ ...available, status: "d", chanceOfPlayingNextRound: chance });
      assert.ok(el, `expected a badge element for chance=${chance}`);
    });
  }

  it("renders no badge for chance_of_playing = 100", () => {
    assert.equal(render({ ...available, chanceOfPlayingNextRound: 100 }), null);
  });

  it("colors the badge red for an injured player with no percentage", () => {
    const el = render({ ...available, status: "i", isAvailable: false, chanceOfPlayingNextRound: null });
    assert.equal(el?.getAttribute("data-color"), "red");
  });

  it("includes the injury news in the badge's tooltip", () => {
    const el = render({
      ...available,
      status: "i",
      chanceOfPlayingNextRound: 25,
      news: "Knee injury - assessed after the weekend",
    });
    assert.equal(el?.getAttribute("title"), "Knee injury - assessed after the weekend");
  });
});
